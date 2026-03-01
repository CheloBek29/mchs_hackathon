from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.mark.postgres
def test_session_scope_blocks_idor_between_users(
    client: TestClient,
    bootstrap_admin_user,
    login_and_get_tokens,
) -> None:
    admin_tokens = login_and_get_tokens(
        client,
        bootstrap_admin_user["login"],
        bootstrap_admin_user["password"],
    )
    admin_headers = {"Authorization": f"Bearer {admin_tokens['access_token']}"}

    session_a = client.post(
        "/api/sessions",
        headers=admin_headers,
        json={"scenario_name": "Session A"},
    )
    assert session_a.status_code == 201, session_a.text
    session_a_id = session_a.json()["id"]

    session_b = client.post(
        "/api/sessions",
        headers=admin_headers,
        json={"scenario_name": "Session B"},
    )
    assert session_b.status_code == 201, session_b.text
    session_b_id = session_b.json()["id"]

    staff_password = "StrongPassw0rd!"
    staff_register = client.post(
        "/api/auth/register",
        json={
            "username": "staff-1",
            "password": staff_password,
            "requested_role": "COMBAT_AREA_1",
        },
    )
    assert staff_register.status_code == 201, staff_register.text
    staff_user_id = staff_register.json()["id"]

    assign_staff_session = client.patch(
        f"/api/users/{staff_user_id}",
        headers=admin_headers,
        json={"session_id": session_a_id},
    )
    assert assign_staff_session.status_code == 200, assign_staff_session.text

    create_snapshot_in_b = client.post(
        "/api/state-snapshots",
        headers=admin_headers,
        json={
            "session_id": session_b_id,
            "sim_time_seconds": 120,
            "time_of_day": "DAY",
            "water_supply_status": "OK",
            "is_current": True,
            "snapshot_data": {"source": "admin"},
            "notes": "Session B state",
        },
    )
    assert create_snapshot_in_b.status_code == 201, create_snapshot_in_b.text

    staff_tokens = login_and_get_tokens(client, "staff-1", staff_password)
    staff_headers = {"Authorization": f"Bearer {staff_tokens['access_token']}"}

    # Staff sees only own assigned session.
    list_sessions = client.get("/api/sessions", headers=staff_headers)
    assert list_sessions.status_code == 200
    returned_ids = {item["id"] for item in list_sessions.json()}
    assert returned_ids == {session_a_id}

    # Direct access to foreign session is blocked.
    foreign_state = client.get(f"/api/sessions/{session_b_id}/state", headers=staff_headers)
    assert foreign_state.status_code == 403

    foreign_snapshots = client.get(
        f"/api/state-snapshots?session_id={session_b_id}",
        headers=staff_headers,
    )
    assert foreign_snapshots.status_code == 403


@pytest.mark.postgres
def test_non_admin_cannot_revoke_other_user_session(
    client: TestClient,
    bootstrap_admin_user,
    login_and_get_tokens,
) -> None:
    admin_tokens = login_and_get_tokens(
        client,
        bootstrap_admin_user["login"],
        bootstrap_admin_user["password"],
    )
    admin_headers = {"Authorization": f"Bearer {admin_tokens['access_token']}"}

    staff_password = "StrongPassw0rd!"
    staff_register = client.post(
        "/api/auth/register",
        json={
            "username": "staff-2",
            "password": staff_password,
            "requested_role": "COMBAT_AREA_1",
        },
    )
    assert staff_register.status_code == 201, staff_register.text

    staff_tokens = login_and_get_tokens(client, "staff-2", staff_password)
    staff_headers = {"Authorization": f"Bearer {staff_tokens['access_token']}"}

    admin_sessions = client.get("/api/auth/sessions", headers=admin_headers)
    assert admin_sessions.status_code == 200, admin_sessions.text
    admin_session_id = admin_sessions.json()[0]["id"]

    revoke_attempt = client.post(
        "/api/auth/revoke",
        headers=staff_headers,
        json={"session_id": admin_session_id},
    )
    assert revoke_attempt.status_code == 403
