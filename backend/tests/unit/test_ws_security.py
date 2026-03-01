from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID

import pytest
from fastapi import HTTPException

from app.enums import DeploymentStatus, ResourceKind
from app.ws import (
    WS_MAX_COMMANDS_PER_WINDOW,
    CommandIdempotencyStore,
    assert_deployment_workflow_allowed_for_role,
    assert_radio_channel_write_allowed,
    assert_role_allowed_for_command,
    assert_scene_upsert_allowed_during_lesson,
    command_cache_key,
    enforce_ws_rate_limit,
    is_dispatcher_vehicle_dispatch,
    parse_dispatch_code,
    parse_lesson_start_settings,
    parse_radio_channel,
    validate_dispatcher_vehicle_call_resource_data,
)


def make_user_with_roles(*role_names: str):
    return cast(
        Any,
        SimpleNamespace(
            id=UUID("00000000-0000-0000-0000-000000000099"),
            username="test-user",
            roles=[SimpleNamespace(name=role_name) for role_name in role_names],
        ),
    )


@pytest.mark.asyncio
async def test_command_idempotency_store_put_get_roundtrip() -> None:
    store = CommandIdempotencyStore(ttl_seconds=60, max_entries=100)
    key = "u:s:command-1"
    payload = {"type": "ack", "status": "applied"}

    assert await store.get(key) is None

    await store.put(key, payload)
    read_payload = await store.get(key)

    assert read_payload == payload


def test_rate_limit_blocks_burst() -> None:
    command_times = []
    for _ in range(WS_MAX_COMMANDS_PER_WINDOW):
        enforce_ws_rate_limit(command_times)

    with pytest.raises(HTTPException) as exc_info:
        enforce_ws_rate_limit(command_times)
    assert exc_info.value.status_code == 429


def test_command_cache_key_is_stable() -> None:
    key = command_cache_key(
        user_id="00000000-0000-0000-0000-000000000001",
        session_id="00000000-0000-0000-0000-000000000002",
        command_id="cmd-123",
    )
    assert (
        key
        == "00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002:cmd-123"
    )


def test_scene_upsert_allows_hydrant_runtime_update() -> None:
    existing_object = {
        "id": "obj-h1",
        "kind": "HYDRANT",
        "geometry_type": "POINT",
        "geometry": {"x": 15, "y": -4},
    }
    payload = {
        "object_id": "obj-h1",
        "kind": "HYDRANT",
        "geometry_type": "POINT",
        "geometry": {"x": 15, "y": -4},
        "props": {"is_operational": False},
    }

    assert_scene_upsert_allowed_during_lesson(payload, existing_object)


def test_scene_upsert_rejects_hydrant_geometry_move_during_lesson() -> None:
    existing_object = {
        "id": "obj-h1",
        "kind": "HYDRANT",
        "geometry_type": "POINT",
        "geometry": {"x": 15, "y": -4},
    }
    payload = {
        "object_id": "obj-h1",
        "kind": "HYDRANT",
        "geometry_type": "POINT",
        "geometry": {"x": 18, "y": -4},
        "props": {"is_operational": False},
    }

    with pytest.raises(HTTPException) as exc_info:
        assert_scene_upsert_allowed_during_lesson(payload, existing_object)
    assert exc_info.value.status_code == 409


def test_scene_upsert_rejects_new_object_during_lesson() -> None:
    payload = {
        "kind": "HYDRANT",
        "geometry_type": "POINT",
        "geometry": {"x": 5, "y": 5},
        "props": {"is_operational": False},
    }

    with pytest.raises(HTTPException) as exc_info:
        assert_scene_upsert_allowed_during_lesson(payload, None)
    assert exc_info.value.status_code == 409


def test_scene_upsert_rejects_wall_update_without_collapse_flag() -> None:
    existing_object = {
        "id": "obj-w1",
        "kind": "WALL",
        "geometry_type": "LINESTRING",
        "geometry": {"points": [{"x": 0, "y": 0}, {"x": 5, "y": 0}]},
    }
    payload = {
        "object_id": "obj-w1",
        "kind": "WALL",
        "geometry_type": "LINESTRING",
        "geometry": {"points": [{"x": 0, "y": 0}, {"x": 5, "y": 0}]},
        "props": {"integrity": 0},
    }

    with pytest.raises(HTTPException) as exc_info:
        assert_scene_upsert_allowed_during_lesson(payload, existing_object)
    assert exc_info.value.status_code == 409


def test_command_role_restriction_blocks_hq_updating_snapshot() -> None:
    hq_user = make_user_with_roles("HQ")

    with pytest.raises(HTTPException) as exc_info:
        assert_role_allowed_for_command(hq_user, "update_snapshot")

    assert exc_info.value.status_code == 403


def test_command_role_restriction_allows_dispatcher_updating_snapshot() -> None:
    dispatcher_user = make_user_with_roles("DISPATCHER")
    assert_role_allowed_for_command(dispatcher_user, "update_snapshot")


def test_radio_channel_acl_blocks_hq_transmit_to_bu1_channel() -> None:
    hq_user = make_user_with_roles("HQ")

    with pytest.raises(HTTPException) as exc_info:
        assert_radio_channel_write_allowed(hq_user, "3")

    assert exc_info.value.status_code == 403


def test_radio_channel_acl_allows_bu1_transmit_to_bu1_channel() -> None:
    bu1_user = make_user_with_roles("COMBAT_AREA_1")
    assert_radio_channel_write_allowed(bu1_user, "3")


def test_parse_radio_channel_maps_legacy_alias_to_frequency() -> None:
    assert parse_radio_channel("RTP_BU1") == "3"


def test_parse_radio_channel_accepts_numeric_frequency() -> None:
    assert parse_radio_channel("2") == "2"


def test_parse_dispatch_code_normalizes_to_uppercase() -> None:
    assert parse_dispatch_code("ab2cd34") == "AB2CD34"


def test_parse_dispatch_code_rejects_invalid_alphabet() -> None:
    with pytest.raises(HTTPException) as exc_info:
        parse_dispatch_code("AB0CD34")
    assert exc_info.value.status_code == 422


def test_validate_dispatcher_vehicle_call_resource_data_accepts_eta_seconds_and_code() -> (
    None
):
    resource_data: dict[str, Any] = {
        "dispatch_code": "ab2cd34",
        "dispatch_eta_sec": 90,
        "dispatch_eta_at": "2026-03-01T12:00:00Z",
    }
    validate_dispatcher_vehicle_call_resource_data(resource_data)
    assert resource_data["dispatch_code"] == "AB2CD34"
    assert resource_data["dispatch_eta_sec"] == 90
    assert resource_data["dispatch_eta_min"] == 2


def test_is_dispatcher_vehicle_dispatch_detects_dispatcher_role_tag() -> None:
    hq_user = make_user_with_roles("HQ")
    is_dispatch = is_dispatcher_vehicle_dispatch(
        hq_user,
        ResourceKind.VEHICLE,
        DeploymentStatus.EN_ROUTE,
        {"role": "DISPATCHER"},
    )
    assert is_dispatch is True


def test_parse_lesson_start_settings_clamps_values() -> None:
    parsed = parse_lesson_start_settings(
        {
            "time_limit_sec": 9 * 60 * 60,
            "start_sim_time_seconds": 25 * 60 * 60,
        }
    )
    assert parsed["time_limit_sec"] == 6 * 60 * 60
    assert parsed["start_sim_time_seconds"] == 60 * 60


def test_deployment_workflow_blocks_hq_direct_tactical_placement() -> None:
    hq_user = make_user_with_roles("HQ")
    with pytest.raises(HTTPException) as exc_info:
        assert_deployment_workflow_allowed_for_role(
            hq_user,
            ResourceKind.HOSE_LINE,
            DeploymentStatus.ACTIVE,
            {"role": "HQ"},
        )
    assert exc_info.value.status_code == 403


def test_deployment_workflow_blocks_bu_cross_area_resource() -> None:
    bu1_user = make_user_with_roles("COMBAT_AREA_1")
    with pytest.raises(HTTPException) as exc_info:
        assert_deployment_workflow_allowed_for_role(
            bu1_user,
            ResourceKind.HOSE_LINE,
            DeploymentStatus.ACTIVE,
            {"role": "БУ - 2"},
        )
    assert exc_info.value.status_code == 403
