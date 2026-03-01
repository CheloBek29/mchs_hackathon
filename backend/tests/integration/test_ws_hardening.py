from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


@pytest.mark.postgres
def test_ws_command_idempotency_duplicate_ack(
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
    admin_headers = {"Authorization": f"Bearer {access_token}"}

    session_response = client.post(
        "/api/sessions",
        headers=admin_headers,
        json={"scenario_name": "WS Session"},
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

        command_id = str(uuid4())
        websocket.send_json(
            {
                "type": "command",
                "commandId": command_id,
                "command": "create_fire_object",
                "sessionId": session_id,
                "payload": {
                    "name": "ws-fire",
                    "kind": "FIRE_SEAT",
                    "geometry_type": "POINT",
                    "geometry": {"x": 10, "y": 10},
                },
            }
        )
        ack = websocket.receive_json()
        assert ack["type"] == "ack"
        assert ack["status"] == "applied"
        updated_state = websocket.receive_json()
        assert updated_state["type"] == "session_state"

        websocket.send_json(
            {
                "type": "command",
                "commandId": command_id,
                "command": "create_fire_object",
                "sessionId": session_id,
                "payload": {
                    "name": "ws-fire",
                    "kind": "FIRE_SEAT",
                    "geometry_type": "POINT",
                    "geometry": {"x": 10, "y": 10},
                },
            }
        )
        duplicate_ack = websocket.receive_json()
        assert duplicate_ack["type"] == "ack"
        assert duplicate_ack["status"] == "duplicate"


@pytest.mark.postgres
def test_ws_revalidates_revoked_auth_session(
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
        json={"scenario_name": "WS Revoked Session"},
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
        assert websocket.receive_json()["type"] == "auth_ok"
        assert websocket.receive_json()["type"] == "session_state"

        revoke_response = client.post("/api/auth/logout", headers=headers)
        assert revoke_response.status_code == 204, revoke_response.text

        websocket.send_json(
            {
                "type": "command",
                "commandId": str(uuid4()),
                "command": "update_snapshot",
                "sessionId": session_id,
                "payload": {"sim_time_seconds": 5},
            }
        )
        error_message = websocket.receive_json()
        assert error_message["type"] == "error"
        assert error_message["status"] == 401
