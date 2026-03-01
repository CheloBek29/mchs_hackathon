from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


def _register_user(
    client: TestClient,
    *,
    login: str,
    password: str,
    requested_role: str,
) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "username": login,
            "password": password,
            "requested_role": requested_role,
        },
    )
    assert response.status_code == 201, response.text


def _auth_ws(websocket, *, access_token: str, session_id: str) -> None:
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


def _send_command_until_terminal(websocket, payload: dict) -> dict:
    websocket.send_json(payload)
    command_id = payload["commandId"]

    for _ in range(20):
        message = websocket.receive_json()
        message_type = message.get("type")
        if message_type == "session_state":
            continue
        if message_type == "ack":
            assert message.get("commandId") == command_id
            return message
        if message_type == "error" and message.get("commandId") == command_id:
            return message

    raise AssertionError(f"No terminal message received for commandId={command_id}")


@pytest.mark.postgres
def test_bu_actions_blocked_until_rtp_places_command_point(
    client: TestClient,
    bootstrap_admin_user,
    login_and_get_tokens,
) -> None:
    admin_tokens = login_and_get_tokens(
        client,
        bootstrap_admin_user["login"],
        bootstrap_admin_user["password"],
    )
    admin_access_token = admin_tokens["access_token"]
    admin_headers = {"Authorization": f"Bearer {admin_access_token}"}

    session_response = client.post(
        "/api/sessions",
        headers=admin_headers,
        json={"scenario_name": "BU Activation Gate Session"},
    )
    assert session_response.status_code == 201, session_response.text
    session_id = session_response.json()["id"]

    _register_user(
        client,
        login="rtp-gate",
        password="StrongPassw0rd!",
        requested_role="RTP",
    )
    _register_user(
        client,
        login="bu1-gate",
        password="StrongPassw0rd!",
        requested_role="COMBAT_AREA_1",
    )

    rtp_tokens = login_and_get_tokens(client, "rtp-gate", "StrongPassw0rd!")
    bu_tokens = login_and_get_tokens(client, "bu1-gate", "StrongPassw0rd!")
    rtp_access_token = rtp_tokens["access_token"]
    bu_access_token = bu_tokens["access_token"]

    # Triggers default session binding for scoped users.
    rtp_sessions = client.get(
        "/api/sessions",
        headers={"Authorization": f"Bearer {rtp_access_token}"},
    )
    assert rtp_sessions.status_code == 200, rtp_sessions.text
    bu_sessions = client.get(
        "/api/sessions",
        headers={"Authorization": f"Bearer {bu_access_token}"},
    )
    assert bu_sessions.status_code == 200, bu_sessions.text

    with client.websocket_connect("/api/ws") as bu_websocket:
        _auth_ws(
            bu_websocket,
            access_token=bu_access_token,
            session_id=session_id,
        )

        blocked_message = _send_command_until_terminal(
            bu_websocket,
            {
                "type": "command",
                "commandId": str(uuid4()),
                "command": "create_resource_deployment",
                "sessionId": session_id,
                "payload": {
                    "resource_kind": "VEHICLE",
                    "status": "DEPLOYED",
                    "vehicle_dictionary_id": 1,
                    "label": "BU1 AC",
                    "geometry_type": "POINT",
                    "geometry": {"x": 12, "y": 8},
                    "resource_data": {"role": "БУ - 1"},
                },
            },
        )

    assert blocked_message["type"] == "error"
    assert blocked_message["status"] == 409
    assert "РТП" in blocked_message["detail"]

    with client.websocket_connect("/api/ws") as rtp_websocket:
        _auth_ws(
            rtp_websocket,
            access_token=rtp_access_token,
            session_id=session_id,
        )

        marker_ack = _send_command_until_terminal(
            rtp_websocket,
            {
                "type": "command",
                "commandId": str(uuid4()),
                "command": "create_resource_deployment",
                "sessionId": session_id,
                "payload": {
                    "resource_kind": "MARKER",
                    "status": "DEPLOYED",
                    "label": "БУ-1",
                    "geometry_type": "POINT",
                    "geometry": {"x": 20, "y": 10},
                    "resource_data": {
                        "role": "RTP",
                        "command_point": "BU1",
                    },
                },
            },
        )

    assert marker_ack["type"] == "ack"
    assert marker_ack["status"] == "applied"

    with client.websocket_connect("/api/ws") as bu_websocket:
        _auth_ws(
            bu_websocket,
            access_token=bu_access_token,
            session_id=session_id,
        )

        allowed_ack = _send_command_until_terminal(
            bu_websocket,
            {
                "type": "command",
                "commandId": str(uuid4()),
                "command": "create_resource_deployment",
                "sessionId": session_id,
                "payload": {
                    "resource_kind": "VEHICLE",
                    "status": "DEPLOYED",
                    "vehicle_dictionary_id": 1,
                    "label": "BU1 AC",
                    "geometry_type": "POINT",
                    "geometry": {"x": 14, "y": 9},
                    "resource_data": {"role": "БУ - 1"},
                },
            },
        )

    assert allowed_ack["type"] == "ack"
    assert allowed_ack["status"] == "applied"
