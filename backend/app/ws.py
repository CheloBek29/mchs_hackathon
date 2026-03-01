from __future__ import annotations

import asyncio
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from .auth import get_auth_context_from_access_token, normalize_role_name
from .database import SessionLocal
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
    ResourceDeployment,
    Session as AuthSession,
    SessionStateSnapshot,
    SimulationSession,
    User,
    VehicleDictionary,
    WeatherSnapshot,
)
from .schemas import SessionStateBundleRead
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
    "finish_lesson": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
}
WS_MAX_COMMANDS_PER_WINDOW = 30
WS_RATE_LIMIT_WINDOW_SECONDS = 1
WS_MAX_COMMAND_ID_LENGTH = 128
WS_MAX_COMMAND_NAME_LENGTH = 64
WS_MAX_PAYLOAD_JSON_BYTES = 300_000

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

RADIO_AUDIO_BASE64_MAX_LENGTH = 180_000
RADIO_LOG_LIMIT = 240

DISPATCH_CODE_LENGTH = 7
DISPATCH_CODE_ALPHABET = frozenset("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
DISPATCH_ETA_SEC_MIN = 30
DISPATCH_ETA_SEC_MAX = 120

LESSON_TIME_LIMIT_MIN_SEC = 300
LESSON_TIME_LIMIT_MAX_SEC = 6 * 60 * 60
GAME_DAY_SECONDS = 24 * 60 * 60

SIMULATION_LOOP_INTERVAL_SEC = 1.0
SIMULATION_MAX_STEP_REAL_SEC = 4

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

    if session_obj.status != SessionStatus.IN_PROGRESS:
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
            ResourceKind.NOZZLE,
            ResourceKind.WATER_SOURCE,
        }:
            raise HTTPException(
                status_code=403,
                detail="HQ planning supports markers, hose lines, nozzles and water sources",
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


def normalize_point_tuple(value: Any) -> tuple[float, float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    x = as_float(value[0], float("nan"))
    y = as_float(value[1], float("nan"))
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return (x, y)


def ensure_fire_runtime(snapshot_data: dict[str, Any]) -> dict[str, Any]:
    raw_runtime = snapshot_data.get("fire_runtime")
    runtime = clone_json_dict(raw_runtime)

    raw_vehicle_runtime = runtime.get("vehicle_runtime")
    runtime["vehicle_runtime"] = (
        clone_json_dict(raw_vehicle_runtime)
        if isinstance(raw_vehicle_runtime, dict)
        else {}
    )
    runtime["updated_at"] = runtime.get("updated_at") or utcnow().isoformat()

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

        chain_id = as_non_empty_string(
            resource_data.get("chain_id")
            or resource_data.get("linked_hose_line_chain_id")
            or str(deployment.id)
        )

        linked_vehicle_id = as_non_negative_int(resource_data.get("linked_vehicle_id"))
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
            "strict_chain": strict_chain,
        }
        hose_entries_by_id[str(deployment.id)] = hose_entry
        hose_entries_by_chain_id[chain_id] = hose_entry
        hose_runtime[str(deployment.id)] = {
            "chain_id": chain_id,
            "linked_vehicle_id": linked_vehicle_id,
            "strict_chain": strict_chain,
            "has_water": False,
            "blocked_reason": "NO_LINKED_VEHICLE"
            if strict_chain and linked_vehicle_id in {None, 0}
            else None,
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
        flow_l_s = as_float(
            resource_data.get("nozzle_flow_l_s")
            or resource_data.get("intensity_l_s")
            or resource_data.get("flow_l_s"),
            3.5,
        )
        flow_l_s = max(1.0, min(12.0, flow_l_s))
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
            }
        )
        nozzle_runtime[nozzle_id] = {
            "strict_chain": strict_chain,
            "linked_hose_line_id": linked_hose_line_id,
            "linked_hose_line_chain_id": linked_hose_line_chain_id,
            "linked_vehicle_id": linked_vehicle_id,
            "has_water": False,
            "updated_at": tick_time.isoformat(),
        }

    consumed_water_l = 0.0
    effective_flow_l_s = 0.0
    nozzle_with_water_centers: list[tuple[float, float]] = []

    for nozzle in nozzle_entries:
        nozzle_id = as_non_empty_string(nozzle.get("deployment_id"))
        role_tag = str(nozzle["role"])
        strict_chain = as_bool(nozzle.get("strict_chain"), False)

        linked_hose_entry: dict[str, Any] | None = None
        linked_vehicle_id = as_non_negative_int(nozzle.get("linked_vehicle_id"))

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
            candidates = [
                entry
                for entry in vehicle_entries
                if int(entry["vehicle_id"]) == target_vehicle_id
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

        available_l = float(target_vehicle["water_remaining_l"])
        actual_l = min(available_l, demand_l)
        if actual_l <= 0:
            if nozzle_id in nozzle_runtime:
                nozzle_runtime[nozzle_id]["blocked_reason"] = "NO_WATER_SOURCE"
            continue

        target_vehicle["water_remaining_l"] = max(0.0, available_l - actual_l)
        consumed_water_l += actual_l
        effective_ratio = actual_l / demand_l
        effective_flow = float(nozzle["flow_l_s"]) * effective_ratio
        effective_flow_l_s += effective_flow
        if nozzle_center_point is not None:
            nozzle_with_water_centers.append(nozzle_center_point)

        if nozzle_id in nozzle_runtime:
            nozzle_runtime[nozzle_id]["has_water"] = True
            nozzle_runtime[nozzle_id]["blocked_reason"] = None
            nozzle_runtime[nozzle_id]["effective_flow_l_s"] = round(effective_flow, 3)
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
        vehicle_runtime[str(vehicle_id)] = {
            "water_capacity_l": round(capacity_l, 2),
            "water_remaining_l": round(remaining_l, 2),
            "is_empty": remaining_l <= 0.01,
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
    weather_factor = 1.0 + min(0.85, wind_speed / 20.0)

    suppression_budget_area = effective_flow_l_s * 0.34 * dt_game_sec

    fire_weights: dict[str, float] = {}
    for fire in active_fire_objects:
        current_area = max(5.0, as_float(fire.area_m2, 25.0))
        center = normalize_point_tuple(
            geometry_center(fire.geometry_type, fire.geometry)
        )
        proximity_boost = 1.0
        if center is not None and nozzle_with_water_centers:
            influence = sum(
                1.0 / (12.0 + distance_m(center, nozzle_center))
                for nozzle_center in nozzle_with_water_centers
            )
            proximity_boost += influence * 10.0
        fire_weights[str(fire.id)] = current_area * proximity_boost

    total_fire_weight = sum(fire_weights.values())
    post_fire_area_sum = 0.0

    for fire in active_fire_objects:
        current_area = max(3.0, as_float(fire.area_m2, 25.0))
        spread_speed = max(
            0.25,
            as_float(
                fire.spread_speed_m_min,
                3.0 if fire.kind == FireZoneKind.FIRE_SEAT else 2.0,
            ),
        )

        growth_rate = 0.17 if fire.kind == FireZoneKind.FIRE_SEAT else 0.12
        area_growth = spread_speed * growth_rate * dt_game_sec * weather_factor

        suppression_share = 0.0
        if total_fire_weight > 0 and suppression_budget_area > 0:
            suppression_share = suppression_budget_area * (
                fire_weights.get(str(fire.id), 0.0) / total_fire_weight
            )

        next_area = max(0.0, current_area + area_growth - suppression_share)
        fire.area_m2 = round(next_area, 2)
        fire.perimeter_m = (
            round(2.0 * math.sqrt(math.pi * next_area), 2) if next_area > 0 else 0.0
        )
        fire.spread_speed_m_min = round(
            max(0.2, spread_speed + wind_speed * 0.01 - suppression_share * 0.015),
            3,
        )
        fire.is_active = next_area > 0.8

        extra = clone_json_dict(fire.extra)
        extra["runtime"] = {
            "updated_at": tick_time.isoformat(),
            "suppression_area_m2": round(suppression_share, 2),
            "growth_area_m2": round(area_growth, 2),
        }
        fire.extra = extra

        if fire.is_active:
            post_fire_area_sum += next_area

    for smoke in smoke_objects:
        current_area = max(8.0, as_float(smoke.area_m2, 32.0))
        spread_speed = max(0.6, as_float(smoke.spread_speed_m_min, 1.2))

        smoke_growth = (
            post_fire_area_sum * 0.007 + spread_speed * 0.18 + wind_speed * 0.16
        ) * dt_game_sec
        smoke_dissipation = suppression_budget_area * 0.12

        next_area = max(4.0, current_area + smoke_growth - smoke_dissipation)
        smoke.area_m2 = round(next_area, 2)
        smoke.perimeter_m = round(2.0 * math.sqrt(math.pi * next_area), 2)
        smoke.spread_speed_m_min = round(
            max(0.55, spread_speed + wind_speed * 0.006),
            3,
        )
        smoke.is_active = post_fire_area_sum > 0.5 or next_area > 12.0

        extra = clone_json_dict(smoke.extra)
        extra["runtime"] = {
            "updated_at": tick_time.isoformat(),
            "growth_area_m2": round(smoke_growth, 2),
            "dissipation_area_m2": round(smoke_dissipation, 2),
        }
        smoke.extra = extra

    fire_runtime["vehicle_runtime"] = vehicle_runtime
    fire_runtime["hose_runtime"] = hose_runtime
    fire_runtime["nozzle_runtime"] = nozzle_runtime
    fire_runtime["updated_at"] = tick_time.isoformat()
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
    if str(lesson_state.get("status") or "") != "IN_PROGRESS":
        return False

    tick_time = utcnow()
    started_at = parse_iso_datetime_utc(lesson_state.get("started_at")) or tick_time
    last_tick_at = (
        parse_iso_datetime_utc(lesson_state.get("last_tick_at")) or started_at
    )

    delta_real_sec = int((tick_time - last_tick_at).total_seconds())
    if delta_real_sec <= 0:
        return False
    delta_real_sec = min(delta_real_sec, SIMULATION_MAX_STEP_REAL_SEC)

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

    time_limit_sec = parse_optional_non_negative_int(
        lesson_state.get("time_limit_sec"), "training_lesson.time_limit_sec"
    )
    timeout_reached = bool(
        time_limit_sec is not None
        and time_limit_sec > 0
        and elapsed_game_sec >= time_limit_sec
    )

    if timeout_reached:
        lesson_state["status"] = "COMPLETED"
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

    interference_raw = runtime.get("interference")
    runtime["interference"] = (
        clone_json_dict(interference_raw)
        if isinstance(interference_raw, dict)
        else None
    )

    runtime["updated_at"] = runtime.get("updated_at") or utcnow().isoformat()
    snapshot_data["radio_runtime"] = runtime
    return runtime


def append_radio_log(runtime: dict[str, Any], event: dict[str, Any]) -> None:
    logs_raw = runtime.get("logs")
    logs = (
        [item for item in logs_raw if isinstance(item, dict)]
        if isinstance(logs_raw, list)
        else []
    )
    runtime["logs"] = [event, *logs][:RADIO_LOG_LIMIT]
    runtime["updated_at"] = utcnow().isoformat()


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

    actor_role = pick_radio_actor_role(user)
    event = {
        "id": f"radio_{uuid4().hex[:12]}",
        "kind": "MESSAGE",
        "channel": channel,
        "created_at": utcnow().isoformat(),
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
    }
    append_radio_log(runtime, event)

    snapshot_data["radio_runtime"] = runtime
    snapshot.snapshot_data = snapshot_data


def apply_set_radio_interference_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data = clone_json_dict(snapshot.snapshot_data)
    runtime = ensure_radio_runtime(snapshot_data)

    enabled = parse_optional_bool(payload.get("enabled"), "enabled")
    if enabled is None:
        enabled = True

    actor_role = pick_radio_actor_role(user)
    channel = parse_radio_channel(payload.get("channel", "1"))

    if enabled:
        duration_sec = parse_optional_non_negative_int(
            payload.get("duration_sec"), "duration_sec"
        )
        if duration_sec is None:
            duration_sec = 20
        if duration_sec < 5 or duration_sec > 180:
            raise HTTPException(
                status_code=422,
                detail="duration_sec must be in range [5..180]",
            )

        intensity = parse_non_negative_float(
            payload.get("intensity", 0.65), "intensity"
        )
        if intensity > 1:
            raise HTTPException(status_code=422, detail="intensity must be <= 1")

        started_at = utcnow()
        ends_at = started_at + timedelta(seconds=duration_sec)
        runtime["interference"] = {
            "enabled": True,
            "channel": channel,
            "intensity": intensity,
            "duration_sec": duration_sec,
            "started_at": started_at.isoformat(),
            "ends_at": ends_at.isoformat(),
            "started_by": user.username,
            "started_by_user_id": str(user.id),
            "started_by_role": actor_role,
        }
        append_radio_log(
            runtime,
            {
                "id": f"radio_{uuid4().hex[:12]}",
                "kind": "INTERFERENCE_ON",
                "channel": channel,
                "created_at": started_at.isoformat(),
                "sender_user_id": str(user.id),
                "sender_username": user.username,
                "sender_role": actor_role,
                "duration_sec": duration_sec,
                "intensity": intensity,
                "text": "В эфире помехи",
            },
        )
    else:
        runtime["interference"] = None
        append_radio_log(
            runtime,
            {
                "id": f"radio_{uuid4().hex[:12]}",
                "kind": "INTERFERENCE_OFF",
                "channel": channel,
                "created_at": utcnow().isoformat(),
                "sender_user_id": str(user.id),
                "sender_username": user.username,
                "sender_role": actor_role,
                "text": "Помехи отключены",
            },
        )

    snapshot_data["radio_runtime"] = runtime
    snapshot.snapshot_data = snapshot_data


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
        spread_speed = 3.0 if fire_kind == FireZoneKind.FIRE_SEAT else 1.0

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

    return {
        "area_m2": round(area_m2, 2) if area_m2 is not None else None,
        "spread_speed_m_min": round(spread_speed, 3),
        "spread_azimuth": round(spread_azimuth, 3)
        if spread_azimuth is not None
        else None,
        "is_active": is_active,
        "smoke_density": round(smoke_density, 3) if smoke_density is not None else None,
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
    return bundle.model_dump(mode="json")


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
            "status": "IN_PROGRESS",
            "started_at": saved_at,
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
    lesson_state["status"] = "IN_PROGRESS"
    lesson_state["started_at"] = started_at
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


def apply_finish_lesson_command(
    db,
    session_id: UUID,
    user: User,
    payload: dict[str, Any],
) -> None:
    session_obj = db.get(SimulationSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session_obj.status != SessionStatus.IN_PROGRESS:
        raise HTTPException(status_code=409, detail="Lesson is not in progress")

    snapshot = get_or_create_current_snapshot(db, session_id)
    snapshot_data, scene = ensure_training_scene(snapshot)

    finished_at = utcnow().isoformat()
    lesson_state_raw = snapshot_data.get("training_lesson")
    lesson_state = clone_json_dict(lesson_state_raw)
    lesson_state["status"] = "COMPLETED"
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
                        raise HTTPException(status_code=404, detail="Session not found")

                    apply_lesson_runtime_tick_for_session(db, session_obj)
                    apply_realtime_command(
                        db, user, target_session_id, command_name, payload
                    )
                    db.commit()
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
