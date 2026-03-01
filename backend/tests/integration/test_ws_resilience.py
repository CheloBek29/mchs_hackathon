from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import SessionLocal
from app.models import SessionStateSnapshot


def _create_session(client: TestClient, access_token: str, scenario_name: str) -> str:
    headers = {"Authorization": f"Bearer {access_token}"}
    response = client.post(
        "/api/sessions",
        headers=headers,
        json={"scenario_name": scenario_name},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _auth_ws(websocket, *, access_token: str, session_id: str) -> dict[str, Any]:
    websocket.send_json(
        {
            "type": "auth",
            "accessToken": access_token,
            "sessionId": session_id,
        }
    )
    auth_ok = websocket.receive_json()
    assert auth_ok["type"] == "auth_ok"
    initial_state = websocket.receive_json()
    assert initial_state["type"] == "session_state"
    assert initial_state["sessionId"] == session_id
    return initial_state["bundle"]


def _send_command(
    websocket,
    *,
    session_id: str,
    command: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    command_id = str(uuid4())
    websocket.send_json(
        {
            "type": "command",
            "commandId": command_id,
            "command": command,
            "sessionId": session_id,
            "payload": payload or {},
        }
    )

    for _ in range(16):
        message = websocket.receive_json()
        if message.get("type") == "ack" and message.get("commandId") == command_id:
            assert message["status"] == "applied"
            assert message["command"] == command
            break
    else:
        raise AssertionError(f"Did not receive ack for commandId={command_id}")

    for _ in range(16):
        state = websocket.receive_json()
        if state.get("type") == "session_state" and state.get("sessionId") == session_id:
            return state["bundle"]
    raise AssertionError("Did not receive session_state after ack")


def _rewind_lesson_last_tick(session_id: str, *, seconds: int = 10) -> None:
    with SessionLocal() as db:
        snapshot = (
            db.execute(
                select(SessionStateSnapshot)
                .where(
                    SessionStateSnapshot.session_id == UUID(session_id),
                    SessionStateSnapshot.is_current.is_(True),
                )
                .order_by(SessionStateSnapshot.captured_at.desc())
            )
            .scalars()
            .first()
        )
        assert snapshot is not None

        snapshot_data = (
            dict(snapshot.snapshot_data)
            if isinstance(snapshot.snapshot_data, dict)
            else {}
        )
        lesson = (
            dict(snapshot_data.get("training_lesson"))
            if isinstance(snapshot_data.get("training_lesson"), dict)
            else {}
        )
        lesson["last_tick_at"] = (
            datetime.now(timezone.utc) - timedelta(seconds=seconds)
        ).isoformat()
        snapshot_data["training_lesson"] = lesson
        snapshot.snapshot_data = snapshot_data
        db.commit()


def _assert_fire_runtime_schema(bundle: dict[str, Any]) -> None:
    snapshot = bundle.get("snapshot") or {}
    snapshot_data = snapshot.get("snapshot_data") or {}
    fire_runtime = snapshot_data.get("fire_runtime") or {}
    assert fire_runtime.get("schema_version") == "2.0"


@pytest.mark.postgres
def test_ws_reconnect_preserves_running_and_paused_state(
    client: TestClient,
    bootstrap_admin_user,
    login_and_get_tokens,
) -> None:
    tokens = login_and_get_tokens(
        client,
        bootstrap_admin_user["login"],
        bootstrap_admin_user["password"],
    )
    access_token = tokens["access_token"]
    session_id = _create_session(
        client,
        access_token,
        scenario_name="WS Reconnect Lifecycle Session",
    )

    with client.websocket_connect("/api/ws") as websocket:
        _auth_ws(websocket, access_token=access_token, session_id=session_id)
        running_bundle = _send_command(
            websocket,
            session_id=session_id,
            command="start_lesson",
            payload={"reason": "reconnect_running"},
        )
        assert running_bundle["session"]["status"] == "IN_PROGRESS"
        assert (
            running_bundle["snapshot"]["snapshot_data"]["training_lesson"][
                "lifecycle_status"
            ]
            == "RUNNING"
        )

    with client.websocket_connect("/api/ws") as websocket:
        bundle_after_reconnect = _auth_ws(
            websocket,
            access_token=access_token,
            session_id=session_id,
        )
        assert bundle_after_reconnect["session"]["status"] == "IN_PROGRESS"
        assert (
            bundle_after_reconnect["snapshot"]["snapshot_data"]["training_lesson"][
                "lifecycle_status"
            ]
            == "RUNNING"
        )

        paused_bundle = _send_command(
            websocket,
            session_id=session_id,
            command="pause_lesson",
            payload={"reason": "reconnect_paused"},
        )
        assert paused_bundle["session"]["status"] == "PAUSED"
        assert (
            paused_bundle["snapshot"]["snapshot_data"]["training_lesson"][
                "lifecycle_status"
            ]
            == "PAUSED"
        )

    with client.websocket_connect("/api/ws") as websocket:
        paused_bundle_after_reconnect = _auth_ws(
            websocket,
            access_token=access_token,
            session_id=session_id,
        )
        assert paused_bundle_after_reconnect["session"]["status"] == "PAUSED"
        assert (
            paused_bundle_after_reconnect["snapshot"]["snapshot_data"][
                "training_lesson"
            ]["lifecycle_status"]
            == "PAUSED"
        )


@pytest.mark.postgres
def test_ws_runtime_soak_emulated_15min_no_drift(
    client: TestClient,
    bootstrap_admin_user,
    login_and_get_tokens,
) -> None:
    tokens = login_and_get_tokens(
        client,
        bootstrap_admin_user["login"],
        bootstrap_admin_user["password"],
    )
    access_token = tokens["access_token"]
    session_id = _create_session(
        client,
        access_token,
        scenario_name="WS Runtime Soak Emulated Session",
    )

    with client.websocket_connect("/api/ws") as websocket:
        _auth_ws(websocket, access_token=access_token, session_id=session_id)
        start_bundle = _send_command(
            websocket,
            session_id=session_id,
            command="start_lesson",
            payload={"reason": "runtime_soak_start"},
        )
        assert start_bundle["session"]["status"] == "IN_PROGRESS"

        latest_bundle = start_bundle
        for index in range(96):
            _rewind_lesson_last_tick(session_id, seconds=10)
            latest_bundle = _send_command(
                websocket,
                session_id=session_id,
                command="update_snapshot",
                payload={},
            )
            if index % 20 == 0:
                time.sleep(1.05)

        lesson_state = latest_bundle["snapshot"]["snapshot_data"]["training_lesson"]
        fire_runtime = latest_bundle["snapshot"]["snapshot_data"]["fire_runtime"]
        runtime_health = fire_runtime["runtime_health"]

        assert latest_bundle["session"]["status"] == "IN_PROGRESS"
        assert lesson_state["lifecycle_status"] == "RUNNING"
        assert runtime_health.get("ticks_total", 0) >= 90
        assert runtime_health.get("dropped_ticks_total", 0) >= 0
        assert runtime_health.get("tick_lag_sec", 0) >= 0
        assert latest_bundle["snapshot"]["sim_time_seconds"] > 0
        _assert_fire_runtime_schema(latest_bundle)
