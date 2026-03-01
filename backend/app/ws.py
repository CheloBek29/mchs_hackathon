from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from .auth import get_auth_context_from_access_token, normalize_role_name
from .database import SessionLocal
from . import physics_config as PhysicsCfg
from .enums import (
    DeploymentStatus,
    FireZoneKind,
    GeometryType,
    ResourceKind,
    SessionStatus,
    TimeOfDay,
    UserRole,
    WaterSupplyStatus,
)
from .models import (
    FireObject,
    RadioTransmission,
    ResourceDeployment,
    Session as AuthSession,
    SessionStateSnapshot,
    SimulationSession,
    User,
    VehicleDictionary,
    WeatherSnapshot,
)
from .schemas import (
    SessionStateBundleRead,
    SessionStateSnapshotRead,
)
from .security.rbac import assert_session_scope, canonical_user_roles, has_permission
from .services.address_scene_service import build_training_scene_from_address

ws_router = APIRouter()

WS_COMMAND_PERMISSIONS: dict[str, str] = {
    "update_weather": "state:write",
    "create_fire_object": "state:write",
    "create_resource_deployment": "state:write",
    "update_snapshot": "state:write",
    "push_radio_message": "state:write",
    "set_radio_interference": "admin:manage",
    "set_scene_address": "scene:write",
    "upsert_scene_floor": "scene:write",
    "set_active_scene_floor": "scene:write",
    "upsert_scene_object": "scene:write",
    "remove_scene_object": "scene:write",
    "sync_scene_to_fire_objects": "scene:write",
    "save_scene_checkpoint": "scene:write",
    "start_lesson": "scene:write",
    "pause_lesson": "scene:write",
    "resume_lesson": "scene:write",
    "finish_lesson": "scene:write",
}

WS_COMMAND_ALLOWED_ROLES: dict[str, frozenset[UserRole]] = {
    "update_weather": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "create_fire_object": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "create_resource_deployment": frozenset(
        {
            UserRole.ADMIN,
            UserRole.TRAINING_LEAD,
            UserRole.DISPATCHER,
            UserRole.RTP,
            UserRole.HQ,
            UserRole.COMBAT_AREA_1,
            UserRole.COMBAT_AREA_2,
        }
    ),
    "update_snapshot": frozenset(
        {UserRole.ADMIN, UserRole.TRAINING_LEAD, UserRole.DISPATCHER}
    ),
    "push_radio_message": frozenset(
        {
            UserRole.ADMIN,
            UserRole.TRAINING_LEAD,
            UserRole.DISPATCHER,
            UserRole.RTP,
            UserRole.HQ,
            UserRole.COMBAT_AREA_1,
            UserRole.COMBAT_AREA_2,
        }
    ),
    "set_radio_interference": frozenset({UserRole.ADMIN}),
    "set_scene_address": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "upsert_scene_floor": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "set_active_scene_floor": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "upsert_scene_object": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "remove_scene_object": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "sync_scene_to_fire_objects": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "save_scene_checkpoint": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "start_lesson": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "pause_lesson": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "resume_lesson": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "finish_lesson": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
}
WS_MAX_COMMANDS_PER_WINDOW = 30
WS_RATE_LIMIT_WINDOW_SECONDS = 1
WS_MAX_COMMAND_ID_LENGTH = 128
WS_MAX_COMMAND_NAME_LENGTH = 64
WS_MAX_PAYLOAD_JSON_BYTES = 2_500_000
BU_COMMAND_POINT_BY_ROLE: dict[UserRole, str] = {
    UserRole.COMBAT_AREA_1: "BU1",
    UserRole.COMBAT_AREA_2: "BU2",
}
BU_LABEL_BY_ROLE: dict[UserRole, str] = {
    UserRole.COMBAT_AREA_1: "БУ-1",
    UserRole.COMBAT_AREA_2: "БУ-2",
}

SCENE_OBJECT_KINDS = {
    "WALL",
    "EXIT",
    "STAIR",
    "ROOM",
    "DOOR",
    "FIRE_SOURCE",
    "SMOKE_ZONE",
    "HYDRANT",
    "WATER_SOURCE",
}

SCENE_EDIT_LOCKED_COMMANDS = {
    "set_scene_address",
    "upsert_scene_floor",
    "set_active_scene_floor",
    "upsert_scene_object",
    "remove_scene_object",
    "sync_scene_to_fire_objects",
}

SCENE_RUNTIME_MUTABLE_KINDS = {"HYDRANT", "WALL"}

RADIO_ALLOWED_CHANNELS = {
    "1",
    "2",
    "3",
    "4",
}

RADIO_CHANNEL_ALIASES: dict[str, str] = {
    "MAIN": "1",
    "RTP_HQ": "2",
    "DISPATCH": "2",
    "RTP_BU1": "3",
    "RTP_BU2": "4",
}

RADIO_CHANNEL_TX_ROLES: dict[str, frozenset[UserRole]] = {
    "1": frozenset(
        {
            UserRole.ADMIN,
            UserRole.TRAINING_LEAD,
            UserRole.DISPATCHER,
            UserRole.RTP,
            UserRole.HQ,
            UserRole.COMBAT_AREA_1,
            UserRole.COMBAT_AREA_2,
        }
    ),
    "2": frozenset(
        {
            UserRole.ADMIN,
            UserRole.TRAINING_LEAD,
            UserRole.DISPATCHER,
            UserRole.RTP,
            UserRole.HQ,
        }
    ),
    "3": frozenset(
        {
            UserRole.ADMIN,
            UserRole.TRAINING_LEAD,
            UserRole.RTP,
            UserRole.COMBAT_AREA_1,
        }
    ),
    "4": frozenset(
        {
            UserRole.ADMIN,
            UserRole.TRAINING_LEAD,
            UserRole.RTP,
            UserRole.COMBAT_AREA_2,
        }
    ),
}

RADIO_AUDIO_BASE64_MAX_LENGTH = 2_000_000
try:
    _radio_log_limit = int(os.getenv("RADIO_LOG_LIMIT", "320"))
except ValueError:
    _radio_log_limit = 320
RADIO_LOG_LIMIT = max(80, min(800, _radio_log_limit))

try:
    _radio_log_audio_window = int(os.getenv("RADIO_LOG_AUDIO_WINDOW", "48"))
except ValueError:
    _radio_log_audio_window = 48
RADIO_LOG_AUDIO_WINDOW = max(8, min(120, _radio_log_audio_window))
RADIO_JOURNAL_LIMIT = 300


def parse_env_flag(name: str, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def resolve_default_radio_transcribe_cmd() -> str:
    configured = os.getenv("RADIO_TRANSCRIBE_CMD", "").strip()
    if configured:
        return configured

    script_path = Path(__file__).resolve().parent.parent / "scripts" / "transcribe.py"
    if not script_path.exists():
        return ""

    python_bin = shlex.quote(sys.executable or "python3")
    script_quoted = shlex.quote(str(script_path))
    return f"{python_bin} {script_quoted} {{file}}"


try:
    _radio_channel_hold_timeout = float(
        os.getenv("RADIO_CHANNEL_HOLD_TIMEOUT_SEC", "0.9")
    )
except ValueError:
    _radio_channel_hold_timeout = 0.9
RADIO_CHANNEL_HOLD_TIMEOUT_SEC = max(0.5, min(5.0, _radio_channel_hold_timeout))

RADIO_TRANSCRIBE_CMD = resolve_default_radio_transcribe_cmd()
try:
    _radio_transcribe_timeout = int(os.getenv("RADIO_TRANSCRIBE_TIMEOUT_SEC", "8"))
except ValueError:
    _radio_transcribe_timeout = 8
RADIO_TRANSCRIBE_TIMEOUT_SEC = max(1, min(20, _radio_transcribe_timeout))

RADIO_AUDIO_TRANSCODE_ENABLED = parse_env_flag("RADIO_AUDIO_TRANSCODE_ENABLED", True)
RADIO_AUDIO_TRANSCODE_FFMPEG_BIN = os.getenv(
    "RADIO_AUDIO_TRANSCODE_FFMPEG_BIN", ""
).strip() or (shutil.which("ffmpeg") or "")
RADIO_AUDIO_TRANSCODE_TARGET_MIME = (
    os.getenv("RADIO_AUDIO_TRANSCODE_TARGET_MIME", "audio/wav").strip() or "audio/wav"
)
try:
    _radio_audio_transcode_timeout = int(
        os.getenv("RADIO_AUDIO_TRANSCODE_TIMEOUT_SEC", "4")
    )
except ValueError:
    _radio_audio_transcode_timeout = 4
RADIO_AUDIO_TRANSCODE_TIMEOUT_SEC = max(1, min(15, _radio_audio_transcode_timeout))

DISPATCH_CODE_LENGTH = 7
DISPATCH_CODE_ALPHABET = frozenset("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
DISPATCH_ETA_SEC_MIN = 30
DISPATCH_ETA_SEC_MAX = 120

LESSON_TIME_LIMIT_MIN_SEC = 300
LESSON_TIME_LIMIT_MAX_SEC = 6 * 60 * 60
GAME_DAY_SECONDS = 24 * 60 * 60

SIMULATION_LOOP_INTERVAL_SEC = 1.0
SIMULATION_MAX_STEP_REAL_SEC = 4
FIRE_RUNTIME_SCHEMA_VERSION = "2.0"
SNAPSHOT_SCHEMA_VERSION = "2026.03"

LESSON_LIFECYCLE_DRAFT = "DRAFT"
LESSON_LIFECYCLE_RUNNING = "RUNNING"
LESSON_LIFECYCLE_PAUSED = "PAUSED"
LESSON_LIFECYCLE_COMPLETED = "COMPLETED"
LESSON_LIFECYCLE_VALUES = frozenset(
    {
        LESSON_LIFECYCLE_DRAFT,
        LESSON_LIFECYCLE_RUNNING,
        LESSON_LIFECYCLE_PAUSED,
        LESSON_LIFECYCLE_COMPLETED,
    }
)

Q_NORM_L_S_M2: dict[FireZoneKind, float] = {
    FireZoneKind.FIRE_SEAT: PhysicsCfg.Q_NORM_L_S_M2.get("FIRE_SEAT", 0.08),
    FireZoneKind.FIRE_ZONE: PhysicsCfg.Q_NORM_L_S_M2.get("FIRE_ZONE", 0.05),
}
FORECAST_GROWING_THRESHOLD = PhysicsCfg.FORECAST_GROWING_THRESHOLD
FORECAST_STABLE_THRESHOLD = PhysicsCfg.FORECAST_STABLE_THRESHOLD

DEFAULT_VEHICLE_WATER_BY_TYPE: dict[str, float] = {
    "AC": 3200.0,
    "AL": 1000.0,
    "ASA": 1000.0,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def is_auth_session_expired(expires_at: datetime) -> bool:
    return to_utc(expires_at) <= utcnow()


def ensure_ws_actor_active(db, user_id: UUID, auth_session_id: UUID) -> User:
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Could not validate credentials")

    auth_session = db.get(AuthSession, auth_session_id)
    if auth_session is None:
        raise HTTPException(status_code=401, detail="Could not validate credentials")
    if auth_session.user_id != user_id:
        raise HTTPException(status_code=401, detail="Could not validate credentials")
    if auth_session.is_revoked:
        raise HTTPException(status_code=401, detail="Session revoked")
    if is_auth_session_expired(auth_session.expires_at):
        raise HTTPException(status_code=401, detail="Session expired")

    return user


def enforce_ws_rate_limit(command_times: list[datetime]) -> None:
    now = utcnow()
    border = now - timedelta(seconds=WS_RATE_LIMIT_WINDOW_SECONDS)
    command_times[:] = [value for value in command_times if value >= border]
    if len(command_times) >= WS_MAX_COMMANDS_PER_WINDOW:
        raise HTTPException(
            status_code=429,
            detail="Too many realtime commands",
        )
    command_times.append(now)


def parse_uuid(value: Any, field_name: str) -> UUID:
    if not isinstance(value, str):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be UUID string",
        )
    try:
        return UUID(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be valid UUID",
        ) from exc


def parse_enum(enum_cls, value: Any, field_name: str):
    try:
        return enum_cls(str(value))
    except Exception as exc:
        allowed_values = ", ".join([entry.value for entry in enum_cls])
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be one of: {allowed_values}",
        ) from exc


def parse_non_negative_float(value: Any, field_name: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be number",
        ) from exc
    if parsed < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be non-negative",
        )
    return parsed


def parse_optional_non_negative_float(value: Any, field_name: str) -> float | None:
    if value is None:
        return None
    return parse_non_negative_float(value, field_name)


def parse_optional_non_negative_int(value: Any, field_name: str) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be integer",
        ) from exc
    if parsed < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be non-negative integer",
        )
    return parsed


def parse_optional_bool(value: Any, field_name: str) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"{field_name} must be boolean",
    )


def parse_finite_float(value: Any, field_name: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be number",
        ) from exc
    if not math.isfinite(parsed):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be finite",
        )
    return parsed


def parse_floor_id(value: Any) -> str:
    floor_id = str(value or "").strip().upper()
    if len(floor_id) == 0:
        raise HTTPException(status_code=422, detail="floor_id is required")
    if len(floor_id) > 16:
        raise HTTPException(status_code=422, detail="floor_id is too long")
    return floor_id


def parse_scene_kind(value: Any) -> str:
    kind = str(value or "").strip().upper()
    if kind not in SCENE_OBJECT_KINDS:
        allowed_values = ", ".join(sorted(SCENE_OBJECT_KINDS))
        raise HTTPException(
            status_code=422, detail=f"kind must be one of: {allowed_values}"
        )
    return kind


def parse_point_geometry(value: Any, field_name: str = "geometry") -> dict[str, float]:
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail=f"{field_name} must be object")
    x = parse_finite_float(value.get("x"), f"{field_name}.x")
    y = parse_finite_float(value.get("y"), f"{field_name}.y")
    return {"x": x, "y": y}


def parse_points_array(value: Any, field_name: str) -> list[dict[str, float]]:
    if not isinstance(value, list) or len(value) < 2:
        raise HTTPException(
            status_code=422, detail=f"{field_name} must contain at least 2 points"
        )
    points: list[dict[str, float]] = []
    for idx, point_value in enumerate(value):
        point = parse_point_geometry(point_value, f"{field_name}[{idx}]")
        points.append(point)
    return points


def parse_polygon_points(value: Any, field_name: str) -> list[dict[str, float]]:
    points = parse_points_array(value, field_name)
    if len(points) < 3:
        raise HTTPException(
            status_code=422, detail=f"{field_name} must contain at least 3 points"
        )
    return points


def parse_scene_geometry(
    geometry_type: GeometryType, geometry_payload: Any
) -> dict[str, Any]:
    if geometry_type == GeometryType.POINT:
        return parse_point_geometry(geometry_payload)
    if not isinstance(geometry_payload, dict):
        raise HTTPException(status_code=422, detail="geometry must be object")
    if geometry_type == GeometryType.LINESTRING:
        return {
            "points": parse_points_array(
                geometry_payload.get("points"), "geometry.points"
            )
        }
    if geometry_type == GeometryType.POLYGON:
        return {
            "points": parse_polygon_points(
                geometry_payload.get("points"), "geometry.points"
            )
        }
    raise HTTPException(status_code=422, detail="Unsupported geometry_type")


def clone_json_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return json.loads(json.dumps(value, ensure_ascii=False))


def ensure_training_scene(
    snapshot: SessionStateSnapshot,
) -> tuple[dict[str, Any], dict[str, Any]]:
    snapshot_data = clone_json_dict(snapshot.snapshot_data)
    scene = clone_json_dict(snapshot_data.get("training_lead_scene"))

    floors = scene.get("floors")
    if not isinstance(floors, list):
        floors = []
    normalized_floors: list[dict[str, Any]] = []
    for floor in floors:
        if not isinstance(floor, dict):
            continue
        floor_id = str(floor.get("floor_id") or "").strip().upper()
        if not floor_id:
            continue
        elevation_m = parse_finite_float(
            floor.get("elevation_m", 0), "floor.elevation_m"
        )
        objects = floor.get("objects")
        if not isinstance(objects, list):
            objects = []
        normalized_floors.append(
            {
                "floor_id": floor_id,
                "elevation_m": elevation_m,
                "objects": [item for item in objects if isinstance(item, dict)],
            }
        )

    scene["version"] = int(scene.get("version", 1) or 1)
    scene["address"] = clone_json_dict(scene.get("address"))
    scene["site_entities"] = [
        item for item in scene.get("site_entities", []) if isinstance(item, dict)
    ]
    scene["floors"] = normalized_floors
    scene["active_floor_id"] = (
        str(scene.get("active_floor_id") or "F1").strip().upper() or "F1"
    )
    scene["scale_m_per_grid"] = parse_finite_float(
        scene.get("scale_m_per_grid", 2.0), "scale_m_per_grid"
    )
    scene["updated_at"] = scene.get("updated_at") or utcnow().isoformat()

    return snapshot_data, scene


def persist_training_scene(
    snapshot: SessionStateSnapshot, snapshot_data: dict[str, Any], scene: dict[str, Any]
) -> None:
    scene["updated_at"] = utcnow().isoformat()
    snapshot_data["training_lead_scene"] = scene
    snapshot.snapshot_data = snapshot_data


def ensure_scene_floor(
    scene: dict[str, Any], floor_id: str, elevation_m: float = 0.0
) -> dict[str, Any]:
    floors = scene.get("floors")
    if not isinstance(floors, list):
        floors = []
        scene["floors"] = floors

    for floor in floors:
        if (
            isinstance(floor, dict)
            and str(floor.get("floor_id") or "").upper() == floor_id
        ):
            if not isinstance(floor.get("objects"), list):
                floor["objects"] = []
            if "elevation_m" not in floor:
                floor["elevation_m"] = elevation_m
            return floor

    floor = {"floor_id": floor_id, "elevation_m": elevation_m, "objects": []}
    floors.append(floor)
    return floor


def find_scene_object_by_id(
    scene: dict[str, Any], object_id: str
) -> dict[str, Any] | None:
    floors = scene.get("floors")
    if not isinstance(floors, list):
        return None

    for floor in floors:
        if not isinstance(floor, dict):
            continue
        objects = floor.get("objects")
        if not isinstance(objects, list):
            continue
        for item in objects:
            if not isinstance(item, dict):
                continue
            if str(item.get("id") or "") == object_id:
                return item

    return None


def assert_scene_upsert_allowed_during_lesson(
    payload: dict[str, Any], existing_scene_object: dict[str, Any] | None
) -> None:
    object_id = str(payload.get("object_id") or "").strip()
    if not object_id:
        raise HTTPException(
            status_code=409,
            detail="Lesson is in progress. Creating new scene objects is not allowed",
        )

    kind = str(payload.get("kind") or "").strip().upper()
    if kind not in SCENE_RUNTIME_MUTABLE_KINDS:
        raise HTTPException(
            status_code=409,
            detail="Lesson is in progress. Only HYDRANT and WALL runtime updates are allowed",
        )

    if existing_scene_object is None:
        raise HTTPException(
            status_code=409,
            detail="Lesson is in progress. Scene object must exist before runtime updates",
        )

    existing_kind = str(existing_scene_object.get("kind") or "").strip().upper()
    if existing_kind != kind:
        raise HTTPException(
            status_code=409,
            detail="Lesson is in progress. Changing scene object kind is not allowed",
        )

    existing_geometry_type = (
        str(existing_scene_object.get("geometry_type") or "").strip().upper()
    )
    incoming_geometry_type = str(payload.get("geometry_type") or "").strip().upper()
    if incoming_geometry_type != existing_geometry_type:
        raise HTTPException(
            status_code=409,
            detail="Lesson is in progress. Changing geometry_type is not allowed",
        )

    incoming_geometry = payload.get("geometry")
    if not isinstance(incoming_geometry, dict):
        raise HTTPException(status_code=422, detail="geometry must be object")

    existing_geometry = existing_scene_object.get("geometry")
    if incoming_geometry != existing_geometry:
        raise HTTPException(
            status_code=409,
            detail="Lesson is in progress. Moving scene geometry is not allowed",
        )

    if kind == "WALL":
        props = payload.get("props")
        if not isinstance(props, dict) or props.get("collapsed") is not True:
            raise HTTPException(
                status_code=409,
                detail="Lesson is in progress. WALL updates are limited to collapse event",
            )


def assert_scene_command_allowed_for_session(
    db,
    session_id: UUID,
    command: str,
    payload: dict[str, Any],
) -> None:
    if command not in SCENE_EDIT_LOCKED_COMMANDS:
        return

    session_obj = db.get(SimulationSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if session_obj.status not in {SessionStatus.IN_PROGRESS, SessionStatus.PAUSED}:
        return

    if command != "upsert_scene_object":
        raise HTTPException(
            status_code=409,
            detail="Lesson is in progress. Scene editing is locked",
        )

    object_id = str(payload.get("object_id") or "").strip()
    snapshot = get_or_create_current_snapshot(db, session_id)
    _, scene = ensure_training_scene(snapshot)
    existing_scene_object = (
        find_scene_object_by_id(scene, object_id) if object_id else None
    )

    assert_scene_upsert_allowed_during_lesson(payload, existing_scene_object)


def assert_role_allowed_for_command(user: User, command: str) -> None:
    allowed_roles = WS_COMMAND_ALLOWED_ROLES.get(command)
    if allowed_roles is None:
        return

    user_roles = canonical_user_roles(user)
    if user_roles.intersection(allowed_roles):
        return

    raise HTTPException(
        status_code=403,
        detail=f"Role is not allowed to run command: {command}",
    )


def parse_radio_channel(value: Any, field_name: str = "channel") -> str:
    normalized = str(value or "").strip().upper()
    channel = RADIO_CHANNEL_ALIASES.get(normalized, normalized)
    if channel not in RADIO_ALLOWED_CHANNELS:
        allowed_channels = ", ".join(sorted(RADIO_ALLOWED_CHANNELS))
        raise HTTPException(
            status_code=422,
            detail=f"{field_name} must be one of: {allowed_channels}",
        )
    return channel


def parse_dispatch_code(
    value: Any, field_name: str = "resource_data.dispatch_code"
) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail=f"{field_name} must be string")

    code = value.strip().upper()
    if len(code) != DISPATCH_CODE_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"{field_name} must be exactly {DISPATCH_CODE_LENGTH} chars",
        )

    if any(char not in DISPATCH_CODE_ALPHABET for char in code):
        raise HTTPException(
            status_code=422,
            detail=f"{field_name} must use letters/digits from dispatcher alphabet",
        )

    return code


def normalize_resource_role_tag(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = normalize_role_name(value)
    if normalized == UserRole.DISPATCHER.value:
        return UserRole.DISPATCHER.value
    if normalized in {"BU1", "БУ1", "БУ - 1", UserRole.COMBAT_AREA_1.value}:
        return UserRole.COMBAT_AREA_1.value
    if normalized in {"BU2", "БУ2", "БУ - 2", UserRole.COMBAT_AREA_2.value}:
        return UserRole.COMBAT_AREA_2.value
    if normalized in {"RTP", UserRole.RTP.value}:
        return UserRole.RTP.value
    if normalized in {"HQ", UserRole.HQ.value, "ШТАБ"}:
        return UserRole.HQ.value
    return normalized


def is_dispatcher_vehicle_dispatch(
    user: User,
    resource_kind: ResourceKind,
    status_value: DeploymentStatus,
    resource_data: dict[str, Any],
) -> bool:
    if resource_kind != ResourceKind.VEHICLE:
        return False
    if status_value != DeploymentStatus.EN_ROUTE:
        return False

    role_tag = normalize_resource_role_tag(resource_data.get("role"))
    if role_tag == UserRole.DISPATCHER.value:
        return True

    user_roles = canonical_user_roles(user)
    return UserRole.DISPATCHER in user_roles


def validate_dispatcher_vehicle_call_resource_data(
    resource_data: dict[str, Any],
) -> None:
    dispatch_code = parse_dispatch_code(resource_data.get("dispatch_code"))
    resource_data["dispatch_code"] = dispatch_code

    dispatch_eta_sec = parse_optional_non_negative_int(
        resource_data.get("dispatch_eta_sec"), "resource_data.dispatch_eta_sec"
    )
    dispatch_eta_min = parse_optional_non_negative_int(
        resource_data.get("dispatch_eta_min"), "resource_data.dispatch_eta_min"
    )

    if dispatch_eta_sec is None and dispatch_eta_min is not None:
        dispatch_eta_sec = dispatch_eta_min * 60

    if dispatch_eta_sec is None:
        raise HTTPException(
            status_code=422,
            detail="resource_data.dispatch_eta_sec is required for dispatcher vehicle dispatch",
        )

    if (
        dispatch_eta_sec < DISPATCH_ETA_SEC_MIN
        or dispatch_eta_sec > DISPATCH_ETA_SEC_MAX
    ):
        raise HTTPException(
            status_code=422,
            detail=f"resource_data.dispatch_eta_sec must be in range [{DISPATCH_ETA_SEC_MIN}..{DISPATCH_ETA_SEC_MAX}]",
        )

    resource_data["dispatch_eta_sec"] = dispatch_eta_sec
    resource_data["dispatch_eta_min"] = max(1, math.ceil(dispatch_eta_sec / 60))

    eta_at = resource_data.get("dispatch_eta_at")
    if eta_at is not None:
        if not isinstance(eta_at, str) or not eta_at.strip():
            raise HTTPException(
                status_code=422,
                detail="resource_data.dispatch_eta_at must be ISO datetime string",
            )
        try:
            datetime.fromisoformat(eta_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail="resource_data.dispatch_eta_at must be valid ISO datetime",
            ) from exc


def assert_deployment_workflow_allowed_for_role(
    user: User,
    resource_kind: ResourceKind,
    status_value: DeploymentStatus,
    resource_data: dict[str, Any],
) -> None:
    user_roles = canonical_user_roles(user)
    if UserRole.ADMIN in user_roles or UserRole.TRAINING_LEAD in user_roles:
        return

    role_tag = normalize_resource_role_tag(resource_data.get("role"))

    if UserRole.DISPATCHER in user_roles:
        if not is_dispatcher_vehicle_dispatch(
            user, resource_kind, status_value, resource_data
        ):
            raise HTTPException(
                status_code=403,
                detail="Dispatcher can dispatch only EN_ROUTE vehicle records",
            )
        return

    if UserRole.HQ in user_roles:
        is_plan_only = resource_data.get("plan_only") is True
        if not is_plan_only:
            raise HTTPException(
                status_code=403,
                detail="HQ can place only planning resources",
            )
        if resource_kind not in {
            ResourceKind.MARKER,
            ResourceKind.HOSE_LINE,
            ResourceKind.HOSE_SPLITTER,
            ResourceKind.NOZZLE,
            ResourceKind.WATER_SOURCE,
        }:
            raise HTTPException(
                status_code=403,
                detail="HQ planning supports markers, hose lines/splitters, nozzles and water sources",
            )
        if status_value not in {DeploymentStatus.PLANNED, DeploymentStatus.DEPLOYED}:
            raise HTTPException(
                status_code=403,
                detail="HQ planning resources must use PLANNED or DEPLOYED status",
            )
        return

    if UserRole.RTP in user_roles:
        if resource_kind != ResourceKind.MARKER:
            raise HTTPException(
                status_code=403,
                detail="RTP can place only command markers",
            )
        command_point = str(resource_data.get("command_point") or "").strip().upper()
        if command_point not in {"HQ", "BU1", "BU2"}:
            raise HTTPException(
                status_code=403,
                detail="RTP marker must define command_point: HQ, BU1 or BU2",
            )
        return

    bu_role: UserRole | None = None
    if UserRole.COMBAT_AREA_1 in user_roles:
        bu_role = UserRole.COMBAT_AREA_1
    elif UserRole.COMBAT_AREA_2 in user_roles:
        bu_role = UserRole.COMBAT_AREA_2

    if bu_role is not None:
        if resource_kind not in {
            ResourceKind.VEHICLE,
            ResourceKind.HOSE_LINE,
            ResourceKind.HOSE_SPLITTER,
            ResourceKind.NOZZLE,
            ResourceKind.MARKER,
            ResourceKind.WATER_SOURCE,
        }:
            raise HTTPException(
                status_code=403,
                detail="Combat area role cannot place this resource type",
            )

        if role_tag and role_tag != bu_role.value:
            raise HTTPException(
                status_code=403,
                detail="Combat area role can manage only its own area resources",
            )
        return


def resolve_combat_area_role_for_user(user: User) -> UserRole | None:
    user_roles = canonical_user_roles(user)
    if UserRole.COMBAT_AREA_1 in user_roles:
        return UserRole.COMBAT_AREA_1
    if UserRole.COMBAT_AREA_2 in user_roles:
        return UserRole.COMBAT_AREA_2
    return None


def has_rtp_command_point_for_combat_area(
    db,
    snapshot_id: UUID,
    bu_role: UserRole,
) -> bool:
    target_command_point = BU_COMMAND_POINT_BY_ROLE.get(bu_role)
    if target_command_point is None:
        return False

    marker_deployments = (
        db.execute(
            select(ResourceDeployment)
            .where(
                ResourceDeployment.state_id == snapshot_id,
                ResourceDeployment.resource_kind == ResourceKind.MARKER,
                ResourceDeployment.status != DeploymentStatus.COMPLETED,
            )
            .order_by(ResourceDeployment.created_at.desc())
        )
        .scalars()
        .all()
    )

    for deployment in marker_deployments:
        resource_data = (
            deployment.resource_data
            if isinstance(deployment.resource_data, dict)
            else {}
        )
        role_tag = normalize_resource_role_tag(
            resource_data.get("role") or resource_data.get("initiated_from_role")
        )
        command_point = str(resource_data.get("command_point") or "").strip().upper()
        if role_tag == UserRole.RTP.value and command_point == target_command_point:
            return True

    return False


def assert_combat_area_is_activated_by_rtp(
    db,
    snapshot: SessionStateSnapshot,
    user: User,
) -> None:
    bu_role = resolve_combat_area_role_for_user(user)
    if bu_role is None:
        return

    if has_rtp_command_point_for_combat_area(db, snapshot.id, bu_role):
        return

    bu_label = BU_LABEL_BY_ROLE.get(bu_role, bu_role.value)
    command_point = BU_COMMAND_POINT_BY_ROLE.get(bu_role, bu_role.value)
    raise HTTPException(
        status_code=409,
        detail=f"{bu_label} ожидает постановки РТП. РТП должен разместить командную точку {command_point}",
    )


def parse_lesson_start_settings(payload: dict[str, Any]) -> dict[str, int]:
    time_limit_sec = parse_optional_non_negative_int(
        payload.get("time_limit_sec"), "time_limit_sec"
    )
    if time_limit_sec is None:
        time_limit_sec = 30 * 60
    if time_limit_sec < LESSON_TIME_LIMIT_MIN_SEC:
        time_limit_sec = LESSON_TIME_LIMIT_MIN_SEC
    if time_limit_sec > LESSON_TIME_LIMIT_MAX_SEC:
        time_limit_sec = LESSON_TIME_LIMIT_MAX_SEC

    start_sim_time_seconds = parse_optional_non_negative_int(
        payload.get("start_sim_time_seconds"), "start_sim_time_seconds"
    )
    if start_sim_time_seconds is None:
        start_sim_time_seconds = 10 * 60 * 60
    start_sim_time_seconds = start_sim_time_seconds % GAME_DAY_SECONDS

    return {
        "time_limit_sec": time_limit_sec,
        "start_sim_time_seconds": start_sim_time_seconds,
    }


def normalize_lesson_lifecycle_status(
    raw_lifecycle_status: Any, raw_legacy_status: Any
) -> str:
    lifecycle = str(raw_lifecycle_status or "").strip().upper()
    legacy = str(raw_legacy_status or "").strip().upper()

    if lifecycle in LESSON_LIFECYCLE_VALUES:
        return lifecycle

    if legacy in {"IN_PROGRESS", LESSON_LIFECYCLE_RUNNING}:
        return LESSON_LIFECYCLE_RUNNING
    if legacy in {"PAUSED", LESSON_LIFECYCLE_PAUSED}:
        return LESSON_LIFECYCLE_PAUSED
    if legacy in {"COMPLETED", LESSON_LIFECYCLE_COMPLETED}:
        return LESSON_LIFECYCLE_COMPLETED
    if legacy in {"CREATED", LESSON_LIFECYCLE_DRAFT}:
        return LESSON_LIFECYCLE_DRAFT

    return LESSON_LIFECYCLE_DRAFT


def lesson_legacy_status_from_lifecycle(lifecycle_status: str) -> str:
    if lifecycle_status == LESSON_LIFECYCLE_RUNNING:
        return "IN_PROGRESS"
    if lifecycle_status == LESSON_LIFECYCLE_PAUSED:
        return "PAUSED"
    if lifecycle_status == LESSON_LIFECYCLE_COMPLETED:
        return "COMPLETED"
    return "CREATED"


def parse_iso_datetime_utc(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None

    normalized = value.strip()
    if not normalized:
        return None

    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_iso_timestamp_ms(value: Any) -> float | None:
    parsed = parse_iso_datetime_utc(value)
    if parsed is None:
        return None
    return parsed.timestamp() * 1000


def as_float(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(parsed):
        return fallback
    return parsed


def as_non_negative_int(value: Any, fallback: int | None = None) -> int | None:
    if isinstance(value, bool):
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    if parsed < 0:
        return fallback
    return parsed


def as_non_empty_string(value: Any, fallback: str = "") -> str:
    if isinstance(value, UUID):
        text = str(value)
    elif isinstance(value, str):
        text = value
    else:
        return fallback
    normalized = text.strip()
    return normalized if normalized else fallback


def as_bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    return fallback


def geometry_center(geometry_type: Any, geometry: Any) -> tuple[float, float] | None:
    if not isinstance(geometry, dict):
        return None

    geometry_type_value = str(
        geometry_type.value
        if isinstance(geometry_type, GeometryType)
        else geometry_type
    ).upper()

    if geometry_type_value == GeometryType.POINT.value:
        x = as_float(geometry.get("x"), float("nan"))
        y = as_float(geometry.get("y"), float("nan"))
        if not math.isfinite(x) or not math.isfinite(y):
            return None
        return x, y

    points_raw = geometry.get("points")
    if not isinstance(points_raw, list):
        return None

    points: list[tuple[float, float]] = []
    for item in points_raw:
        if not isinstance(item, dict):
            continue
        x = as_float(item.get("x"), float("nan"))
        y = as_float(item.get("y"), float("nan"))
        if not math.isfinite(x) or not math.isfinite(y):
            continue
        points.append((x, y))

    if not points:
        return None

    sum_x = sum(point[0] for point in points)
    sum_y = sum(point[1] for point in points)
    return sum_x / len(points), sum_y / len(points)


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return math.sqrt(dx * dx + dy * dy)


HOSE_DIAMETER_MM_BY_TYPE: dict[str, int] = {
    "H51": 51,
    "H66": 66,
    "H77": 77,
    "H150": 150,
}

# Pressure loss coefficient per 20m hose segment (bar at 1 l/s^2 scale).
HOSE_PRESSURE_LOSS_K20_BY_DIAMETER_MM: dict[int, float] = {
    51: 0.030,
    66: 0.014,
    77: 0.009,
    150: 0.0015,
}


def normalize_hose_type(value: Any) -> str:
    normalized = str(value or "").strip().upper()
    return normalized if normalized in HOSE_DIAMETER_MM_BY_TYPE else "H51"


def geometry_length_m(geometry_type: GeometryType, geometry: dict[str, Any]) -> float:
    if geometry_type == GeometryType.LINESTRING:
        points_raw = geometry.get("points")
        if isinstance(points_raw, list):
            points = [
                normalize_point_tuple((point.get("x"), point.get("y")))
                for point in points_raw
                if isinstance(point, dict)
            ]
            compact_points = [point for point in points if point is not None]
            if len(compact_points) >= 2:
                total = 0.0
                for idx in range(1, len(compact_points)):
                    total += distance_m(compact_points[idx - 1], compact_points[idx])
                return max(1.0, total)

    center = geometry_center(geometry_type, geometry)
    if center is None:
        return 20.0
    return 20.0


def hose_pressure_loss_bar(flow_l_s: float, length_m: float, hose_type: str) -> float:
    diameter_mm = HOSE_DIAMETER_MM_BY_TYPE.get(hose_type, 51)
    k20 = HOSE_PRESSURE_LOSS_K20_BY_DIAMETER_MM.get(diameter_mm, 0.030)
    segments_20m = max(0.5, length_m / 20.0)
    return max(0.0, k20 * (flow_l_s**2) * segments_20m)


def normalize_point_tuple(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    x = as_float(value[0], float("nan"))
    y = as_float(value[1], float("nan"))
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return (x, y)


def polygon_area_m2(points: list[tuple[float, float]]) -> float:
    if len(points) < 3:
        return 0.0
    area = 0.0
    prev_x, prev_y = points[-1]
    for curr_x, curr_y in points:
        area += prev_x * curr_y - curr_x * prev_y
        prev_x, prev_y = curr_x, curr_y
    return abs(area) * 0.5


def point_inside_polygon(
    point: tuple[float, float], polygon: list[tuple[float, float]]
) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    px, py = point
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        intersects = ((yi > py) != (yj > py)) and (
            px < (xj - xi) * (py - yi) / ((yj - yi) or 1e-9) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def extract_containment_polygons_from_scene(
    snapshot_data: dict[str, Any],
) -> list[tuple[list[tuple[float, float]], float]]:
    scene_raw = snapshot_data.get("training_lead_scene")
    if not isinstance(scene_raw, dict):
        return []

    candidates: list[dict[str, Any]] = []
    site_entities = scene_raw.get("site_entities")
    if isinstance(site_entities, list):
        candidates.extend(item for item in site_entities if isinstance(item, dict))

    floors = scene_raw.get("floors")
    if isinstance(floors, list):
        for floor in floors:
            if not isinstance(floor, dict):
                continue
            objects = floor.get("objects")
            if isinstance(objects, list):
                candidates.extend(item for item in objects if isinstance(item, dict))

    polygons_with_area: list[tuple[list[tuple[float, float]], float]] = []
    for item in candidates:
        geometry_type = str(item.get("geometry_type") or "").strip().upper()
        if geometry_type != GeometryType.POLYGON.value:
            continue

        geometry = item.get("geometry")
        if not isinstance(geometry, dict):
            continue
        points_raw = geometry.get("points")
        if not isinstance(points_raw, list):
            continue
        points = [
            normalize_point_tuple((point.get("x"), point.get("y")))
            for point in points_raw
            if isinstance(point, dict)
        ]
        polygon = [point for point in points if point is not None]
        if len(polygon) < 3:
            continue
        area = polygon_area_m2(polygon)
        if area > 0:
            polygons_with_area.append((polygon, area))

    polygons_with_area.sort(key=lambda item: item[1])
    return polygons_with_area


def ensure_fire_runtime(snapshot_data: dict[str, Any]) -> dict[str, Any]:
    raw_runtime = snapshot_data.get("fire_runtime")
    runtime = clone_json_dict(raw_runtime)
    runtime["schema_version"] = FIRE_RUNTIME_SCHEMA_VERSION

    raw_vehicle_runtime = runtime.get("vehicle_runtime")
    runtime["vehicle_runtime"] = (
        clone_json_dict(raw_vehicle_runtime)
        if isinstance(raw_vehicle_runtime, dict)
        else {}
    )
    raw_hose_runtime = runtime.get("hose_runtime")
    runtime["hose_runtime"] = (
        clone_json_dict(raw_hose_runtime) if isinstance(raw_hose_runtime, dict) else {}
    )
    raw_nozzle_runtime = runtime.get("nozzle_runtime")
    runtime["nozzle_runtime"] = (
        clone_json_dict(raw_nozzle_runtime)
        if isinstance(raw_nozzle_runtime, dict)
        else {}
    )
    runtime["environment"] = (
        clone_json_dict(runtime.get("environment"))
        if isinstance(runtime.get("environment"), dict)
        else {}
    )
    runtime_health = (
        clone_json_dict(runtime.get("runtime_health"))
        if isinstance(runtime.get("runtime_health"), dict)
        else {}
    )
    runtime_health.setdefault("ticks_total", 0)
    runtime_health.setdefault("dropped_ticks_total", 0)
    runtime_health.setdefault("tick_lag_sec", 0.0)
    runtime_health.setdefault("last_tick_at", None)
    runtime_health.setdefault("loop_interval_sec", SIMULATION_LOOP_INTERVAL_SEC)
    runtime_health.setdefault("max_step_real_sec", SIMULATION_MAX_STEP_REAL_SEC)
    runtime["runtime_health"] = runtime_health
    runtime["updated_at"] = runtime.get("updated_at") or utcnow().isoformat()

    snapshot_data.setdefault("snapshot_schema_version", SNAPSHOT_SCHEMA_VERSION)
    snapshot_data["fire_runtime"] = runtime
    return runtime


def fallback_vehicle_water_capacity(vehicle: VehicleDictionary | None) -> float:
    if vehicle is None:
        return DEFAULT_VEHICLE_WATER_BY_TYPE["AC"]

    if vehicle.water_capacity is not None and float(vehicle.water_capacity) > 0:
        return float(vehicle.water_capacity)

    vehicle_type = str(
        vehicle.type.value if hasattr(vehicle.type, "value") else vehicle.type
    )
    return DEFAULT_VEHICLE_WATER_BY_TYPE.get(
        vehicle_type, DEFAULT_VEHICLE_WATER_BY_TYPE["AC"]
    )


def apply_fire_dynamics_tick(
    db,
    snapshot: SessionStateSnapshot,
    session_obj: SimulationSession,
    snapshot_data: dict[str, Any],
    dt_game_sec: int,
    tick_time: datetime,
) -> None:
    fire_objects = (
        db.execute(
            select(FireObject)
            .where(FireObject.state_id == snapshot.id)
            .order_by(FireObject.created_at.asc())
        )
        .scalars()
        .all()
    )
    if not fire_objects:
        return

    deployments = (
        db.execute(
            select(ResourceDeployment)
            .where(ResourceDeployment.state_id == snapshot.id)
            .order_by(ResourceDeployment.created_at.asc())
        )
        .scalars()
        .all()
    )

    deployment_by_id = {str(deployment.id): deployment for deployment in deployments}

    latest_vehicle_deployment: dict[int, ResourceDeployment] = {}
    for deployment in deployments:
        if deployment.resource_kind != ResourceKind.VEHICLE:
            continue
        vehicle_id = deployment.vehicle_dictionary_id
        if not vehicle_id:
            continue
        previous = latest_vehicle_deployment.get(vehicle_id)
        if previous is None or deployment.created_at >= previous.created_at:
            latest_vehicle_deployment[vehicle_id] = deployment

    hose_entries_by_id: dict[str, dict[str, Any]] = {}
    hose_entries_by_chain_id: dict[str, dict[str, Any]] = {}
    hose_runtime: dict[str, Any] = {}
    splitter_entries_by_id: dict[str, dict[str, Any]] = {}

    for deployment in deployments:
        if deployment.resource_kind != ResourceKind.HOSE_SPLITTER:
            continue
        if deployment.status == DeploymentStatus.COMPLETED:
            continue
        resource_data = (
            deployment.resource_data
            if isinstance(deployment.resource_data, dict)
            else {}
        )
        if resource_data.get("plan_only") is True:
            continue
        splitter_entries_by_id[str(deployment.id)] = {
            "deployment_id": str(deployment.id),
            "linked_vehicle_id": as_non_negative_int(
                resource_data.get("linked_vehicle_id")
            ),
            "chain_id": as_non_empty_string(resource_data.get("chain_id")),
            "max_branches": max(
                1, as_non_negative_int(resource_data.get("max_branches")) or 3
            ),
            "center": geometry_center(deployment.geometry_type, deployment.geometry),
        }

    for deployment in deployments:
        if deployment.resource_kind != ResourceKind.HOSE_LINE:
            continue
        if deployment.status == DeploymentStatus.COMPLETED:
            continue

        resource_data = (
            deployment.resource_data
            if isinstance(deployment.resource_data, dict)
            else {}
        )
        if resource_data.get("plan_only") is True:
            continue

        role_tag = normalize_resource_role_tag(resource_data.get("role"))
        center = geometry_center(deployment.geometry_type, deployment.geometry)
        hose_type = normalize_hose_type(resource_data.get("hose_type"))
        length_m = geometry_length_m(deployment.geometry_type, deployment.geometry)

        chain_id = as_non_empty_string(
            resource_data.get("chain_id")
            or resource_data.get("linked_hose_line_chain_id")
            or str(deployment.id)
        )

        linked_vehicle_id = as_non_negative_int(resource_data.get("linked_vehicle_id"))
        linked_splitter_id = as_non_empty_string(
            resource_data.get("linked_splitter_id")
        )
        parent_chain_id = as_non_empty_string(resource_data.get("parent_chain_id"))
        if linked_vehicle_id in {None, 0}:
            linked_vehicle_deployment_id = as_non_empty_string(
                resource_data.get("linked_vehicle_deployment_id")
                or resource_data.get("vehicle_deployment_id")
            )
            if linked_vehicle_deployment_id:
                linked_vehicle_deployment = deployment_by_id.get(
                    linked_vehicle_deployment_id
                )
                if (
                    linked_vehicle_deployment is not None
                    and linked_vehicle_deployment.resource_kind == ResourceKind.VEHICLE
                    and linked_vehicle_deployment.vehicle_dictionary_id
                ):
                    linked_vehicle_id = int(
                        linked_vehicle_deployment.vehicle_dictionary_id
                    )

        strict_chain = as_bool(resource_data.get("strict_chain"), False)

        hose_entry = {
            "deployment_id": str(deployment.id),
            "chain_id": chain_id,
            "status": deployment.status.value,
            "role": role_tag,
            "center": center,
            "linked_vehicle_id": linked_vehicle_id,
            "linked_splitter_id": linked_splitter_id,
            "parent_chain_id": parent_chain_id,
            "strict_chain": strict_chain,
            "hose_type": hose_type,
            "length_m": round(length_m, 2),
        }
        hose_entries_by_id[str(deployment.id)] = hose_entry
        hose_entries_by_chain_id[chain_id] = hose_entry
        hose_runtime[str(deployment.id)] = {
            "chain_id": chain_id,
            "linked_vehicle_id": linked_vehicle_id,
            "linked_splitter_id": linked_splitter_id,
            "parent_chain_id": parent_chain_id,
            "strict_chain": strict_chain,
            "has_water": False,
            "blocked_reason": "NO_LINKED_VEHICLE"
            if strict_chain and linked_vehicle_id in {None, 0}
            else None,
            "hose_type": hose_type,
            "length_m": round(length_m, 2),
            "updated_at": tick_time.isoformat(),
        }

    vehicle_ids = list(latest_vehicle_deployment.keys())
    vehicle_rows = (
        db.execute(
            select(VehicleDictionary).where(VehicleDictionary.id.in_(vehicle_ids))
        )
        .scalars()
        .all()
        if vehicle_ids
        else []
    )
    vehicle_by_id = {vehicle.id: vehicle for vehicle in vehicle_rows}

    fire_runtime = ensure_fire_runtime(snapshot_data)
    vehicle_runtime = clone_json_dict(fire_runtime.get("vehicle_runtime"))

    vehicle_entries: list[dict[str, Any]] = []
    for vehicle_id, deployment in latest_vehicle_deployment.items():
        if deployment.status not in {
            DeploymentStatus.DEPLOYED,
            DeploymentStatus.ACTIVE,
        }:
            continue

        resource_data = (
            deployment.resource_data
            if isinstance(deployment.resource_data, dict)
            else {}
        )
        if resource_data.get("failure_active") is True:
            continue

        role_tag = normalize_resource_role_tag(resource_data.get("role"))
        center = geometry_center(deployment.geometry_type, deployment.geometry)

        runtime_entry = clone_json_dict(vehicle_runtime.get(str(vehicle_id)))
        capacity_l = fallback_vehicle_water_capacity(vehicle_by_id.get(vehicle_id))
        water_remaining_l = as_float(runtime_entry.get("water_remaining_l"), capacity_l)
        water_remaining_l = max(0.0, min(capacity_l, water_remaining_l))

        vehicle_entries.append(
            {
                "vehicle_id": vehicle_id,
                "role": role_tag,
                "center": center,
                "capacity_l": capacity_l,
                "water_remaining_l": water_remaining_l,
            }
        )

    nozzle_entries: list[dict[str, Any]] = []
    nozzle_runtime: dict[str, Any] = {}
    for deployment in deployments:
        if deployment.resource_kind != ResourceKind.NOZZLE:
            continue
        if deployment.status != DeploymentStatus.ACTIVE:
            continue

        resource_data = (
            deployment.resource_data
            if isinstance(deployment.resource_data, dict)
            else {}
        )
        if resource_data.get("plan_only") is True:
            continue

        role_tag = normalize_resource_role_tag(resource_data.get("role"))
        pressure = as_float(resource_data.get("pressure"), 60.0)
        pressure = max(20.0, min(100.0, pressure))
        spray_angle = as_float(resource_data.get("spray_angle"), 0.0)
        spray_angle = max(0.0, min(90.0, spray_angle))

        nozzle_type = str(resource_data.get("nozzle_type") or "DEFAULT").strip().upper()
        nozzle_spec = PhysicsCfg.NOZZLE_TYPES.get(
            nozzle_type, PhysicsCfg.NOZZLE_TYPES["DEFAULT"]
        )
        nozzle_flow_min, nozzle_flow_max, nozzle_flow_default, nozzle_efficiency = (
            nozzle_spec
        )
        flow_source = (
            resource_data.get("nozzle_flow_l_s")
            or resource_data.get("intensity_l_s")
            or resource_data.get("flow_l_s")
        )
        flow_l_s = as_float(
            flow_source,
            nozzle_flow_default if flow_source is not None else 2.4 + pressure * 0.045,
        )
        flow_l_s *= 1.0 + spray_angle / 140.0
        flow_l_s = max(nozzle_flow_min, min(nozzle_flow_max, flow_l_s))
        flow_l_s = max(PhysicsCfg.NOZZLE_FLOW_MIN, min(PhysicsCfg.NOZZLE_FLOW_MAX, flow_l_s))

        suppression_factor = (pressure / 60.0) * (1.25 - spray_angle / 140.0) * nozzle_efficiency
        suppression_factor = max(0.5, min(1.8, suppression_factor))
        center = geometry_center(deployment.geometry_type, deployment.geometry)

        strict_chain = as_bool(resource_data.get("strict_chain"), False)
        linked_hose_line_id = as_non_empty_string(
            resource_data.get("linked_hose_line_id")
            or resource_data.get("hose_line_deployment_id")
        )
        linked_hose_line_chain_id = as_non_empty_string(
            resource_data.get("linked_hose_line_chain_id")
            or resource_data.get("hose_line_chain_id")
        )
        linked_vehicle_id = as_non_negative_int(resource_data.get("linked_vehicle_id"))

        nozzle_id = str(deployment.id)

        nozzle_entries.append(
            {
                "deployment_id": nozzle_id,
                "role": role_tag,
                "flow_l_s": flow_l_s,
                "center": center,
                "strict_chain": strict_chain,
                "linked_hose_line_id": linked_hose_line_id,
                "linked_hose_line_chain_id": linked_hose_line_chain_id,
                "linked_vehicle_id": linked_vehicle_id,
                "pressure": pressure,
                "spray_angle": spray_angle,
                "nozzle_type": nozzle_type,
                "suppression_factor": suppression_factor,
            }
        )
        nozzle_runtime[nozzle_id] = {
            "strict_chain": strict_chain,
            "linked_hose_line_id": linked_hose_line_id,
            "linked_hose_line_chain_id": linked_hose_line_chain_id,
            "linked_vehicle_id": linked_vehicle_id,
            "has_water": False,
            "updated_at": tick_time.isoformat(),
            "pressure": round(pressure, 2),
            "spray_angle": round(spray_angle, 2),
            "nozzle_type": nozzle_type,
        }

    consumed_water_l = 0.0
    effective_flow_l_s = 0.0
    suppression_effective_flow_l_s = 0.0
    nozzle_with_water_centers: list[tuple[float, float]] = []
    vehicle_total_flow: dict[str, float] = {}

    splitter_nozzle_count: dict[str, int] = {}
    for nozzle in nozzle_entries:
        linked_hose_line_id = as_non_empty_string(nozzle.get("linked_hose_line_id"))
        linked_hose_chain_id = as_non_empty_string(
            nozzle.get("linked_hose_line_chain_id")
        )
        linked_hose_entry = (
            hose_entries_by_id.get(linked_hose_line_id) if linked_hose_line_id else None
        )
        if linked_hose_entry is None and linked_hose_chain_id:
            linked_hose_entry = hose_entries_by_chain_id.get(linked_hose_chain_id)
        if linked_hose_entry is None:
            continue
        splitter_id = as_non_empty_string(linked_hose_entry.get("linked_splitter_id"))
        if not splitter_id:
            continue
        splitter_nozzle_count[splitter_id] = (
            splitter_nozzle_count.get(splitter_id, 0) + 1
        )

    for nozzle in nozzle_entries:
        nozzle_id = as_non_empty_string(nozzle.get("deployment_id"))
        role_tag = str(nozzle["role"])
        strict_chain = as_bool(nozzle.get("strict_chain"), False)

        linked_hose_entry: dict[str, Any] | None = None
        linked_vehicle_id = as_non_negative_int(nozzle.get("linked_vehicle_id"))
        branch_pressure_factor = 1.0

        candidates: list[dict[str, Any]] = []
        if strict_chain:
            linked_hose_line_id = as_non_empty_string(nozzle.get("linked_hose_line_id"))
            linked_hose_chain_id = as_non_empty_string(
                nozzle.get("linked_hose_line_chain_id")
            )

            if linked_hose_line_id:
                linked_hose_entry = hose_entries_by_id.get(linked_hose_line_id)
            if linked_hose_entry is None and linked_hose_chain_id:
                linked_hose_entry = hose_entries_by_chain_id.get(linked_hose_chain_id)

            if linked_hose_entry is None:
                if nozzle_id in nozzle_runtime:
                    nozzle_runtime[nozzle_id]["blocked_reason"] = "NO_LINKED_HOSE"
                continue

            hose_linked_vehicle_id = as_non_negative_int(
                linked_hose_entry.get("linked_vehicle_id")
            )
            target_vehicle_id = linked_vehicle_id or hose_linked_vehicle_id
            if target_vehicle_id in {None, 0}:
                if nozzle_id in nozzle_runtime:
                    nozzle_runtime[nozzle_id]["blocked_reason"] = "NO_LINKED_VEHICLE"
                continue

            linked_vehicle_id = target_vehicle_id

            splitter_id = as_non_empty_string(
                linked_hose_entry.get("linked_splitter_id")
            )
            if splitter_id:
                splitter_entry = splitter_entries_by_id.get(splitter_id)
                if splitter_entry is None:
                    if nozzle_id in nozzle_runtime:
                        nozzle_runtime[nozzle_id]["blocked_reason"] = (
                            "NO_LINKED_SPLITTER"
                        )
                    continue
                split_vehicle_id = as_non_negative_int(
                    splitter_entry.get("linked_vehicle_id")
                )
                if split_vehicle_id not in {None, 0}:
                    linked_vehicle_id = split_vehicle_id
                branches = max(1, splitter_nozzle_count.get(splitter_id, 1))
                branch_pressure_factor = 1.0 / math.sqrt(float(branches))

            candidates = [
                entry
                for entry in vehicle_entries
                if int(entry["vehicle_id"])
                == int(linked_vehicle_id or target_vehicle_id)
                and entry["water_remaining_l"] > 0
            ]
        else:
            candidates = [
                entry
                for entry in vehicle_entries
                if (not role_tag or entry["role"] == role_tag)
                and entry["water_remaining_l"] > 0
            ]

        if not candidates:
            if nozzle_id in nozzle_runtime:
                nozzle_runtime[nozzle_id]["blocked_reason"] = "NO_WATER_SOURCE"
            continue

        nozzle_center_point = normalize_point_tuple(nozzle.get("center"))
        if nozzle_center_point is not None:
            nozzle_origin = cast(tuple[float, float], nozzle_center_point)

            def candidate_distance(entry: dict[str, Any]) -> float:
                entry_center = normalize_point_tuple(entry.get("center"))
                if entry_center is None:
                    return 999999.0
                return distance_m(nozzle_origin, entry_center)

            candidates.sort(key=candidate_distance)

        target_vehicle = candidates[0]
        demand_l = float(nozzle["flow_l_s"]) * dt_game_sec
        if demand_l <= 0:
            continue

        nozzle_pressure = as_float(nozzle.get("pressure"), 60.0)
        nozzle_pressure = max(20.0, min(100.0, nozzle_pressure))
        line_loss_bar = 0.0
        line_length_m = 0.0
        hose_type = ""
        if linked_hose_entry is not None:
            line_length_m = as_float(linked_hose_entry.get("length_m"), 20.0)
            hose_type = normalize_hose_type(linked_hose_entry.get("hose_type"))
            line_loss_bar = hose_pressure_loss_bar(
                flow_l_s=float(nozzle["flow_l_s"]),
                length_m=line_length_m,
                hose_type=hose_type,
            )
        available_pressure_bar = max(
            0.0, (nozzle_pressure * branch_pressure_factor) - line_loss_bar
        )
        pressure_factor = (
            available_pressure_bar / nozzle_pressure if nozzle_pressure > 0 else 0.0
        )
        if pressure_factor < 0.12:
            if nozzle_id in nozzle_runtime:
                nozzle_runtime[nozzle_id]["blocked_reason"] = "NO_PRESSURE"
                nozzle_runtime[nozzle_id]["line_loss_bar"] = round(line_loss_bar, 3)
                nozzle_runtime[nozzle_id]["available_pressure_bar"] = round(
                    available_pressure_bar, 3
                )
                nozzle_runtime[nozzle_id]["branch_pressure_factor"] = round(
                    branch_pressure_factor, 3
                )
            continue

        available_l = float(target_vehicle["water_remaining_l"])
        actual_l = min(available_l, demand_l)
        if actual_l <= 0:
            if nozzle_id in nozzle_runtime:
                nozzle_runtime[nozzle_id]["blocked_reason"] = "NO_WATER_SOURCE"
            continue

        target_vehicle["water_remaining_l"] = max(0.0, available_l - actual_l)
        consumed_water_l += actual_l
        effective_ratio = actual_l / demand_l
        effective_flow = float(nozzle["flow_l_s"]) * effective_ratio * pressure_factor
        suppression_factor = as_float(nozzle.get("suppression_factor"), 1.0)
        effective_flow_l_s += effective_flow
        suppression_effective_flow_l_s += effective_flow * suppression_factor
        if nozzle_center_point is not None:
            nozzle_with_water_centers.append(nozzle_center_point)
        vehicle_key = str(int(target_vehicle["vehicle_id"]))
        vehicle_total_flow[vehicle_key] = (
            vehicle_total_flow.get(vehicle_key, 0.0) + effective_flow
        )

        if nozzle_id in nozzle_runtime:
            nozzle_runtime[nozzle_id]["has_water"] = True
            nozzle_runtime[nozzle_id]["blocked_reason"] = None
            nozzle_runtime[nozzle_id]["effective_flow_l_s"] = round(effective_flow, 3)
            nozzle_runtime[nozzle_id]["suppression_factor"] = round(
                suppression_factor, 3
            )
            nozzle_runtime[nozzle_id]["line_loss_bar"] = round(line_loss_bar, 3)
            nozzle_runtime[nozzle_id]["available_pressure_bar"] = round(
                available_pressure_bar, 3
            )
            nozzle_runtime[nozzle_id]["branch_pressure_factor"] = round(
                branch_pressure_factor, 3
            )
            nozzle_runtime[nozzle_id]["pressure_factor"] = round(pressure_factor, 3)
            if line_length_m > 0:
                nozzle_runtime[nozzle_id]["line_length_m"] = round(line_length_m, 2)
            if hose_type:
                nozzle_runtime[nozzle_id]["hose_type"] = hose_type
            nozzle_runtime[nozzle_id]["linked_vehicle_id"] = int(
                target_vehicle["vehicle_id"]
            )

        if linked_hose_entry is not None:
            hose_id = as_non_empty_string(linked_hose_entry.get("deployment_id"))
            if nozzle_id in nozzle_runtime:
                nozzle_runtime[nozzle_id]["linked_hose_line_id"] = hose_id
                nozzle_runtime[nozzle_id]["linked_hose_line_chain_id"] = (
                    as_non_empty_string(linked_hose_entry.get("chain_id"))
                )
            if hose_id in hose_runtime:
                hose_runtime[hose_id]["has_water"] = True
                hose_runtime[hose_id]["linked_vehicle_id"] = int(
                    target_vehicle["vehicle_id"]
                )

    for vehicle_entry in vehicle_entries:
        vehicle_id = int(vehicle_entry["vehicle_id"])
        capacity_l = float(vehicle_entry["capacity_l"])
        remaining_l = max(0.0, float(vehicle_entry["water_remaining_l"]))
        vehicle_flow_l_s = vehicle_total_flow.get(str(vehicle_id), 0.0)
        minutes_until_empty: float | None
        if vehicle_flow_l_s > 0 and remaining_l > 0:
            minutes_until_empty = round((remaining_l / vehicle_flow_l_s) / 60.0, 1)
        else:
            minutes_until_empty = None
        vehicle_runtime[str(vehicle_id)] = {
            "water_capacity_l": round(capacity_l, 2),
            "water_remaining_l": round(remaining_l, 2),
            "is_empty": remaining_l <= 0.01,
            "minutes_until_empty": minutes_until_empty,
            "updated_at": tick_time.isoformat(),
        }

    active_fire_objects = [
        fire
        for fire in fire_objects
        if fire.is_active
        and fire.kind in {FireZoneKind.FIRE_SEAT, FireZoneKind.FIRE_ZONE}
    ]
    smoke_objects = [
        fire
        for fire in fire_objects
        if fire.is_active and fire.kind == FireZoneKind.SMOKE_ZONE
    ]

    if active_fire_objects and not smoke_objects:
        source = active_fire_objects[0]
        smoke = FireObject(
            state_id=snapshot.id,
            name=f"Дым от {source.name}"[:255],
            kind=FireZoneKind.SMOKE_ZONE,
            geometry_type=source.geometry_type,
            geometry=source.geometry,
            area_m2=max(25.0, float(source.area_m2 or 25.0) * 1.2),
            perimeter_m=None,
            spread_speed_m_min=max(0.8, float(source.spread_speed_m_min or 1.0) * 0.65),
            spread_azimuth=source.spread_azimuth,
            is_active=True,
            extra={
                "source": "ws:runtime_auto_smoke",
                "generated_at": tick_time.isoformat(),
            },
        )
        db.add(smoke)
        smoke_objects.append(smoke)

    weather = session_obj.weather if isinstance(session_obj.weather, dict) else {}
    wind_speed = max(0.0, as_float(weather.get("wind_speed"), 5.0))
    wind_dir = as_float(weather.get("wind_dir"), 90.0) % 360.0
    temperature = as_float(weather.get("temperature", weather.get("temp")), 20.0)
    humidity_raw = as_float(weather.get("humidity"), 45.0)
    humidity = max(0.0, min(100.0, humidity_raw))
    precipitation = str(weather.get("precipitation") or "").strip().lower()

    temp_factor = max(
        PhysicsCfg.TEMP_FACTOR_MIN,
        min(
            PhysicsCfg.TEMP_FACTOR_MAX,
            1.0 + (temperature - PhysicsCfg.TEMP_BASE_C) * PhysicsCfg.TEMP_FACTOR_PER_C,
        ),
    )
    humidity_factor = max(
        PhysicsCfg.HUMIDITY_FACTOR_MIN,
        min(
            PhysicsCfg.HUMIDITY_FACTOR_MAX,
            1.0
            - (humidity - PhysicsCfg.HUMIDITY_BASE_PCT)
            * PhysicsCfg.HUMIDITY_FACTOR_PER_PCT,
        ),
    )
    wind_factor = 1.0 + min(
        PhysicsCfg.WIND_FACTOR_CAP,
        wind_speed / PhysicsCfg.WIND_NORMALIZATION_MS,
    )
    precipitation_factor = 1.0
    if precipitation in {"rain", "drizzle", "snow", "hail", "storm"}:
        precipitation_factor = PhysicsCfg.PRECIPITATION_HEAVY_GROWTH_FACTOR
    elif precipitation in {"mist", "fog"}:
        precipitation_factor = PhysicsCfg.PRECIPITATION_LIGHT_GROWTH_FACTOR

    weather_growth_factor = (
        wind_factor * temp_factor * humidity_factor * precipitation_factor
    )
    weather_growth_factor = max(
        PhysicsCfg.GROWTH_FACTOR_MIN,
        min(PhysicsCfg.GROWTH_FACTOR_MAX, weather_growth_factor),
    )

    suppression_weather_boost = 1.0
    if precipitation in {"rain", "drizzle", "snow", "hail", "storm"}:
        suppression_weather_boost = (
            PhysicsCfg.PRECIPITATION_HEAVY_SUPPRESSION_BOOST
        )
    containment_polygons = extract_containment_polygons_from_scene(snapshot_data)

    suppression_budget_area = (
        suppression_effective_flow_l_s
        * PhysicsCfg.SUPPRESSION_FLOW_COEFF
        * dt_game_sec
        * suppression_weather_boost
    )

    fire_weights: dict[str, float] = {}
    fire_directions: dict[str, dict[str, Any]] = {}
    for fire in active_fire_objects:
        current_area = max(5.0, as_float(fire.area_m2, 25.0))
        center = normalize_point_tuple(
            geometry_center(fire.geometry_type, fire.geometry)
        )
        proximity_boost = 1.0
        if center is not None and nozzle_with_water_centers:
            influence = sum(
                1.0
                / (
                    PhysicsCfg.PROXIMITY_DISTANCE_DENOM
                    + distance_m(center, nozzle_center)
                )
                for nozzle_center in nozzle_with_water_centers
            )
            proximity_boost += influence * PhysicsCfg.PROXIMITY_SCALE
        fire_extra = clone_json_dict(fire.extra)
        fire_rank = as_non_negative_int(fire_extra.get("fire_rank"), 1)
        if fire_rank is None:
            fire_rank = 1
        fire_rank = max(1, min(5, fire_rank))
        fire_power = as_float(fire_extra.get("fire_power"), 1.0)
        fire_power = max(0.35, min(4.0, fire_power))
        fire_weights[str(fire.id)] = (
            current_area
            * proximity_boost
            * (
                PhysicsCfg.FIRE_WEIGHT_RANK_BASE
                + fire_rank * PhysicsCfg.FIRE_WEIGHT_RANK_COEFF
            )
            * (
                PhysicsCfg.FIRE_WEIGHT_POWER_BASE
                + fire_power * PhysicsCfg.FIRE_WEIGHT_POWER_COEFF
            )
        )

    total_fire_weight = sum(fire_weights.values())
    post_fire_area_sum = 0.0

    for fire in active_fire_objects:
        current_area = max(3.0, as_float(fire.area_m2, 25.0))
        fire_extra = fire.extra if isinstance(fire.extra, dict) else {}
        max_area_m2 = as_float(fire_extra.get("max_area_m2"), 0.0)
        fire_center = normalize_point_tuple(
            geometry_center(fire.geometry_type, fire.geometry)
        )
        if fire_center is not None and containment_polygons:
            for polygon_points, polygon_area in containment_polygons:
                if point_inside_polygon(fire_center, polygon_points):
                    max_area_m2 = (
                        min(max_area_m2, polygon_area)
                        if max_area_m2 > 0
                        else polygon_area
                    )
                    break
        if max_area_m2 > 0:
            max_area_m2 = max(4.0, min(20000.0, max_area_m2))
        else:
            max_area_m2 = max(
                PhysicsCfg.FIRE_MIN_AREA,
                min(
                    PhysicsCfg.BUILDING_AREA_FALLBACK_GLOBAL,
                    current_area + PhysicsCfg.BUILDING_AREA_FALLBACK_PER,
                ),
            )
        spread_speed = max(
            0.25,
            as_float(
                fire.spread_speed_m_min,
                (
                    PhysicsCfg.FIRE_SEAT_DEFAULT_SPEED
                    if fire.kind == FireZoneKind.FIRE_SEAT
                    else PhysicsCfg.FIRE_ZONE_DEFAULT_SPEED
                ),
            ),
        )

        fire_rank = as_non_negative_int(fire_extra.get("fire_rank"), 1)
        if fire_rank is None:
            fire_rank = 1
        fire_rank = max(1, min(5, fire_rank))
        fire_power = as_float(fire_extra.get("fire_power"), 1.0)
        fire_power = max(0.35, min(4.0, fire_power))
        spread_azimuth = as_float(fire.spread_azimuth, wind_dir)
        azimuth_delta = abs(((spread_azimuth - wind_dir + 180.0) % 360.0) - 180.0)
        wind_alignment_factor = PhysicsCfg.WIND_ALIGN_MIN + PhysicsCfg.WIND_ALIGN_RANGE * (
            1.0 - azimuth_delta / 180.0
        )
        rank_growth_factor = (
            PhysicsCfg.RANK_GROWTH_BASE + fire_rank * PhysicsCfg.RANK_GROWTH_PER_RANK
        )
        power_growth_factor = (
            PhysicsCfg.POWER_GROWTH_BASE
            + fire_power * PhysicsCfg.POWER_GROWTH_PER_UNIT
        )
        growth_factor = (
            weather_growth_factor
            * wind_alignment_factor
            * rank_growth_factor
            * power_growth_factor
        )
        growth_factor = max(
            PhysicsCfg.GROWTH_FACTOR_MIN,
            min(PhysicsCfg.GROWTH_FACTOR_MAX, growth_factor),
        )
        fire_kind_key = (
            fire.kind.value if isinstance(fire.kind, FireZoneKind) else str(fire.kind)
        )
        growth_rate = PhysicsCfg.FIRE_GROWTH_RATE.get(
            fire_kind_key, PhysicsCfg.FIRE_GROWTH_RATE_DEFAULT
        )
        area_growth = spread_speed * growth_rate * dt_game_sec * growth_factor

        suppression_share = 0.0
        if total_fire_weight > 0 and suppression_budget_area > 0:
            suppression_share = suppression_budget_area * (
                fire_weights.get(str(fire.id), 0.0) / total_fire_weight
            )

        suppression_resistance = (
            PhysicsCfg.SUPPRESSION_RESIST_RANK_BASE
            + (fire_rank - 1) * PhysicsCfg.SUPPRESSION_RESIST_RANK_PER
        ) * (
            PhysicsCfg.SUPPRESSION_RESIST_POWER_BASE
            + fire_power * PhysicsCfg.SUPPRESSION_RESIST_POWER_COEFF
        )
        effective_suppression = suppression_share / max(
            PhysicsCfg.SUPPRESSION_RESIST_MIN, suppression_resistance
        )

        next_area = max(0.0, current_area + area_growth - effective_suppression)
        if max_area_m2 > 0:
            next_area = min(next_area, max_area_m2)
        fire.area_m2 = round(next_area, 2)
        fire.perimeter_m = (
            round(2.0 * math.sqrt(math.pi * next_area), 2) if next_area > 0 else 0.0
        )
        fire.spread_speed_m_min = round(
            max(
                0.2,
                spread_speed
                + wind_speed * 0.01
                + (fire_rank - 1) * 0.03
                + (fire_power - 1.0) * 0.08
                - effective_suppression * 0.015,
            ),
            3,
        )
        fire.is_active = next_area > PhysicsCfg.FIRE_ACTIVE_AREA_THRESHOLD

        extra = clone_json_dict(fire.extra)
        if max_area_m2 > 0:
            extra["max_area_m2"] = round(max_area_m2, 2)
        extra["runtime"] = {
            "updated_at": tick_time.isoformat(),
            "suppression_area_m2": round(effective_suppression, 2),
            "growth_area_m2": round(area_growth, 2),
            "growth_factor": round(growth_factor, 3),
            "fire_rank": fire_rank,
            "fire_power": round(fire_power, 3),
            "weather_growth_factor": round(weather_growth_factor, 3),
        }
        fire.extra = extra
        fire_directions[str(fire.id)] = {
            "direction_deg": round(float(spread_azimuth) % 360.0, 2),
            "area_m2": round(next_area, 2),
        }

        if fire.is_active:
            post_fire_area_sum += next_area

    for smoke in smoke_objects:
        current_area = max(PhysicsCfg.SMOKE_MIN_AREA, as_float(smoke.area_m2, 32.0))
        smoke_extra = smoke.extra if isinstance(smoke.extra, dict) else {}
        smoke_max_area_m2 = as_float(smoke_extra.get("max_area_m2"), 0.0)
        if smoke_max_area_m2 <= 0 and post_fire_area_sum > 0:
            smoke_max_area_m2 = post_fire_area_sum * 1.6
        if smoke_max_area_m2 > 0:
            smoke_max_area_m2 = max(8.0, min(26000.0, smoke_max_area_m2))
        spread_speed = max(
            PhysicsCfg.SMOKE_MIN_SPEED,
            as_float(smoke.spread_speed_m_min, 1.2),
        )

        smoke_weather_factor = max(
            0.55,
            min(
                1.9,
                (0.85 + min(0.5, wind_speed / 16.0))
                * (0.9 + (temp_factor - 1.0) * 0.6)
                * (0.95 + (1.0 - humidity_factor) * 0.4),
            ),
        )

        smoke_growth = (
            post_fire_area_sum * PhysicsCfg.SMOKE_GROWTH_COEFF
            + spread_speed * PhysicsCfg.SMOKE_DRIFT_COEFF
            + wind_speed * PhysicsCfg.SMOKE_WIND_COEFF
        ) * dt_game_sec * smoke_weather_factor
        smoke_dissipation = suppression_budget_area * PhysicsCfg.SMOKE_SUPPRESSION_COEFF
        if precipitation_factor < 1.0:
            smoke_dissipation *= 1.15

        next_area = max(PhysicsCfg.SMOKE_MIN_AREA, current_area + smoke_growth - smoke_dissipation)
        if smoke_max_area_m2 > 0:
            next_area = min(next_area, smoke_max_area_m2)
        smoke.area_m2 = round(next_area, 2)
        smoke.perimeter_m = round(2.0 * math.sqrt(math.pi * next_area), 2)
        smoke.spread_speed_m_min = round(
            max(PhysicsCfg.SMOKE_MIN_SPEED, spread_speed + wind_speed * 0.006),
            3,
        )
        smoke.is_active = (
            post_fire_area_sum > PhysicsCfg.SMOKE_ACTIVE_FIRE_AREA_THRESHOLD
            or next_area > PhysicsCfg.SMOKE_ACTIVE_AREA_THRESHOLD
        )

        extra = clone_json_dict(smoke.extra)
        extra["runtime"] = {
            "updated_at": tick_time.isoformat(),
            "growth_area_m2": round(smoke_growth, 2),
            "dissipation_area_m2": round(smoke_dissipation, 2),
            "smoke_weather_factor": round(smoke_weather_factor, 3),
        }
        smoke.extra = extra

    q_required_l_s = 0.0
    for fire in active_fire_objects:
        if not fire.is_active:
            continue
        q_norm = Q_NORM_L_S_M2.get(
            fire.kind,
            PhysicsCfg.Q_NORM_L_S_M2.get("default", 0.06),
        )
        q_required_l_s += q_norm * max(0.0, float(fire.area_m2 or 0.0))
    suppression_ratio = (
        effective_flow_l_s / q_required_l_s if q_required_l_s > 0 else 0.0
    )
    if suppression_ratio < FORECAST_GROWING_THRESHOLD:
        forecast = "growing"
    elif suppression_ratio < FORECAST_STABLE_THRESHOLD:
        forecast = "stable"
    else:
        forecast = "suppressed"

    fire_runtime["vehicle_runtime"] = vehicle_runtime
    fire_runtime["hose_runtime"] = hose_runtime
    fire_runtime["nozzle_runtime"] = nozzle_runtime
    fire_runtime["fire_directions"] = fire_directions
    fire_runtime["q_required_l_s"] = round(q_required_l_s, 3)
    fire_runtime["q_effective_l_s"] = round(effective_flow_l_s, 3)
    fire_runtime["suppression_ratio"] = round(suppression_ratio, 3)
    fire_runtime["forecast"] = forecast
    fire_runtime["updated_at"] = tick_time.isoformat()
    fire_runtime["schema_version"] = FIRE_RUNTIME_SCHEMA_VERSION
    fire_runtime["active_fire_objects"] = sum(
        1
        for fire in fire_objects
        if fire.is_active
        and fire.kind in {FireZoneKind.FIRE_SEAT, FireZoneKind.FIRE_ZONE}
    )
    fire_runtime["active_smoke_objects"] = sum(
        1
        for fire in fire_objects
        if fire.is_active and fire.kind == FireZoneKind.SMOKE_ZONE
    )
    fire_runtime["active_nozzles"] = len(nozzle_entries)
    fire_runtime["wet_nozzles"] = sum(
        1
        for item in nozzle_runtime.values()
        if isinstance(item, dict) and item.get("has_water") is True
    )
    fire_runtime["wet_hose_lines"] = sum(
        1
        for item in hose_runtime.values()
        if isinstance(item, dict) and item.get("has_water") is True
    )
    fire_runtime["effective_flow_l_s"] = round(effective_flow_l_s, 3)
    fire_runtime["consumed_water_l_tick"] = round(consumed_water_l, 2)
    fire_runtime["environment"] = {
        "wind_speed": round(wind_speed, 2),
        "wind_dir": round(wind_dir, 2),
        "temperature": round(temperature, 2),
        "humidity": round(humidity, 2),
        "precipitation": precipitation,
        "weather_growth_factor": round(weather_growth_factor, 3),
        "suppression_weather_boost": round(suppression_weather_boost, 3),
    }

    snapshot_data["fire_runtime"] = fire_runtime


def apply_lesson_runtime_tick_for_session(
    db,
    session_obj: SimulationSession,
) -> bool:
    if session_obj.status != SessionStatus.IN_PROGRESS:
        return False

    snapshot = get_or_create_current_snapshot(db, session_obj.id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    lesson_state = clone_json_dict(snapshot_data.get("training_lesson"))
    lifecycle_status = normalize_lesson_lifecycle_status(
        lesson_state.get("lifecycle_status"), lesson_state.get("status")
    )
    if lifecycle_status != LESSON_LIFECYCLE_RUNNING:
        return False
    lesson_state["lifecycle_status"] = LESSON_LIFECYCLE_RUNNING
    lesson_state["status"] = lesson_legacy_status_from_lifecycle(
        LESSON_LIFECYCLE_RUNNING
    )

    tick_time = utcnow()
    started_at = parse_iso_datetime_utc(lesson_state.get("started_at")) or tick_time
    last_tick_at = (
        parse_iso_datetime_utc(lesson_state.get("last_tick_at")) or started_at
    )

    raw_delta_real_sec = int((tick_time - last_tick_at).total_seconds())
    if raw_delta_real_sec <= 0:
        return False
    delta_real_sec = min(raw_delta_real_sec, SIMULATION_MAX_STEP_REAL_SEC)
    dropped_ticks_last = max(0, raw_delta_real_sec - delta_real_sec)
    tick_lag_sec = max(0.0, float(raw_delta_real_sec) - SIMULATION_LOOP_INTERVAL_SEC)

    time_multiplier = as_float(session_obj.time_multiplier, 1.0)
    time_multiplier = max(0.1, min(30.0, time_multiplier))
    delta_game_sec = max(1, int(round(delta_real_sec * time_multiplier)))

    elapsed_game_sec = parse_optional_non_negative_int(
        lesson_state.get("elapsed_game_sec"), "training_lesson.elapsed_game_sec"
    )
    if elapsed_game_sec is None:
        elapsed_game_sec = 0
    elapsed_game_sec += delta_game_sec

    start_sim_time_seconds = parse_optional_non_negative_int(
        lesson_state.get("start_sim_time_seconds"),
        "training_lesson.start_sim_time_seconds",
    )
    if start_sim_time_seconds is None:
        start_sim_time_seconds = snapshot.sim_time_seconds

    lesson_state["elapsed_game_sec"] = elapsed_game_sec
    lesson_state["last_tick_at"] = tick_time.isoformat()
    lesson_state["start_sim_time_seconds"] = start_sim_time_seconds
    snapshot.sim_time_seconds = start_sim_time_seconds + elapsed_game_sec

    apply_fire_dynamics_tick(
        db,
        snapshot,
        session_obj,
        snapshot_data,
        delta_game_sec,
        tick_time,
    )
    fire_runtime = ensure_fire_runtime(snapshot_data)
    runtime_health = clone_json_dict(fire_runtime.get("runtime_health"))
    ticks_total = as_non_negative_int(runtime_health.get("ticks_total"), 0) or 0
    dropped_total = (
        as_non_negative_int(runtime_health.get("dropped_ticks_total"), 0) or 0
    )
    runtime_health["ticks_total"] = ticks_total + 1
    runtime_health["dropped_ticks_last"] = dropped_ticks_last
    runtime_health["dropped_ticks_total"] = dropped_total + dropped_ticks_last
    runtime_health["tick_lag_sec"] = round(tick_lag_sec, 3)
    runtime_health["last_tick_at"] = tick_time.isoformat()
    runtime_health["last_delta_real_sec"] = raw_delta_real_sec
    runtime_health["last_delta_game_sec"] = delta_game_sec
    runtime_health["loop_interval_sec"] = SIMULATION_LOOP_INTERVAL_SEC
    runtime_health["max_step_real_sec"] = SIMULATION_MAX_STEP_REAL_SEC
    fire_runtime["runtime_health"] = runtime_health
    fire_runtime["schema_version"] = FIRE_RUNTIME_SCHEMA_VERSION
    fire_runtime["updated_at"] = tick_time.isoformat()
    snapshot_data["fire_runtime"] = fire_runtime
    lesson_state["runtime_health"] = {
        "tick_lag_sec": round(tick_lag_sec, 3),
        "last_tick_at": tick_time.isoformat(),
        "dropped_ticks_last": dropped_ticks_last,
        "dropped_ticks_total": runtime_health["dropped_ticks_total"],
        "ticks_total": runtime_health["ticks_total"],
    }

    time_limit_sec = parse_optional_non_negative_int(
        lesson_state.get("time_limit_sec"), "training_lesson.time_limit_sec"
    )
    timeout_reached = bool(
        time_limit_sec is not None
        and time_limit_sec > 0
        and elapsed_game_sec >= time_limit_sec
    )

    if timeout_reached:
        lesson_state["lifecycle_status"] = LESSON_LIFECYCLE_COMPLETED
        lesson_state["status"] = lesson_legacy_status_from_lifecycle(
            LESSON_LIFECYCLE_COMPLETED
        )
        lesson_state["finished_at"] = tick_time.isoformat()
        lesson_state["finished_by"] = "SYSTEM"
        lesson_state["finished_by_user_id"] = None
        lesson_state["completed_reason"] = "timeout"
        session_obj.status = SessionStatus.COMPLETED

        radio_runtime = ensure_radio_runtime(snapshot_data)
        snapshot_data["lesson_result"] = {
            "status": "COMPLETED",
            "completed_at": tick_time.isoformat(),
            "completed_by": "SYSTEM",
            "completed_by_user_id": None,
            "session_id": str(session_obj.id),
            "reason": "lesson_timeout",
            "radio_summary": summarize_radio_logs_for_lesson(radio_runtime),
        }

    snapshot_data["training_lesson"] = lesson_state
    persist_training_scene(snapshot, snapshot_data, scene)
    return True


def assert_radio_channel_write_allowed(user: User, channel: str) -> None:
    allowed_roles = RADIO_CHANNEL_TX_ROLES.get(channel)
    if allowed_roles is None:
        raise HTTPException(status_code=400, detail="Unknown radio channel")

    user_roles = canonical_user_roles(user)
    if user_roles.intersection(allowed_roles):
        return

    raise HTTPException(
        status_code=403,
        detail=f"Role is not allowed to transmit on channel: {channel}",
    )


def pick_radio_actor_role(user: User) -> str:
    roles = canonical_user_roles(user)
    priority = [
        UserRole.ADMIN,
        UserRole.TRAINING_LEAD,
        UserRole.DISPATCHER,
        UserRole.RTP,
        UserRole.HQ,
        UserRole.COMBAT_AREA_1,
        UserRole.COMBAT_AREA_2,
    ]
    for role in priority:
        if role in roles:
            return role.value
    if roles:
        return sorted(role.value for role in roles)[0]
    return "UNKNOWN"


def ensure_radio_runtime(snapshot_data: dict[str, Any]) -> dict[str, Any]:
    raw_runtime = snapshot_data.get("radio_runtime")
    runtime = clone_json_dict(raw_runtime)

    logs_raw = runtime.get("logs")
    runtime["logs"] = (
        [item for item in logs_raw if isinstance(item, dict)]
        if isinstance(logs_raw, list)
        else []
    )

    runtime["interference"] = None

    channel_speakers_raw = runtime.get("channel_speakers")
    runtime["channel_speakers"] = (
        {
            str(channel): clone_json_dict(info)
            for channel, info in channel_speakers_raw.items()
            if isinstance(channel, str) and isinstance(info, dict)
        }
        if isinstance(channel_speakers_raw, dict)
        else {}
    )

    runtime["updated_at"] = runtime.get("updated_at") or utcnow().isoformat()
    snapshot_data["radio_runtime"] = runtime
    return runtime


def cleanup_radio_channel_speakers(
    runtime: dict[str, Any],
    now_dt: datetime,
) -> None:
    speakers_raw = runtime.get("channel_speakers")
    if not isinstance(speakers_raw, dict):
        runtime["channel_speakers"] = {}
        return

    valid: dict[str, dict[str, Any]] = {}
    for channel, info_raw in speakers_raw.items():
        if not isinstance(channel, str) or not isinstance(info_raw, dict):
            continue
        info = clone_json_dict(info_raw)
        last_seen_raw = info.get("last_seen_at")
        if not isinstance(last_seen_raw, str):
            continue
        last_seen_ms = parse_iso_timestamp_ms(last_seen_raw)
        if last_seen_ms is None:
            continue
        age_sec = max(0.0, (now_dt.timestamp() * 1000 - last_seen_ms) / 1000)
        if age_sec > RADIO_CHANNEL_HOLD_TIMEOUT_SEC:
            continue
        valid[channel] = info

    runtime["channel_speakers"] = valid


def reserve_radio_channel_or_raise(
    runtime: dict[str, Any],
    *,
    channel: str,
    user: User,
    transmission_id: str,
    now_dt: datetime,
) -> None:
    cleanup_radio_channel_speakers(runtime, now_dt)
    speakers = runtime.get("channel_speakers")
    if not isinstance(speakers, dict):
        speakers = {}
        runtime["channel_speakers"] = speakers

    current = speakers.get(channel)
    current_user_id = (
        str(current.get("user_id") or "") if isinstance(current, dict) else ""
    )
    current_tx_id = (
        str(current.get("transmission_id") or "") if isinstance(current, dict) else ""
    )

    if current_user_id and current_user_id != str(user.id):
        raise HTTPException(
            status_code=409,
            detail=f"Channel {channel} is busy by another speaker",
        )

    speakers[channel] = {
        "user_id": str(user.id),
        "username": user.username,
        "transmission_id": transmission_id,
        "last_seen_at": now_dt.isoformat(),
        "updated_at": now_dt.isoformat(),
    }

    if current_tx_id and current_tx_id != transmission_id:
        speakers[channel]["prev_transmission_id"] = current_tx_id


def release_radio_channel_if_owned(
    runtime: dict[str, Any],
    *,
    channel: str,
    user: User,
) -> None:
    speakers = runtime.get("channel_speakers")
    if not isinstance(speakers, dict):
        return
    current = speakers.get(channel)
    if not isinstance(current, dict):
        return
    if str(current.get("user_id") or "") != str(user.id):
        return
    speakers.pop(channel, None)


def compact_radio_runtime_logs(runtime: dict[str, Any]) -> None:
    logs_raw = runtime.get("logs")
    logs = (
        [item for item in logs_raw if isinstance(item, dict)]
        if isinstance(logs_raw, list)
        else []
    )

    compacted: list[dict[str, Any]] = []
    audio_kept = 0
    for item in logs:
        if (
            str(item.get("kind") or "") == "MESSAGE"
            and isinstance(item.get("audio_b64"), str)
            and bool(item.get("audio_b64"))
        ):
            audio_kept += 1
            if audio_kept > RADIO_LOG_AUDIO_WINDOW:
                sanitized = clone_json_dict(item)
                sanitized["audio_b64"] = ""
                compacted.append(sanitized)
                continue
        compacted.append(item)

    runtime["logs"] = compacted[:RADIO_LOG_LIMIT]


def append_radio_log(runtime: dict[str, Any], event: dict[str, Any]) -> None:
    logs_raw = runtime.get("logs")
    logs = (
        [item for item in logs_raw if isinstance(item, dict)]
        if isinstance(logs_raw, list)
        else []
    )
    runtime["logs"] = [event, *logs][:RADIO_LOG_LIMIT]
    compact_radio_runtime_logs(runtime)
    runtime["updated_at"] = utcnow().isoformat()


def append_dispatcher_journal_entry(
    snapshot_data: dict[str, Any],
    *,
    text: str,
    author: str | None,
) -> None:
    normalized_text = text.strip()
    if not normalized_text:
        return

    journal_raw = snapshot_data.get("dispatcher_journal")
    journal = (
        [item for item in journal_raw if isinstance(item, dict)]
        if isinstance(journal_raw, list)
        else []
    )

    now_dt = utcnow()
    now_iso = now_dt.isoformat()
    entry = {
        "id": f"jr_{uuid4().hex[:12]}",
        "text": normalized_text,
        "time": now_dt.strftime("%H:%M"),
        "created_at": now_iso,
        "author": author,
    }
    snapshot_data["dispatcher_journal"] = [entry, *journal][:RADIO_JOURNAL_LIMIT]


def patch_cached_radio_runtime(
    session_id: UUID,
    snapshot: SessionStateSnapshot,
) -> None:
    cached_payload = session_state_bundle_cache.get(session_id)
    if cached_payload is None:
        return

    next_payload = cast(
        dict[str, Any],
        json.loads(json.dumps(cached_payload, ensure_ascii=False)),
    )
    next_payload["snapshot"] = SessionStateSnapshotRead.model_validate(
        snapshot
    ).model_dump(mode="json")
    session_state_bundle_cache[session_id] = next_payload


def summarize_radio_logs_for_lesson(radio_runtime: dict[str, Any]) -> dict[str, Any]:
    logs_raw = radio_runtime.get("logs")
    logs = (
        [item for item in logs_raw if isinstance(item, dict)]
        if isinstance(logs_raw, list)
        else []
    )

    total_messages = 0
    total_audio = 0
    by_role: dict[str, int] = {}
    by_channel: dict[str, int] = {}
    seen_transmissions: set[str] = set()
    seen_audio_transmissions: set[str] = set()

    for log in logs:
        if str(log.get("kind") or "") != "MESSAGE":
            continue

        transmission_id = str(log.get("transmission_id") or "").strip()
        if not transmission_id:
            transmission_id = str(log.get("id") or "").strip()
        if not transmission_id:
            transmission_id = f"unknown_{uuid4().hex[:8]}"

        is_new_transmission = transmission_id not in seen_transmissions
        if is_new_transmission:
            seen_transmissions.add(transmission_id)
            total_messages += 1

        sender_role = str(log.get("sender_role") or "UNKNOWN")
        if is_new_transmission:
            by_role[sender_role] = by_role.get(sender_role, 0) + 1

        channel = parse_radio_channel(log.get("channel") or "1")
        if is_new_transmission:
            by_channel[channel] = by_channel.get(channel, 0) + 1

        has_audio = isinstance(log.get("audio_b64"), str) and bool(log.get("audio_b64"))
        if has_audio and transmission_id not in seen_audio_transmissions:
            seen_audio_transmissions.add(transmission_id)
            total_audio += 1

    return {
        "total_messages": total_messages,
        "audio_messages": total_audio,
        "by_role": by_role,
        "by_channel": by_channel,
    }


def parse_optional_radio_transcript(payload: dict[str, Any]) -> str | None:
    transcript_raw = payload.get("transcript_text")
    if not isinstance(transcript_raw, str) or not transcript_raw.strip():
        transcript_raw = payload.get("transcript")
    if not isinstance(transcript_raw, str):
        return None

    normalized = transcript_raw.strip()
    if not normalized:
        return None
    if len(normalized) > 4000:
        normalized = normalized[:4000]
    return normalized


def transcode_radio_audio_for_compat(
    audio_b64: str,
    mime_type: str,
) -> tuple[str, str, str]:
    normalized_mime = mime_type.lower().strip()
    needs_transcode = "webm" in normalized_mime or "ogg" in normalized_mime
    if not RADIO_AUDIO_TRANSCODE_ENABLED:
        return audio_b64, mime_type, "disabled"
    if not needs_transcode:
        return audio_b64, mime_type, "original"
    if not RADIO_AUDIO_TRANSCODE_FFMPEG_BIN:
        return audio_b64, mime_type, "ffmpeg_missing"

    try:
        source_bytes = base64.b64decode(audio_b64, validate=True)
    except Exception:
        return audio_b64, mime_type, "decode_error"

    if not source_bytes:
        return audio_b64, mime_type, "empty_audio"

    source_suffix = ".webm" if "webm" in normalized_mime else ".ogg"
    with tempfile.NamedTemporaryFile(suffix=source_suffix, delete=True) as source_file:
        source_file.write(source_bytes)
        source_file.flush()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as output_file:
            command = [
                RADIO_AUDIO_TRANSCODE_FFMPEG_BIN,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                source_file.name,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "wav",
                output_file.name,
            ]
            try:
                completed = subprocess.run(
                    command,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=RADIO_AUDIO_TRANSCODE_TIMEOUT_SEC,
                )
            except Exception:
                return audio_b64, mime_type, "ffmpeg_error"

            if completed.returncode != 0:
                return audio_b64, mime_type, "ffmpeg_error"

            try:
                converted_bytes = Path(output_file.name).read_bytes()
            except Exception:
                return audio_b64, mime_type, "ffmpeg_read_error"

    if not converted_bytes:
        return audio_b64, mime_type, "ffmpeg_empty"

    converted_b64 = base64.b64encode(converted_bytes).decode("ascii")
    if len(converted_b64) > RADIO_AUDIO_BASE64_MAX_LENGTH:
        return audio_b64, mime_type, "ffmpeg_too_large"

    return converted_b64, RADIO_AUDIO_TRANSCODE_TARGET_MIME, "ffmpeg_wav"


def transcribe_radio_audio_with_external_cmd(
    audio_b64: str,
    mime_type: str,
) -> tuple[str | None, str]:
    if not RADIO_TRANSCRIBE_CMD:
        return None, "none"

    try:
        audio_bytes = base64.b64decode(audio_b64, validate=True)
    except Exception:
        return None, "decode_error"

    if not audio_bytes:
        return None, "empty_audio"

    suffix = ".webm"
    normalized_mime = mime_type.lower().strip()
    if "ogg" in normalized_mime:
        suffix = ".ogg"
    elif "mp4" in normalized_mime or "aac" in normalized_mime:
        suffix = ".mp4"
    elif "wav" in normalized_mime:
        suffix = ".wav"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as temp_file:
        temp_file.write(audio_bytes)
        temp_file.flush()

        command = RADIO_TRANSCRIBE_CMD.replace("{file}", shlex.quote(temp_file.name))
        try:
            completed = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=RADIO_TRANSCRIBE_TIMEOUT_SEC,
                check=False,
            )
        except Exception:
            return None, "command_error"

        if completed.returncode != 0:
            return None, "command_error"

        transcript = completed.stdout.strip()
        if not transcript:
            return None, "empty_result"
        if len(transcript) > 4000:
            transcript = transcript[:4000]
        return transcript, "external_cmd"


async def run_radio_transcription_job(
    *,
    session_id: UUID,
    snapshot_id: UUID,
    transmission_row_id: UUID,
    event_id: str,
    channel: str,
    actor_role: str,
    username: str,
    audio_b64: str,
    mime_type: str,
) -> None:
    transcript_text, transcript_source = await asyncio.to_thread(
        transcribe_radio_audio_with_external_cmd,
        audio_b64,
        mime_type,
    )
    if not transcript_text:
        return

    with SessionLocal() as db:
        row = db.get(RadioTransmission, transmission_row_id)
        if row is None:
            return

        row_transcript = (row.transcript_text or "").strip()
        if row_transcript:
            return

        row.transcript_text = transcript_text
        row.transcript_source = transcript_source
        extra = clone_json_dict(row.extra)
        extra["transcript_async"] = True
        row.extra = extra

        snapshot = db.get(SessionStateSnapshot, snapshot_id)
        if snapshot is None:
            db.commit()
            return

        snapshot_data = clone_json_dict(snapshot.snapshot_data)
        runtime = ensure_radio_runtime(snapshot_data)
        logs_raw = runtime.get("logs")
        logs = (
            [item for item in logs_raw if isinstance(item, dict)]
            if isinstance(logs_raw, list)
            else []
        )
        for item in logs:
            if str(item.get("id") or "") != event_id:
                continue
            item["transcript_text"] = transcript_text
            item["transcript_source"] = transcript_source
            break

        append_dispatcher_journal_entry(
            snapshot_data,
            text=f"[РАЦИЯ {channel}] {actor_role}/{username}: {transcript_text}",
            author=username,
        )
        snapshot_data["radio_runtime"] = runtime
        snapshot.snapshot_data = snapshot_data

        db.commit()

    with SessionLocal() as db:
        latest_snapshot = db.get(SessionStateSnapshot, snapshot_id)
        if latest_snapshot is not None:
            patch_cached_radio_runtime(session_id, latest_snapshot)


def schedule_radio_transcription_job(**kwargs: Any) -> None:
    if not RADIO_TRANSCRIBE_CMD:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(run_radio_transcription_job(**kwargs))
    radio_transcription_tasks.add(task)
    task.add_done_callback(radio_transcription_tasks.discard)


def apply_push_radio_message_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data = clone_json_dict(snapshot.snapshot_data)
    runtime = ensure_radio_runtime(snapshot_data)

    channel = parse_radio_channel(payload.get("channel", "1"))
    assert_radio_channel_write_allowed(user, channel)

    text_raw = payload.get("text")
    text = str(text_raw).strip() if isinstance(text_raw, str) else ""
    if text:
        raise HTTPException(status_code=422, detail="Radio supports voice only")

    audio_b64_raw = payload.get("audio_b64")
    audio_b64 = str(audio_b64_raw).strip() if isinstance(audio_b64_raw, str) else ""
    if len(audio_b64) > RADIO_AUDIO_BASE64_MAX_LENGTH:
        raise HTTPException(
            status_code=413,
            detail="audio_b64 is too large",
        )

    if not audio_b64:
        raise HTTPException(status_code=422, detail="audio_b64 is required")

    mime_type_raw = payload.get("mime_type")
    mime_type = (
        str(mime_type_raw).strip()
        if isinstance(mime_type_raw, str) and mime_type_raw.strip()
        else "audio/webm"
    )
    if len(mime_type) > 64:
        raise HTTPException(status_code=422, detail="mime_type is too long")

    duration_ms = parse_optional_non_negative_int(
        payload.get("duration_ms"), "duration_ms"
    )
    if duration_ms is not None and duration_ms > 120_000:
        raise HTTPException(status_code=422, detail="duration_ms must be <= 120000")

    is_live_chunk = parse_optional_bool(payload.get("is_live_chunk"), "is_live_chunk")
    if is_live_chunk is None:
        is_live_chunk = False

    is_transmission_end = parse_optional_bool(
        payload.get("is_transmission_end"), "is_transmission_end"
    )
    if is_transmission_end is None:
        is_transmission_end = parse_optional_bool(
            payload.get("is_final_chunk"), "is_final_chunk"
        )
    if is_transmission_end is None:
        is_transmission_end = not is_live_chunk

    chunk_index = parse_optional_non_negative_int(
        payload.get("chunk_index"), "chunk_index"
    )

    transmission_id_raw = payload.get("transmission_id")
    transmission_id = (
        str(transmission_id_raw).strip() if isinstance(transmission_id_raw, str) else ""
    )
    if len(transmission_id) > 64:
        raise HTTPException(status_code=422, detail="transmission_id is too long")
    if not transmission_id:
        transmission_id = f"tx_{uuid4().hex[:12]}"

    now_dt = utcnow()
    reserve_radio_channel_or_raise(
        runtime,
        channel=channel,
        user=user,
        transmission_id=transmission_id,
        now_dt=now_dt,
    )

    original_mime_type = mime_type
    audio_b64, mime_type, audio_delivery_source = transcode_radio_audio_for_compat(
        audio_b64,
        mime_type,
    )

    actor_role = pick_radio_actor_role(user)
    transcript_text = parse_optional_radio_transcript(payload)
    transcript_source = "client" if transcript_text else "none"
    created_at_iso = now_dt.isoformat()

    event = {
        "id": f"radio_{uuid4().hex[:12]}",
        "kind": "MESSAGE",
        "channel": channel,
        "created_at": created_at_iso,
        "sender_user_id": str(user.id),
        "sender_username": user.username,
        "sender_role": actor_role,
        "text": "",
        "audio_b64": audio_b64,
        "mime_type": mime_type,
        "duration_ms": duration_ms,
        "is_live_chunk": is_live_chunk,
        "chunk_index": chunk_index,
        "transmission_id": transmission_id,
        "transcript_text": transcript_text,
        "transcript_source": transcript_source,
        "audio_delivery_source": audio_delivery_source,
        "source_mime_type": original_mime_type,
    }
    append_radio_log(runtime, event)

    transmission_row = RadioTransmission(
        session_id=session_id,
        snapshot_id=snapshot.id,
        sender_user_id=user.id,
        sender_username=user.username,
        sender_role=actor_role,
        channel=channel,
        transmission_id=transmission_id,
        chunk_index=chunk_index,
        is_live_chunk=is_live_chunk,
        mime_type=mime_type,
        duration_ms=duration_ms,
        audio_b64=audio_b64,
        transcript_text=transcript_text,
        transcript_source=transcript_source,
        extra={
            "source": "ws_push_radio_message",
            "source_mime_type": original_mime_type,
            "delivery_mime_type": mime_type,
            "audio_delivery_source": audio_delivery_source,
        },
    )
    db.add(transmission_row)
    db.flush()

    should_append_to_journal = not is_live_chunk or chunk_index in (None, 0)
    if should_append_to_journal and transcript_text:
        journal_text = (
            f"[РАЦИЯ {channel}] {actor_role}/{user.username}: {transcript_text}"
        )
        append_dispatcher_journal_entry(
            snapshot_data,
            text=journal_text,
            author=user.username,
        )

    should_schedule_transcription = (
        transcript_text is None
        and chunk_index in (None, 0)
        and bool(audio_b64)
        and bool(RADIO_TRANSCRIBE_CMD)
    )
    if should_schedule_transcription:
        schedule_radio_transcription_job(
            session_id=session_id,
            snapshot_id=snapshot.id,
            transmission_row_id=transmission_row.id,
            event_id=event["id"],
            channel=channel,
            actor_role=actor_role,
            username=user.username,
            audio_b64=audio_b64,
            mime_type=mime_type,
        )

    if is_transmission_end:
        release_radio_channel_if_owned(runtime, channel=channel, user=user)

    snapshot_data["radio_runtime"] = runtime
    snapshot.snapshot_data = snapshot_data

    patch_cached_radio_runtime(session_id, snapshot)


def apply_set_radio_interference_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data = clone_json_dict(snapshot.snapshot_data)
    runtime = ensure_radio_runtime(snapshot_data)
    runtime["interference"] = None
    snapshot_data["radio_runtime"] = runtime
    snapshot.snapshot_data = snapshot_data
    raise HTTPException(status_code=410, detail="Radio interference is disabled")


def remove_fire_objects_for_scene_object(db, snapshot_id: UUID, object_id: str) -> None:
    existing = (
        db.execute(select(FireObject).where(FireObject.state_id == snapshot_id))
        .scalars()
        .all()
    )
    for item in existing:
        extra = item.extra if isinstance(item.extra, dict) else {}
        if extra.get("scene_object_id") == object_id:
            db.delete(item)


def extract_scene_fire_runtime_params(
    scene_object: dict[str, Any], fire_kind: FireZoneKind
) -> dict[str, Any]:
    props_raw = scene_object.get("props")
    props = props_raw if isinstance(props_raw, dict) else {}

    def first_non_negative_float(*keys: str) -> float | None:
        for key in keys:
            value = as_float(props.get(key), float("nan"))
            if math.isfinite(value) and value >= 0:
                return value
        return None

    def first_finite_float(*keys: str) -> float | None:
        for key in keys:
            value = as_float(props.get(key), float("nan"))
            if math.isfinite(value):
                return value
        return None

    area_m2 = first_non_negative_float(
        "fire_area_m2",
        "area_m2",
        "smoke_area_m2",
    )

    spread_speed = first_non_negative_float(
        "spread_speed_m_min",
        "fire_spread_speed_m_min",
        "smoke_spread_speed_m_min",
    )
    if spread_speed is None:
        spread_speed = (
            PhysicsCfg.FIRE_SEAT_DEFAULT_SPEED
            if fire_kind == FireZoneKind.FIRE_SEAT
            else PhysicsCfg.FIRE_ZONE_DEFAULT_SPEED
        )

    spread_azimuth_raw = first_finite_float(
        "spread_azimuth",
        "fire_spread_azimuth",
        "smoke_spread_azimuth",
    )
    spread_azimuth = (
        spread_azimuth_raw % 360.0 if spread_azimuth_raw is not None else None
    )

    is_active_value = props.get("is_active")
    is_active = is_active_value if isinstance(is_active_value, bool) else True

    smoke_density = first_non_negative_float("smoke_density")

    fire_rank_raw = first_finite_float("fire_rank", "rank", "fire_rank_class")
    if fire_rank_raw is None:
        fire_rank = 1
    else:
        fire_rank = max(1, min(5, int(round(fire_rank_raw))))

    fire_power_raw = first_non_negative_float(
        "fire_power",
        "fire_strength",
        "power",
        "intensity_factor",
    )
    if fire_power_raw is None:
        fire_power = 1.0
    else:
        fire_power = max(0.35, min(4.0, float(fire_power_raw)))

    if area_m2 is None:
        if fire_kind == FireZoneKind.FIRE_SEAT:
            base_area_by_rank = {
                1: 16.0,
                2: 26.0,
                3: 40.0,
                4: 58.0,
                5: 78.0,
            }
            area_m2 = base_area_by_rank.get(fire_rank, 26.0) * max(0.7, fire_power)
        elif fire_kind == FireZoneKind.SMOKE_ZONE:
            area_m2 = 24.0 * max(0.7, fire_power)

    return {
        "area_m2": round(area_m2, 2) if area_m2 is not None else None,
        "spread_speed_m_min": round(spread_speed, 3),
        "spread_azimuth": round(spread_azimuth, 3)
        if spread_azimuth is not None
        else None,
        "is_active": is_active,
        "smoke_density": round(smoke_density, 3) if smoke_density is not None else None,
        "fire_rank": fire_rank,
        "fire_power": round(fire_power, 3),
    }


def upsert_fire_object_from_scene(
    db, snapshot_id: UUID, floor_id: str, scene_object: dict[str, Any]
) -> None:
    kind = str(scene_object.get("kind") or "").upper()
    if kind not in {"FIRE_SOURCE", "SMOKE_ZONE"}:
        return

    object_id = str(scene_object.get("id") or "")
    if not object_id:
        return

    geometry_type = parse_enum(
        GeometryType,
        scene_object.get("geometry_type", GeometryType.POINT.value),
        "geometry_type",
    )
    geometry = scene_object.get("geometry")
    if not isinstance(geometry, dict):
        return

    fire_kind = (
        FireZoneKind.FIRE_SEAT if kind == "FIRE_SOURCE" else FireZoneKind.SMOKE_ZONE
    )
    runtime_params = extract_scene_fire_runtime_params(scene_object, fire_kind)
    scene_props_raw = scene_object.get("props")
    scene_props: dict[str, Any] = (
        scene_props_raw if isinstance(scene_props_raw, dict) else {}
    )

    max_area_m2 = as_float(
        scene_props.get("max_area_m2")
        or scene_props.get("max_fire_area_m2")
        or scene_props.get("room_area_m2"),
        0.0,
    )
    if max_area_m2 <= 0 and geometry_type == GeometryType.POLYGON:
        polygon_points = [
            normalize_point_tuple(point)
            for point in cast(list[Any], geometry.get("points") or [])
        ]
        compact_points = [point for point in polygon_points if point is not None]
        max_area_m2 = polygon_area_m2(compact_points)
    if max_area_m2 > 0:
        max_area_m2 = max(4.0, min(20000.0, max_area_m2))
    elif fire_kind == FireZoneKind.FIRE_SEAT:
        max_area_m2 = 140.0
    elif fire_kind == FireZoneKind.SMOKE_ZONE:
        max_area_m2 = 220.0
    name = str(
        scene_object.get("label") or ("Очаг" if kind == "FIRE_SOURCE" else "Зона дыма")
    ).strip()
    if not name:
        name = "Объект сцены"

    existing_fire = (
        db.execute(select(FireObject).where(FireObject.state_id == snapshot_id))
        .scalars()
        .all()
    )
    target: FireObject | None = None
    for fire_object in existing_fire:
        extra = fire_object.extra if isinstance(fire_object.extra, dict) else {}
        if extra.get("scene_object_id") == object_id:
            target = fire_object
            break

    if target is None:
        target = FireObject(
            state_id=snapshot_id,
            name=name[:255],
            kind=fire_kind,
            geometry_type=geometry_type,
            geometry=geometry,
            area_m2=runtime_params["area_m2"],
            perimeter_m=None,
            spread_speed_m_min=runtime_params["spread_speed_m_min"],
            spread_azimuth=runtime_params["spread_azimuth"],
            is_active=runtime_params["is_active"],
            extra={
                "source": "ws:scene_object",
                "scene_object_id": object_id,
                "floor_id": floor_id,
                "smoke_density": runtime_params["smoke_density"],
                "fire_rank": runtime_params["fire_rank"],
                "fire_power": runtime_params["fire_power"],
                "max_area_m2": round(max_area_m2, 2) if max_area_m2 > 0 else None,
            },
        )
        db.add(target)
        return

    target.name = name[:255]
    target.kind = fire_kind
    target.geometry_type = geometry_type
    target.geometry = geometry
    target.area_m2 = runtime_params["area_m2"]
    target.spread_speed_m_min = runtime_params["spread_speed_m_min"]
    target.spread_azimuth = runtime_params["spread_azimuth"]
    target.is_active = runtime_params["is_active"]
    target.extra = {
        **(target.extra if isinstance(target.extra, dict) else {}),
        "source": "ws:scene_object",
        "scene_object_id": object_id,
        "floor_id": floor_id,
        "smoke_density": runtime_params["smoke_density"],
        "fire_rank": runtime_params["fire_rank"],
        "fire_power": runtime_params["fire_power"],
        "max_area_m2": round(max_area_m2, 2) if max_area_m2 > 0 else None,
    }


def web_mercator_to_wgs84(x_m: float, y_m: float) -> tuple[float, float]:
    earth_radius = 6378137.0
    lon = (x_m / earth_radius) * (180 / math.pi)
    lat = (2 * math.atan(math.exp(y_m / earth_radius)) - math.pi / 2) * (180 / math.pi)
    return lat, lon


def parse_center_from_karta01_url(karta01_url: str) -> tuple[float, float] | None:
    try:
        parsed = urlparse(karta01_url)
    except Exception:
        return None

    fragment = parsed.fragment or ""
    if not fragment:
        return None

    values = parse_qs(fragment)
    raw_lat = values.get("lat", [None])[0]
    raw_lon = values.get("lon", [None])[0]
    if raw_lat is None or raw_lon is None:
        return None

    try:
        lat_value = float(raw_lat)
        lon_value = float(raw_lon)
    except (TypeError, ValueError):
        return None

    if abs(lat_value) <= 90 and abs(lon_value) <= 180:
        return lat_value, lon_value

    # karta01 often stores coordinates in EPSG:3857 meters inside fragment
    return web_mercator_to_wgs84(lon_value, lat_value)


def stable_center_from_address(address_text: str) -> tuple[float, float]:
    normalized = address_text.strip().lower()
    if not normalized:
        return 55.751244, 37.618423

    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    seed_a = int(digest[:8], 16)
    seed_b = int(digest[8:16], 16)
    lat = 55.0 + (seed_a % 2000) / 10000.0
    lon = 37.0 + (seed_b % 3000) / 10000.0
    return lat, lon


def generate_site_entities(radius_m: float) -> list[dict[str, Any]]:
    half_width = max(20.0, min(radius_m * 0.28, 55.0))
    half_height = max(14.0, min(radius_m * 0.18, 38.0))
    road_offset = min(radius_m * 0.45, 90.0)
    hydrant_offset = half_width + 12.0

    return [
        {
            "id": f"site_{uuid4().hex[:10]}",
            "kind": "BUILDING_CONTOUR",
            "geometry_type": "POLYGON",
            "geometry": {
                "points": [
                    {"x": -half_width, "y": -half_height},
                    {"x": half_width, "y": -half_height},
                    {"x": half_width, "y": half_height},
                    {"x": -half_width, "y": half_height},
                ]
            },
            "label": "Контур здания",
        },
        {
            "id": f"site_{uuid4().hex[:10]}",
            "kind": "ROAD_ACCESS",
            "geometry_type": "LINESTRING",
            "geometry": {
                "points": [
                    {"x": -road_offset, "y": -half_height - 10},
                    {"x": road_offset, "y": -half_height - 10},
                ]
            },
            "label": "Подъезд",
        },
        {
            "id": f"site_{uuid4().hex[:10]}",
            "kind": "HYDRANT",
            "geometry_type": "POINT",
            "geometry": {"x": -hydrant_offset, "y": 0},
            "label": "Гидрант 1",
        },
        {
            "id": f"site_{uuid4().hex[:10]}",
            "kind": "HYDRANT",
            "geometry_type": "POINT",
            "geometry": {"x": hydrant_offset, "y": 0},
            "label": "Гидрант 2",
        },
        {
            "id": f"site_{uuid4().hex[:10]}",
            "kind": "WATER_SOURCE",
            "geometry_type": "POINT",
            "geometry": {"x": half_width + 20, "y": half_height + 15},
            "label": "Водоисточник",
        },
    ]


def seed_floor_layout(
    floor: dict[str, Any], site_entities: list[dict[str, Any]]
) -> None:
    objects = floor.get("objects")
    if not isinstance(objects, list):
        objects = []
        floor["objects"] = objects
    if len(objects) > 0:
        return

    contour = next(
        (
            entity
            for entity in site_entities
            if entity.get("kind") == "BUILDING_CONTOUR"
            and entity.get("geometry_type") == "POLYGON"
        ),
        None,
    )
    points = []
    if contour and isinstance(contour.get("geometry"), dict):
        points = contour["geometry"].get("points", [])
    if not isinstance(points, list) or len(points) < 4:
        points = [
            {"x": -30.0, "y": -18.0},
            {"x": 30.0, "y": -18.0},
            {"x": 30.0, "y": 18.0},
            {"x": -30.0, "y": 18.0},
        ]

    walls = [
        [points[0], points[1]],
        [points[1], points[2]],
        [points[2], points[3]],
        [points[3], points[0]],
    ]
    for wall_points in walls:
        objects.append(
            {
                "id": f"obj_{uuid4().hex[:10]}",
                "kind": "WALL",
                "geometry_type": "LINESTRING",
                "geometry": {"points": wall_points},
                "label": "Стена",
                "props": {"thickness_m": 0.3},
                "created_at": utcnow().isoformat(),
            }
        )

    midpoint_top = {
        "x": (points[0]["x"] + points[1]["x"]) / 2.0,
        "y": points[0]["y"],
    }
    midpoint_bottom = {
        "x": (points[2]["x"] + points[3]["x"]) / 2.0,
        "y": points[2]["y"],
    }
    objects.append(
        {
            "id": f"obj_{uuid4().hex[:10]}",
            "kind": "EXIT",
            "geometry_type": "POINT",
            "geometry": midpoint_top,
            "label": "Выход 1",
            "props": {},
            "created_at": utcnow().isoformat(),
        }
    )
    objects.append(
        {
            "id": f"obj_{uuid4().hex[:10]}",
            "kind": "EXIT",
            "geometry_type": "POINT",
            "geometry": midpoint_bottom,
            "label": "Выход 2",
            "props": {},
            "created_at": utcnow().isoformat(),
        }
    )


class WebSocketConnectionManager:
    def __init__(self) -> None:
        self._connections_by_session: dict[UUID, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, session_id: UUID, websocket: WebSocket) -> None:
        async with self._lock:
            for target_session_id in list(self._connections_by_session):
                sockets = self._connections_by_session[target_session_id]
                sockets.discard(websocket)
                if not sockets:
                    del self._connections_by_session[target_session_id]
            self._connections_by_session.setdefault(session_id, set()).add(websocket)

    async def unsubscribe(self, websocket: WebSocket) -> None:
        async with self._lock:
            for target_session_id in list(self._connections_by_session):
                sockets = self._connections_by_session[target_session_id]
                sockets.discard(websocket)
                if not sockets:
                    del self._connections_by_session[target_session_id]

    async def broadcast(
        self, session_id: UUID, payload: dict[str, Any], skip: WebSocket | None = None
    ) -> None:
        async with self._lock:
            recipients = list(self._connections_by_session.get(session_id, set()))

        stale_sockets: list[WebSocket] = []
        for websocket in recipients:
            if skip is not None and websocket is skip:
                continue
            try:
                await websocket.send_json(payload)
            except Exception:
                stale_sockets.append(websocket)

        for stale_websocket in stale_sockets:
            await self.unsubscribe(stale_websocket)


class CommandIdempotencyStore:
    def __init__(self, ttl_seconds: int = 900, max_entries: int = 20_000) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._entries: dict[str, tuple[datetime, dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    def _cleanup_locked(self) -> None:
        expiration_border = utcnow() - timedelta(seconds=self._ttl_seconds)
        for key, (created_at, _) in list(self._entries.items()):
            if created_at < expiration_border:
                del self._entries[key]

    def _trim_locked(self) -> None:
        if len(self._entries) <= self._max_entries:
            return
        ordered_keys = sorted(
            self._entries.keys(),
            key=lambda key: self._entries[key][0],
        )
        keys_to_remove = ordered_keys[: len(self._entries) - self._max_entries]
        for key in keys_to_remove:
            del self._entries[key]

    async def get(self, key: str) -> dict[str, Any] | None:
        async with self._lock:
            self._cleanup_locked()
            entry = self._entries.get(key)
            if entry is None:
                return None
            _, payload = entry
            return payload.copy()

    async def put(self, key: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            self._cleanup_locked()
            self._entries[key] = (utcnow(), payload.copy())
            self._trim_locked()


ws_connections = WebSocketConnectionManager()
ws_idempotency = CommandIdempotencyStore()
session_runtime_tick_locks: dict[UUID, asyncio.Lock] = {}
session_runtime_tick_locks_guard = asyncio.Lock()
session_state_bundle_cache: dict[UUID, dict[str, Any]] = {}
radio_transcription_tasks: set[asyncio.Task[Any]] = set()


async def get_session_runtime_tick_lock(session_id: UUID) -> asyncio.Lock:
    async with session_runtime_tick_locks_guard:
        lock = session_runtime_tick_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            session_runtime_tick_locks[session_id] = lock
        return lock


async def maybe_apply_runtime_tick_and_broadcast(session_id: UUID) -> bool:
    lock = await get_session_runtime_tick_lock(session_id)
    async with lock:
        with SessionLocal() as db:
            session_obj = db.get(SimulationSession, session_id)
            if session_obj is None:
                return False

            runtime_updated = apply_lesson_runtime_tick_for_session(db, session_obj)
            if not runtime_updated:
                return False

            db.commit()
            bundle = get_session_state_payload(db, session_id)

    state_message = {
        "type": "session_state",
        "sessionId": str(session_id),
        "bundle": bundle,
    }
    await ws_connections.broadcast(session_id, state_message)
    return True


def get_session_state_payload(
    db, session_id: UUID, include_history: bool = False
) -> dict[str, Any]:
    session_obj = db.get(SimulationSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")

    snapshot_obj = (
        db.execute(
            select(SessionStateSnapshot)
            .where(
                SessionStateSnapshot.session_id == session_id,
                SessionStateSnapshot.is_current.is_(True),
            )
            .order_by(SessionStateSnapshot.captured_at.desc())
        )
        .scalars()
        .first()
    )
    if snapshot_obj is None:
        snapshot_obj = (
            db.execute(
                select(SessionStateSnapshot)
                .where(SessionStateSnapshot.session_id == session_id)
                .order_by(SessionStateSnapshot.captured_at.desc())
            )
            .scalars()
            .first()
        )

    weather_obj = None
    fire_objects: list[FireObject] = []
    resource_deployments: list[ResourceDeployment] = []
    if snapshot_obj is not None:
        weather_obj = (
            db.execute(
                select(WeatherSnapshot)
                .where(WeatherSnapshot.state_id == snapshot_obj.id)
                .order_by(WeatherSnapshot.created_at.desc())
            )
            .scalars()
            .first()
        )
        fire_objects = (
            db.execute(
                select(FireObject)
                .where(FireObject.state_id == snapshot_obj.id)
                .order_by(FireObject.created_at.asc())
            )
            .scalars()
            .all()
        )
        resource_deployments = (
            db.execute(
                select(ResourceDeployment)
                .where(ResourceDeployment.state_id == snapshot_obj.id)
                .order_by(ResourceDeployment.created_at.asc())
            )
            .scalars()
            .all()
        )

    snapshots_history: list[SessionStateSnapshot] = []
    if include_history:
        snapshots_history = (
            db.execute(
                select(SessionStateSnapshot)
                .where(SessionStateSnapshot.session_id == session_id)
                .order_by(SessionStateSnapshot.captured_at.desc())
            )
            .scalars()
            .all()
        )

    fire_objects_payload: Any = fire_objects
    resource_deployments_payload: Any = resource_deployments
    snapshots_history_payload: Any = snapshots_history

    bundle = SessionStateBundleRead(
        session=session_obj,
        snapshot=snapshot_obj,
        weather=weather_obj,
        fire_objects=fire_objects_payload,
        resource_deployments=resource_deployments_payload,
        snapshots_history=snapshots_history_payload,
    )
    payload = bundle.model_dump(mode="json")
    if not include_history:
        session_state_bundle_cache[session_id] = json.loads(
            json.dumps(payload, ensure_ascii=False)
        )
    return payload


def get_radio_optimized_session_state_payload(db, session_id: UUID) -> dict[str, Any]:
    cached_payload = session_state_bundle_cache.get(session_id)
    if cached_payload is None:
        return get_session_state_payload(db, session_id)
    return cast(
        dict[str, Any],
        json.loads(json.dumps(cached_payload, ensure_ascii=False)),
    )


def get_or_create_current_snapshot(db, session_id: UUID) -> SessionStateSnapshot:
    current_snapshot = (
        db.execute(
            select(SessionStateSnapshot)
            .where(
                SessionStateSnapshot.session_id == session_id,
                SessionStateSnapshot.is_current.is_(True),
            )
            .order_by(SessionStateSnapshot.captured_at.desc())
        )
        .scalars()
        .first()
    )
    if current_snapshot is not None:
        return current_snapshot

    latest_snapshot = (
        db.execute(
            select(SessionStateSnapshot)
            .where(SessionStateSnapshot.session_id == session_id)
            .order_by(SessionStateSnapshot.captured_at.desc())
        )
        .scalars()
        .first()
    )
    if latest_snapshot is not None:
        latest_snapshot.is_current = True
        db.flush()
        return latest_snapshot

    snapshot = SessionStateSnapshot(
        session_id=session_id,
        sim_time_seconds=0,
        time_of_day=TimeOfDay.DAY,
        water_supply_status=WaterSupplyStatus.OK,
        is_current=True,
        snapshot_data={"source": "ws"},
        notes="Auto-generated by realtime command",
    )
    db.add(snapshot)
    db.flush()
    return snapshot


def apply_update_weather_command(db, session_id: UUID, payload: dict[str, Any]) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)

    wind_speed = parse_non_negative_float(payload.get("wind_speed", 5), "wind_speed")
    wind_dir = parse_optional_non_negative_int(payload.get("wind_dir", 90), "wind_dir")
    if wind_dir is None or wind_dir > 359:
        raise HTTPException(
            status_code=422, detail="wind_dir must be integer in range [0..359]"
        )
    temperature = parse_non_negative_float(
        payload.get("temperature", 20), "temperature"
    )

    humidity = parse_optional_non_negative_int(payload.get("humidity"), "humidity")
    if humidity is not None and humidity > 100:
        raise HTTPException(
            status_code=422, detail="humidity must be integer in range [0..100]"
        )

    visibility_m = parse_optional_non_negative_int(
        payload.get("visibility_m"), "visibility_m"
    )

    precipitation = payload.get("precipitation")
    if precipitation is not None:
        if not isinstance(precipitation, str):
            raise HTTPException(status_code=422, detail="precipitation must be string")
        if len(precipitation) > 32:
            raise HTTPException(
                status_code=422, detail="precipitation must be <= 32 chars"
            )

    weather_data = payload.get("weather_data", {})
    if not isinstance(weather_data, dict):
        raise HTTPException(status_code=422, detail="weather_data must be object")

    weather_obj = (
        db.execute(
            select(WeatherSnapshot)
            .where(WeatherSnapshot.state_id == snapshot.id)
            .order_by(WeatherSnapshot.created_at.desc())
        )
        .scalars()
        .first()
    )

    if weather_obj is None:
        weather_obj = WeatherSnapshot(
            state_id=snapshot.id,
            wind_speed=wind_speed,
            wind_dir=wind_dir,
            temperature=temperature,
            humidity=humidity,
            precipitation=precipitation,
            visibility_m=visibility_m,
            weather_data={**weather_data, "source": "ws:update_weather"},
        )
        db.add(weather_obj)
    else:
        weather_obj.wind_speed = wind_speed
        weather_obj.wind_dir = wind_dir
        weather_obj.temperature = temperature
        weather_obj.humidity = humidity
        weather_obj.precipitation = precipitation
        weather_obj.visibility_m = visibility_m
        weather_obj.weather_data = {**weather_obj.weather_data, **weather_data}

    session_obj = db.get(SimulationSession, session_id)
    if session_obj is not None:
        session_weather = (
            session_obj.weather if isinstance(session_obj.weather, dict) else {}
        )
        session_obj.weather = {
            **session_weather,
            "wind_speed": wind_speed,
            "wind_dir": wind_dir,
            "temp": temperature,
        }


def apply_create_fire_object_command(
    db, session_id: UUID, payload: dict[str, Any]
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)

    name = str(payload.get("name") or f"Fire-{utcnow().strftime('%H:%M:%S')}")
    if len(name.strip()) == 0:
        raise HTTPException(status_code=422, detail="name cannot be empty")
    if len(name) > 255:
        raise HTTPException(status_code=422, detail="name must be <= 255 chars")

    kind = parse_enum(
        FireZoneKind, payload.get("kind", FireZoneKind.FIRE_SEAT.value), "kind"
    )
    geometry_type = parse_enum(
        GeometryType,
        payload.get("geometry_type", GeometryType.POINT.value),
        "geometry_type",
    )
    geometry = payload.get("geometry", {"x": 0, "y": 0})
    if not isinstance(geometry, dict):
        raise HTTPException(status_code=422, detail="geometry must be object")

    area_m2 = parse_optional_non_negative_float(payload.get("area_m2"), "area_m2")
    perimeter_m = parse_optional_non_negative_float(
        payload.get("perimeter_m"), "perimeter_m"
    )
    spread_speed_m_min = parse_optional_non_negative_float(
        payload.get("spread_speed_m_min"),
        "spread_speed_m_min",
    )
    spread_azimuth = parse_optional_non_negative_int(
        payload.get("spread_azimuth"), "spread_azimuth"
    )
    if spread_azimuth is not None and spread_azimuth > 359:
        raise HTTPException(
            status_code=422, detail="spread_azimuth must be integer in range [0..359]"
        )

    is_active = parse_optional_bool(payload.get("is_active"), "is_active")
    if is_active is None:
        is_active = True

    extra = payload.get("extra", {})
    if not isinstance(extra, dict):
        raise HTTPException(status_code=422, detail="extra must be object")

    fire_object = FireObject(
        state_id=snapshot.id,
        name=name.strip(),
        kind=kind,
        geometry_type=geometry_type,
        geometry=geometry,
        area_m2=area_m2,
        perimeter_m=perimeter_m,
        spread_speed_m_min=spread_speed_m_min,
        spread_azimuth=spread_azimuth,
        is_active=is_active,
        extra={**extra, "source": "ws:create_fire_object"},
    )
    db.add(fire_object)


def apply_create_resource_deployment_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)

    resource_kind = parse_enum(
        ResourceKind,
        payload.get("resource_kind", ResourceKind.VEHICLE.value),
        "resource_kind",
    )
    status_value = parse_enum(
        DeploymentStatus,
        payload.get("status", DeploymentStatus.PLANNED.value),
        "status",
    )
    label = str(payload.get("label", "")).strip()
    if not label:
        raise HTTPException(status_code=422, detail="label is required")
    if len(label) > 255:
        raise HTTPException(status_code=422, detail="label must be <= 255 chars")

    geometry_type = parse_enum(
        GeometryType,
        payload.get("geometry_type", GeometryType.POINT.value),
        "geometry_type",
    )
    geometry = payload.get("geometry", {"x": 0, "y": 0})
    if not isinstance(geometry, dict):
        raise HTTPException(status_code=422, detail="geometry must be object")

    vehicle_dictionary_id = parse_optional_non_negative_int(
        payload.get("vehicle_dictionary_id"),
        "vehicle_dictionary_id",
    )
    if vehicle_dictionary_id is not None and vehicle_dictionary_id == 0:
        raise HTTPException(
            status_code=422, detail="vehicle_dictionary_id must be >= 1"
        )

    rotation_deg = parse_optional_non_negative_int(
        payload.get("rotation_deg"), "rotation_deg"
    )
    if rotation_deg is not None and rotation_deg > 359:
        raise HTTPException(
            status_code=422, detail="rotation_deg must be integer in range [0..359]"
        )

    resource_data = payload.get("resource_data", {})
    if not isinstance(resource_data, dict):
        raise HTTPException(status_code=422, detail="resource_data must be object")

    assert_deployment_workflow_allowed_for_role(
        user, resource_kind, status_value, resource_data
    )
    assert_combat_area_is_activated_by_rtp(db, snapshot, user)

    if is_dispatcher_vehicle_dispatch(user, resource_kind, status_value, resource_data):
        if vehicle_dictionary_id is None:
            raise HTTPException(
                status_code=422,
                detail="vehicle_dictionary_id is required for dispatcher vehicle dispatch",
            )
        validate_dispatcher_vehicle_call_resource_data(resource_data)

    deployment = ResourceDeployment(
        state_id=snapshot.id,
        resource_kind=resource_kind,
        status=status_value,
        vehicle_dictionary_id=vehicle_dictionary_id,
        user_id=user.id,
        label=label,
        geometry_type=geometry_type,
        geometry=geometry,
        rotation_deg=rotation_deg,
        resource_data={**resource_data, "source": "ws:create_resource_deployment"},
    )
    db.add(deployment)


def apply_update_snapshot_command(
    db, session_id: UUID, payload: dict[str, Any]
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)

    if "sim_time_seconds" in payload:
        sim_time_seconds = parse_optional_non_negative_int(
            payload.get("sim_time_seconds"), "sim_time_seconds"
        )
        if sim_time_seconds is None:
            raise HTTPException(
                status_code=422, detail="sim_time_seconds cannot be null"
            )
        snapshot.sim_time_seconds = sim_time_seconds

    if "time_of_day" in payload:
        snapshot.time_of_day = parse_enum(
            TimeOfDay, payload.get("time_of_day"), "time_of_day"
        )

    if "water_supply_status" in payload:
        snapshot.water_supply_status = parse_enum(
            WaterSupplyStatus,
            payload.get("water_supply_status"),
            "water_supply_status",
        )

    if "notes" in payload:
        notes = payload.get("notes")
        if notes is not None and not isinstance(notes, str):
            raise HTTPException(status_code=422, detail="notes must be string or null")
        snapshot.notes = notes

    if "snapshot_data" in payload:
        snapshot_data = payload.get("snapshot_data")
        if snapshot_data is not None and not isinstance(snapshot_data, dict):
            raise HTTPException(
                status_code=422, detail="snapshot_data must be object or null"
            )
        snapshot.snapshot_data = snapshot_data or {}

    if "is_current" in payload:
        is_current = parse_optional_bool(payload.get("is_current"), "is_current")
        if is_current is None:
            raise HTTPException(status_code=422, detail="is_current cannot be null")
        if is_current:
            others = (
                db.execute(
                    select(SessionStateSnapshot).where(
                        SessionStateSnapshot.session_id == session_id,
                        SessionStateSnapshot.id != snapshot.id,
                    )
                )
                .scalars()
                .all()
            )
            for other_snapshot in others:
                other_snapshot.is_current = False
        snapshot.is_current = is_current


def apply_set_scene_address_command(
    db, session_id: UUID, payload: dict[str, Any]
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    address_text = str(payload.get("address_text") or "").strip()
    karta01_url = str(payload.get("karta01_url") or "").strip()
    radius_m = parse_non_negative_float(payload.get("radius_m", 200), "radius_m")
    if radius_m < 50:
        radius_m = 50
    if radius_m > 1000:
        radius_m = 1000

    fallback_used = False
    geocode_provider = "NONE"
    overpass_provider: str | None = None
    resolution_mode = "fallback"
    warnings: list[str] = []
    site_entities: list[dict[str, Any]] = []
    floor_objects: list[dict[str, Any]] = []

    try:
        generated = build_training_scene_from_address(
            address_text=address_text,
            karta01_url=karta01_url,
            radius_m=radius_m,
        )
        center_lat = generated.center_lat
        center_lon = generated.center_lon
        site_entities = [
            item for item in generated.site_entities if isinstance(item, dict)
        ]
        floor_objects = [
            item for item in generated.floor_objects if isinstance(item, dict)
        ]
        fallback_used = generated.fallback_used
        geocode_provider = generated.geocode_provider
        overpass_provider = generated.overpass_provider
        resolution_mode = generated.resolution_mode
        warnings = [str(item) for item in generated.warnings]
    except Exception as exc:
        fallback_used = True
        center = parse_center_from_karta01_url(karta01_url) if karta01_url else None
        if center is None:
            center = stable_center_from_address(address_text)
            geocode_provider = "HASH_FALLBACK"
            resolution_mode = "stable_hash"
        else:
            geocode_provider = "KARTA01"
            resolution_mode = "karta01_url"

        center_lat, center_lon = center
        site_entities = generate_site_entities(radius_m)
        warnings = [f"Address generation fallback: {exc}"]

    scene["address"] = {
        "address_text": address_text,
        "karta01_url": karta01_url,
        "radius_m": radius_m,
        "center": {"lat": center_lat, "lon": center_lon},
        "generated_at": utcnow().isoformat(),
        "geocode_provider": geocode_provider,
        "overpass_provider": overpass_provider,
        "resolution_mode": resolution_mode,
        "fallback_used": fallback_used,
        "warnings": warnings,
    }
    scene["site_entities"] = site_entities

    active_floor_id = parse_floor_id(scene.get("active_floor_id", "F1"))
    scene["active_floor_id"] = active_floor_id
    floor = ensure_scene_floor(scene, active_floor_id, 0.0)

    previous_objects = floor.get("objects")
    if isinstance(previous_objects, list):
        for item in previous_objects:
            if not isinstance(item, dict):
                continue
            object_id = str(item.get("id") or "").strip()
            if object_id:
                remove_fire_objects_for_scene_object(db, snapshot.id, object_id)

    floor["objects"] = floor_objects
    if len(floor_objects) == 0:
        seed_floor_layout(floor, site_entities)

    persist_training_scene(snapshot, snapshot_data, scene)


def apply_upsert_scene_floor_command(
    db, session_id: UUID, payload: dict[str, Any]
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    floor_id = parse_floor_id(payload.get("floor_id"))
    elevation_m = parse_finite_float(payload.get("elevation_m", 0), "elevation_m")
    ensure_scene_floor(scene, floor_id, elevation_m)

    if payload.get("set_active", False):
        scene["active_floor_id"] = floor_id

    persist_training_scene(snapshot, snapshot_data, scene)


def apply_set_active_scene_floor_command(
    db, session_id: UUID, payload: dict[str, Any]
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    floor_id = parse_floor_id(payload.get("floor_id"))
    ensure_scene_floor(scene, floor_id, 0.0)
    scene["active_floor_id"] = floor_id

    persist_training_scene(snapshot, snapshot_data, scene)


def apply_upsert_scene_object_command(
    db, session_id: UUID, payload: dict[str, Any]
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    floor_id = parse_floor_id(
        payload.get("floor_id") or scene.get("active_floor_id") or "F1"
    )
    floor = ensure_scene_floor(scene, floor_id, 0.0)
    objects = floor.get("objects")
    if not isinstance(objects, list):
        objects = []
        floor["objects"] = objects

    kind = parse_scene_kind(payload.get("kind"))
    geometry_type = parse_enum(
        GeometryType,
        payload.get("geometry_type", GeometryType.POINT.value),
        "geometry_type",
    )
    geometry = parse_scene_geometry(geometry_type, payload.get("geometry", {}))

    object_id_raw = payload.get("object_id")
    object_id = str(object_id_raw).strip() if isinstance(object_id_raw, str) else ""
    if object_id and len(object_id) > 64:
        raise HTTPException(status_code=422, detail="object_id is too long")
    if not object_id:
        object_id = f"obj_{uuid4().hex[:10]}"

    label = str(payload.get("label") or "").strip()
    if len(label) > 255:
        raise HTTPException(status_code=422, detail="label is too long")
    props = payload.get("props", {})
    if not isinstance(props, dict):
        raise HTTPException(status_code=422, detail="props must be object")

    target_index: int | None = None
    for index, item in enumerate(objects):
        if isinstance(item, dict) and str(item.get("id") or "") == object_id:
            target_index = index
            break

    scene_object = {
        "id": object_id,
        "kind": kind,
        "geometry_type": geometry_type.value,
        "geometry": geometry,
        "label": label,
        "props": props,
        "created_at": utcnow().isoformat(),
    }

    if target_index is None:
        objects.append(scene_object)
    else:
        previous_created_at = objects[target_index].get("created_at")
        if isinstance(previous_created_at, str):
            scene_object["created_at"] = previous_created_at
        objects[target_index] = scene_object

    upsert_fire_object_from_scene(db, snapshot.id, floor_id, scene_object)
    persist_training_scene(snapshot, snapshot_data, scene)


def apply_remove_scene_object_command(
    db, session_id: UUID, payload: dict[str, Any]
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    floor_id = parse_floor_id(
        payload.get("floor_id") or scene.get("active_floor_id") or "F1"
    )
    object_id = str(payload.get("object_id") or "").strip()
    if not object_id:
        raise HTTPException(status_code=422, detail="object_id is required")

    floor = ensure_scene_floor(scene, floor_id, 0.0)
    objects = floor.get("objects")
    if not isinstance(objects, list):
        objects = []
        floor["objects"] = objects

    next_objects: list[dict[str, Any]] = []
    removed = False
    for item in objects:
        if not isinstance(item, dict):
            continue
        if str(item.get("id") or "") == object_id:
            removed = True
            continue
        next_objects.append(item)

    if not removed:
        raise HTTPException(status_code=404, detail="Scene object not found")

    floor["objects"] = next_objects
    remove_fire_objects_for_scene_object(db, snapshot.id, object_id)
    persist_training_scene(snapshot, snapshot_data, scene)


def apply_sync_scene_to_fire_objects_command(db, session_id: UUID) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    existing = (
        db.execute(select(FireObject).where(FireObject.state_id == snapshot.id))
        .scalars()
        .all()
    )
    for item in existing:
        extra = item.extra if isinstance(item.extra, dict) else {}
        if extra.get("source") in {"ws:scene_object", "ws:scene_sync"}:
            db.delete(item)

    for floor in scene.get("floors", []):
        if not isinstance(floor, dict):
            continue
        floor_id = str(floor.get("floor_id") or "F1").upper()
        objects = floor.get("objects")
        if not isinstance(objects, list):
            continue
        for scene_object in objects:
            if not isinstance(scene_object, dict):
                continue
            kind = str(scene_object.get("kind") or "").upper()
            if kind not in {"FIRE_SOURCE", "SMOKE_ZONE"}:
                continue

            object_id = str(scene_object.get("id") or f"obj_{uuid4().hex[:10]}")
            geometry_type = parse_enum(
                GeometryType,
                scene_object.get("geometry_type", GeometryType.POINT.value),
                "geometry_type",
            )
            geometry = parse_scene_geometry(
                geometry_type, scene_object.get("geometry", {})
            )
            fire_kind = (
                FireZoneKind.FIRE_SEAT
                if kind == "FIRE_SOURCE"
                else FireZoneKind.SMOKE_ZONE
            )
            runtime_params = extract_scene_fire_runtime_params(scene_object, fire_kind)
            name = str(
                scene_object.get("label")
                or ("Очаг" if kind == "FIRE_SOURCE" else "Зона дыма")
            ).strip()[:255]
            if not name:
                name = "Объект сцены"

            db.add(
                FireObject(
                    state_id=snapshot.id,
                    name=name,
                    kind=fire_kind,
                    geometry_type=geometry_type,
                    geometry=geometry,
                    area_m2=runtime_params["area_m2"],
                    perimeter_m=None,
                    spread_speed_m_min=runtime_params["spread_speed_m_min"],
                    spread_azimuth=runtime_params["spread_azimuth"],
                    is_active=runtime_params["is_active"],
                    extra={
                        "source": "ws:scene_sync",
                        "scene_object_id": object_id,
                        "floor_id": floor_id,
                        "smoke_density": runtime_params["smoke_density"],
                        "fire_rank": runtime_params["fire_rank"],
                        "fire_power": runtime_params["fire_power"],
                    },
                )
            )

    persist_training_scene(snapshot, snapshot_data, scene)


def count_scene_objects(scene: dict[str, Any]) -> int:
    total = 0
    floors = scene.get("floors")
    if not isinstance(floors, list):
        return 0
    for floor in floors:
        if not isinstance(floor, dict):
            continue
        objects = floor.get("objects")
        if isinstance(objects, list):
            total += sum(1 for item in objects if isinstance(item, dict))
    return total


def apply_save_scene_checkpoint_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    reason = str(payload.get("reason") or "manual_save").strip().lower()[:48]
    if not reason:
        reason = "manual_save"

    checkpoints_raw = snapshot_data.get("training_lead_scene_checkpoints")
    checkpoints = (
        [item for item in checkpoints_raw if isinstance(item, dict)]
        if isinstance(checkpoints_raw, list)
        else []
    )

    saved_at = utcnow().isoformat()
    checkpoint = {
        "id": f"scene_{uuid4().hex[:10]}",
        "saved_at": saved_at,
        "saved_by": user.username,
        "saved_by_user_id": str(user.id),
        "session_id": str(session_id),
        "reason": reason,
        "active_floor_id": str(scene.get("active_floor_id") or "F1"),
        "floors_count": len(scene.get("floors", []))
        if isinstance(scene.get("floors"), list)
        else 0,
        "objects_count": count_scene_objects(scene),
        "site_entities_count": len(scene.get("site_entities", []))
        if isinstance(scene.get("site_entities"), list)
        else 0,
    }

    snapshot_data["training_lead_scene_last_saved_at"] = saved_at
    snapshot_data["training_lead_scene_last_saved_by"] = user.username
    snapshot_data["training_lead_scene_checkpoints"] = [checkpoint, *checkpoints][:12]

    mark_lesson_started = payload.get("mark_lesson_started") is True
    if mark_lesson_started:
        snapshot_data["training_lesson"] = {
            "lifecycle_status": LESSON_LIFECYCLE_RUNNING,
            "status": lesson_legacy_status_from_lifecycle(LESSON_LIFECYCLE_RUNNING),
            "started_at": saved_at,
            "last_tick_at": saved_at,
            "started_by": user.username,
            "started_by_user_id": str(user.id),
            "session_id": str(session_id),
        }

    persist_training_scene(snapshot, snapshot_data, scene)


def apply_start_lesson_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    session_obj = db.get(SimulationSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session_obj.status == SessionStatus.IN_PROGRESS:
        raise HTTPException(status_code=409, detail="Lesson already started")
    if session_obj.status == SessionStatus.PAUSED:
        raise HTTPException(
            status_code=409,
            detail="Lesson is paused. Use resume_lesson instead of start_lesson",
        )
    if session_obj.status == SessionStatus.COMPLETED:
        raise HTTPException(
            status_code=409,
            detail="Lesson already completed. Create new session to restart",
        )

    lesson_settings = parse_lesson_start_settings(payload)
    started_at_dt = utcnow()
    started_at = started_at_dt.isoformat()
    planned_end_at = (
        started_at_dt + timedelta(seconds=lesson_settings["time_limit_sec"])
    ).isoformat()

    apply_save_scene_checkpoint_command(
        db,
        session_id,
        user,
        {
            "reason": payload.get("reason") or "lesson_start",
            "mark_lesson_started": True,
        },
    )
    apply_sync_scene_to_fire_objects_command(db, session_id)

    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)
    lesson_state = clone_json_dict(snapshot_data.get("training_lesson"))
    lesson_state["lifecycle_status"] = LESSON_LIFECYCLE_RUNNING
    lesson_state["status"] = lesson_legacy_status_from_lifecycle(
        LESSON_LIFECYCLE_RUNNING
    )
    lesson_state["started_at"] = started_at
    lesson_state["last_tick_at"] = started_at
    lesson_state["started_by"] = user.username
    lesson_state["started_by_user_id"] = str(user.id)
    lesson_state["session_id"] = str(session_id)
    lesson_state["time_limit_sec"] = lesson_settings["time_limit_sec"]
    lesson_state["start_sim_time_seconds"] = lesson_settings["start_sim_time_seconds"]
    lesson_state["planned_end_at"] = planned_end_at
    snapshot_data["training_lesson"] = lesson_state
    snapshot.sim_time_seconds = lesson_settings["start_sim_time_seconds"]
    persist_training_scene(snapshot, snapshot_data, scene)

    session_obj.status = SessionStatus.IN_PROGRESS


def apply_pause_lesson_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    session_obj = db.get(SimulationSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session_obj.status != SessionStatus.IN_PROGRESS:
        raise HTTPException(
            status_code=409, detail="Only IN_PROGRESS lesson can be paused"
        )

    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)
    lesson_state = clone_json_dict(snapshot_data.get("training_lesson"))

    lifecycle_status = normalize_lesson_lifecycle_status(
        lesson_state.get("lifecycle_status"), lesson_state.get("status")
    )
    if lifecycle_status != LESSON_LIFECYCLE_RUNNING:
        raise HTTPException(status_code=409, detail="Lesson is not running")

    paused_at = utcnow().isoformat()
    pause_count = as_non_negative_int(lesson_state.get("pause_count"), 0) or 0
    lesson_state["lifecycle_status"] = LESSON_LIFECYCLE_PAUSED
    lesson_state["status"] = lesson_legacy_status_from_lifecycle(
        LESSON_LIFECYCLE_PAUSED
    )
    lesson_state["paused_at"] = paused_at
    lesson_state["paused_by"] = user.username
    lesson_state["paused_by_user_id"] = str(user.id)
    lesson_state["pause_count"] = pause_count + 1
    lesson_state["pause_reason"] = (
        str(payload.get("reason") or "").strip()[:64] or "manual_pause"
    )

    snapshot_data["training_lesson"] = lesson_state
    persist_training_scene(snapshot, snapshot_data, scene)
    session_obj.status = SessionStatus.PAUSED


def apply_resume_lesson_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    session_obj = db.get(SimulationSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session_obj.status != SessionStatus.PAUSED:
        raise HTTPException(status_code=409, detail="Lesson is not paused")

    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)
    lesson_state = clone_json_dict(snapshot_data.get("training_lesson"))

    lifecycle_status = normalize_lesson_lifecycle_status(
        lesson_state.get("lifecycle_status"), lesson_state.get("status")
    )
    if lifecycle_status not in {LESSON_LIFECYCLE_PAUSED, LESSON_LIFECYCLE_RUNNING}:
        raise HTTPException(
            status_code=409,
            detail="Lesson state does not allow resume",
        )

    resumed_at = utcnow().isoformat()
    resume_count = as_non_negative_int(lesson_state.get("resume_count"), 0) or 0
    lesson_state["lifecycle_status"] = LESSON_LIFECYCLE_RUNNING
    lesson_state["status"] = lesson_legacy_status_from_lifecycle(
        LESSON_LIFECYCLE_RUNNING
    )
    lesson_state["resumed_at"] = resumed_at
    lesson_state["resumed_by"] = user.username
    lesson_state["resumed_by_user_id"] = str(user.id)
    lesson_state["resume_count"] = resume_count + 1
    lesson_state["resume_reason"] = (
        str(payload.get("reason") or "").strip()[:64] or "manual_resume"
    )
    lesson_state["last_tick_at"] = resumed_at

    snapshot_data["training_lesson"] = lesson_state
    persist_training_scene(snapshot, snapshot_data, scene)
    session_obj.status = SessionStatus.IN_PROGRESS


def apply_finish_lesson_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    session_obj = db.get(SimulationSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session_obj.status not in {SessionStatus.IN_PROGRESS, SessionStatus.PAUSED}:
        raise HTTPException(status_code=409, detail="Lesson is not active")

    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    finished_at = utcnow().isoformat()
    lesson_state_raw = snapshot_data.get("training_lesson")
    lesson_state = clone_json_dict(lesson_state_raw)
    lesson_state["lifecycle_status"] = LESSON_LIFECYCLE_COMPLETED
    lesson_state["status"] = lesson_legacy_status_from_lifecycle(
        LESSON_LIFECYCLE_COMPLETED
    )
    lesson_state["finished_at"] = finished_at
    lesson_state["finished_by"] = user.username
    lesson_state["finished_by_user_id"] = str(user.id)
    lesson_state["session_id"] = str(session_id)
    if "started_at" not in lesson_state:
        lesson_state["started_at"] = finished_at
    snapshot_data["training_lesson"] = lesson_state

    radio_runtime = ensure_radio_runtime(snapshot_data)
    snapshot_data["lesson_result"] = {
        "status": "COMPLETED",
        "completed_at": finished_at,
        "completed_by": user.username,
        "completed_by_user_id": str(user.id),
        "session_id": str(session_id),
        "reason": str(payload.get("reason") or "lesson_finish").strip()[:48]
        or "lesson_finish",
        "radio_summary": summarize_radio_logs_for_lesson(radio_runtime),
    }

    persist_training_scene(snapshot, snapshot_data, scene)
    session_obj.status = SessionStatus.COMPLETED


def apply_realtime_command(
    db,
    user: User,
    session_id: UUID,
    command: str,
    payload: dict[str, Any],
) -> None:
    assert_role_allowed_for_command(user, command)
    assert_scene_command_allowed_for_session(db, session_id, command, payload)

    if command == "update_weather":
        apply_update_weather_command(db, session_id, payload)
        return
    if command == "create_fire_object":
        apply_create_fire_object_command(db, session_id, payload)
        return
    if command == "create_resource_deployment":
        apply_create_resource_deployment_command(db, session_id, user, payload)
        return
    if command == "push_radio_message":
        apply_push_radio_message_command(db, session_id, user, payload)
        return
    if command == "set_radio_interference":
        apply_set_radio_interference_command(db, session_id, user, payload)
        return
    if command == "update_snapshot":
        apply_update_snapshot_command(db, session_id, payload)
        return
    if command == "set_scene_address":
        apply_set_scene_address_command(db, session_id, payload)
        return
    if command == "upsert_scene_floor":
        apply_upsert_scene_floor_command(db, session_id, payload)
        return
    if command == "set_active_scene_floor":
        apply_set_active_scene_floor_command(db, session_id, payload)
        return
    if command == "upsert_scene_object":
        apply_upsert_scene_object_command(db, session_id, payload)
        return
    if command == "remove_scene_object":
        apply_remove_scene_object_command(db, session_id, payload)
        return
    if command == "sync_scene_to_fire_objects":
        apply_sync_scene_to_fire_objects_command(db, session_id)
        return
    if command == "save_scene_checkpoint":
        apply_save_scene_checkpoint_command(db, session_id, user, payload)
        return
    if command == "start_lesson":
        apply_start_lesson_command(db, session_id, user, payload)
        return
    if command == "pause_lesson":
        apply_pause_lesson_command(db, session_id, user, payload)
        return
    if command == "resume_lesson":
        apply_resume_lesson_command(db, session_id, user, payload)
        return
    if command == "finish_lesson":
        apply_finish_lesson_command(db, session_id, user, payload)
        return
    raise HTTPException(status_code=400, detail="Unknown command")


async def safe_send_json(websocket: WebSocket, payload: dict[str, Any]) -> None:
    try:
        await websocket.send_json(payload)
    except Exception:
        return


def command_cache_key(user_id: UUID, session_id: UUID, command_id: str) -> str:
    return f"{user_id}:{session_id}:{command_id}"


@ws_router.websocket("/api/ws")
async def realtime_ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    current_user_id: UUID | None = None
    current_auth_session_id: UUID | None = None
    current_session_id: UUID | None = None
    command_times: list[datetime] = []

    try:
        auth_message = await websocket.receive_json()
        if not isinstance(auth_message, dict) or auth_message.get("type") != "auth":
            await safe_send_json(
                websocket,
                {
                    "type": "auth_error",
                    "detail": "Auth handshake is required as first message",
                    "code": "AUTH_HANDSHAKE_REQUIRED",
                },
            )
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        access_token = auth_message.get("accessToken")
        if not isinstance(access_token, str) or not access_token.strip():
            await safe_send_json(
                websocket,
                {
                    "type": "auth_error",
                    "detail": "accessToken is required",
                    "code": "AUTH_TOKEN_REQUIRED",
                },
            )
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        requested_session_id: UUID | None = None
        if auth_message.get("sessionId") is not None:
            requested_session_id = parse_uuid(
                auth_message.get("sessionId"), "sessionId"
            )

        with SessionLocal() as db:
            user, auth_session = get_auth_context_from_access_token(db, access_token)
            current_user_id = user.id
            current_auth_session_id = auth_session.id

            if requested_session_id is None:
                requested_session_id = user.session_id

            if requested_session_id is not None:
                if not has_permission(user, "sessions:read"):
                    raise HTTPException(
                        status_code=403, detail="Not enough permissions"
                    )
                assert_session_scope(user, requested_session_id)
                if db.get(SimulationSession, requested_session_id) is None:
                    raise HTTPException(status_code=404, detail="Session not found")

            role_names = sorted({normalize_role_name(role.name) for role in user.roles})

        current_session_id = requested_session_id
        if current_session_id is not None:
            await ws_connections.subscribe(current_session_id, websocket)

        await websocket.send_json(
            {
                "type": "auth_ok",
                "userId": str(current_user_id),
                "sessionId": str(current_session_id) if current_session_id else None,
                "roles": role_names,
                "serverTime": utcnow().isoformat(),
            }
        )

        if current_session_id is not None:
            with SessionLocal() as db:
                initial_bundle = get_session_state_payload(db, current_session_id)
            await websocket.send_json(
                {
                    "type": "session_state",
                    "sessionId": str(current_session_id),
                    "bundle": initial_bundle,
                }
            )

        while True:
            command_id_for_error: str | None = None
            try:
                if current_session_id is None:
                    message = await websocket.receive_json()
                else:
                    try:
                        message = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=SIMULATION_LOOP_INTERVAL_SEC,
                        )
                    except asyncio.TimeoutError:
                        await maybe_apply_runtime_tick_and_broadcast(current_session_id)
                        continue

                if not isinstance(message, dict):
                    raise HTTPException(
                        status_code=422,
                        detail="Message must be object",
                    )

                message_type = message.get("type")
                if message_type == "ping":
                    await websocket.send_json(
                        {"type": "pong", "serverTime": utcnow().isoformat()}
                    )
                    continue

                if message_type == "subscribe_session":
                    target_session_id = parse_uuid(
                        message.get("sessionId"), "sessionId"
                    )
                    with SessionLocal() as db:
                        user = ensure_ws_actor_active(
                            db, current_user_id, current_auth_session_id
                        )
                        if not has_permission(user, "sessions:read"):
                            raise HTTPException(
                                status_code=403, detail="Not enough permissions"
                            )
                        assert_session_scope(user, target_session_id)
                        if db.get(SimulationSession, target_session_id) is None:
                            raise HTTPException(
                                status_code=404, detail="Session not found"
                            )
                        bundle = get_session_state_payload(db, target_session_id)

                    current_session_id = target_session_id
                    await ws_connections.subscribe(current_session_id, websocket)
                    await websocket.send_json(
                        {"type": "subscribed", "sessionId": str(current_session_id)}
                    )
                    await websocket.send_json(
                        {
                            "type": "session_state",
                            "sessionId": str(current_session_id),
                            "bundle": bundle,
                        }
                    )
                    continue

                if message_type != "command":
                    raise HTTPException(status_code=400, detail="Unknown message type")

                command_id = message.get("commandId")
                if not isinstance(command_id, str) or len(command_id.strip()) == 0:
                    raise HTTPException(status_code=422, detail="commandId is required")
                if len(command_id) > WS_MAX_COMMAND_ID_LENGTH:
                    raise HTTPException(status_code=422, detail="commandId is too long")
                command_id_for_error = command_id

                command_name = message.get("command")
                if not isinstance(command_name, str) or len(command_name.strip()) == 0:
                    raise HTTPException(status_code=422, detail="command is required")
                if len(command_name) > WS_MAX_COMMAND_NAME_LENGTH:
                    raise HTTPException(status_code=422, detail="command is too long")

                payload = message.get("payload", {})
                if not isinstance(payload, dict):
                    raise HTTPException(
                        status_code=422, detail="payload must be object"
                    )
                payload_size = len(json.dumps(payload, ensure_ascii=False))
                if payload_size > WS_MAX_PAYLOAD_JSON_BYTES:
                    raise HTTPException(status_code=413, detail="payload is too large")

                target_session_id: UUID | None = current_session_id
                if message.get("sessionId") is not None:
                    target_session_id = parse_uuid(
                        message.get("sessionId"), "sessionId"
                    )

                if target_session_id is None:
                    raise HTTPException(
                        status_code=422, detail="No active session selected"
                    )

                permission = WS_COMMAND_PERMISSIONS.get(command_name)
                if permission is None:
                    raise HTTPException(status_code=400, detail="Unknown command")

                enforce_ws_rate_limit(command_times)
                cache_key = command_cache_key(
                    current_user_id, target_session_id, command_id
                )
                cached_ack = await ws_idempotency.get(cache_key)
                if cached_ack is not None:
                    duplicate_ack = {**cached_ack, "status": "duplicate"}
                    await websocket.send_json(duplicate_ack)
                    continue

                session_lock = await get_session_runtime_tick_lock(target_session_id)
                async with session_lock:
                    with SessionLocal() as db:
                        user = ensure_ws_actor_active(
                            db, current_user_id, current_auth_session_id
                        )
                        if not has_permission(user, permission):
                            raise HTTPException(
                                status_code=403, detail="Not enough permissions"
                            )
                        assert_session_scope(user, target_session_id)
                        session_obj = db.get(SimulationSession, target_session_id)
                        if session_obj is None:
                            raise HTTPException(
                                status_code=404, detail="Session not found"
                            )

                        apply_lesson_runtime_tick_for_session(db, session_obj)
                        apply_realtime_command(
                            db, user, target_session_id, command_name, payload
                        )
                        db.commit()

                    with SessionLocal() as db:
                        if command_name == "push_radio_message":
                            bundle = get_radio_optimized_session_state_payload(
                                db, target_session_id
                            )
                        else:
                            bundle = get_session_state_payload(db, target_session_id)

                ack_message = {
                    "type": "ack",
                    "commandId": command_id,
                    "status": "applied",
                    "command": command_name,
                    "sessionId": str(target_session_id),
                    "serverTime": utcnow().isoformat(),
                }
                await ws_idempotency.put(cache_key, ack_message)
                await websocket.send_json(ack_message)

                state_message = {
                    "type": "session_state",
                    "sessionId": str(target_session_id),
                    "bundle": bundle,
                }
                if command_name != "push_radio_message":
                    await websocket.send_json(state_message)
                await ws_connections.broadcast(
                    target_session_id, state_message, skip=websocket
                )
            except HTTPException as exc:
                await safe_send_json(
                    websocket,
                    {
                        "type": "error",
                        "detail": str(exc.detail),
                        "code": "HTTP_ERROR",
                        "status": exc.status_code,
                        **(
                            {"commandId": command_id_for_error}
                            if command_id_for_error
                            else {}
                        ),
                    },
                )
                continue
            except WebSocketDisconnect:
                raise
            except Exception:
                await safe_send_json(
                    websocket,
                    {
                        "type": "error",
                        "detail": "Internal realtime server error",
                        "code": "INTERNAL_ERROR",
                        **(
                            {"commandId": command_id_for_error}
                            if command_id_for_error
                            else {}
                        ),
                    },
                )
                continue

    except WebSocketDisconnect:
        return
    except HTTPException as exc:
        await safe_send_json(
            websocket,
            {
                "type": "error",
                "detail": str(exc.detail),
                "code": "HTTP_ERROR",
            },
        )
        try:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        except Exception:
            return
    except Exception:
        await safe_send_json(
            websocket,
            {
                "type": "error",
                "detail": "Internal realtime server error",
                "code": "INTERNAL_ERROR",
            },
        )
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:
            return
    finally:
        await ws_connections.unsubscribe(websocket)
