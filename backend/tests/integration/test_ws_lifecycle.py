from __future__ import annotations

import time
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


def _assert_fire_runtime_schema(bundle: dict[str, Any]) -> None:
    snapshot = bundle.get("snapshot") or {}
    snapshot_data = snapshot.get("snapshot_data") or {}
    fire_runtime = snapshot_data.get("fire_runtime") or {}
    assert fire_runtime.get("schema_version") == "2.0"


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

    for _ in range(12):
        message = websocket.receive_json()
        if message.get("type") == "ack" and message.get("commandId") == command_id:
            assert message["status"] == "applied"
            assert message["command"] == command
            break
    else:
        raise AssertionError(f"Did not receive ack for commandId={command_id}")

    for _ in range(12):
        state = websocket.receive_json()
        if state.get("type") == "session_state" and state.get("sessionId") == session_id:
            return state
    raise AssertionError("Did not receive session_state after ack")


@pytest.mark.postgres
def test_ws_lifecycle_commands_keep_runtime_schema(
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
    headers = {"Authorization": f"Bearer {access_token}"}

    session_response = client.post(
        "/api/sessions",
        headers=headers,
        json={"scenario_name": "WS Lifecycle Session"},
    )
    assert session_response.status_code == 201, session_response.text
    session_id = session_response.json()["id"]

    with client.websocket_connect("/api/ws") as websocket:
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
        assert initial_state["bundle"].get("snapshot") is None

        start_state = _send_command(
            websocket,
            session_id=session_id,
            command="start_lesson",
            payload={"reason": "ws_lifecycle_smoke"},
        )
        start_bundle = start_state["bundle"]
        assert start_bundle["session"]["status"] == "IN_PROGRESS"
        assert (
            start_bundle["snapshot"]["snapshot_data"]["training_lesson"][
                "lifecycle_status"
            ]
            == "RUNNING"
        )

        # Runtime schema appears after the first simulation tick while running.
        time.sleep(1.1)

        pause_state = _send_command(
            websocket,
            session_id=session_id,
            command="pause_lesson",
            payload={"reason": "ws_lifecycle_pause"},
        )
        pause_bundle = pause_state["bundle"]
        assert pause_bundle["session"]["status"] == "PAUSED"
        assert (
            pause_bundle["snapshot"]["snapshot_data"]["training_lesson"][
                "lifecycle_status"
            ]
            == "PAUSED"
        )
        _assert_fire_runtime_schema(pause_bundle)

        resume_state = _send_command(
            websocket,
            session_id=session_id,
            command="resume_lesson",
            payload={"reason": "ws_lifecycle_resume"},
        )
        resume_bundle = resume_state["bundle"]
        assert resume_bundle["session"]["status"] == "IN_PROGRESS"
        assert (
            resume_bundle["snapshot"]["snapshot_data"]["training_lesson"][
                "lifecycle_status"
            ]
            == "RUNNING"
        )
        _assert_fire_runtime_schema(resume_bundle)

        finish_state = _send_command(
            websocket,
            session_id=session_id,
            command="finish_lesson",
            payload={"reason": "ws_lifecycle_finish"},
        )
        finish_bundle = finish_state["bundle"]
        assert finish_bundle["session"]["status"] == "COMPLETED"
        assert (
            finish_bundle["snapshot"]["snapshot_data"]["training_lesson"][
                "lifecycle_status"
            ]
            == "COMPLETED"
        )
        _assert_fire_runtime_schema(finish_bundle)
