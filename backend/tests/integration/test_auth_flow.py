from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def register_user(
    client: TestClient,
    *,
    login: str,
    password: str,
    requested_role: str,
) -> dict:
    response = client.post(
        "/api/auth/register",
        json={
            "username": login,
            "password": password,
            "requested_role": requested_role,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.postgres
def test_register_login_refresh_logout_flow(
    client: TestClient,
    login_and_get_tokens,
) -> None:
    register_user(
        client,
        login="dispatcher",
        password="StrongPassw0rd!",
        requested_role="DISPATCHER",
    )

    tokens = login_and_get_tokens(client, "dispatcher", "StrongPassw0rd!")
    access_headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    me_response = client.get("/api/auth/me", headers=access_headers)
    assert me_response.status_code == 200, me_response.text
    assert me_response.json()["username"] == "dispatcher"

    sessions_response = client.get("/api/auth/sessions", headers=access_headers)
    assert sessions_response.status_code == 200, sessions_response.text
    assert len(sessions_response.json()) == 1

    refresh_response = client.post(
        "/api/auth/refresh",
        json={"refresh_token": tokens["refresh_token"]},
    )
    assert refresh_response.status_code == 200, refresh_response.text
    assert refresh_response.json()["access_token"]

    logout_response = client.post("/api/auth/logout", headers=access_headers)
    assert logout_response.status_code == 204, logout_response.text

    me_after_logout = client.get("/api/auth/me", headers=access_headers)
    assert me_after_logout.status_code == 401


@pytest.mark.postgres
def test_login_lockout_after_failed_attempts(
    client: TestClient,
) -> None:
    register_user(
        client,
        login="locked-user",
        password="StrongPassw0rd!",
        requested_role="COMBAT_AREA_1",
    )

    for _ in range(4):
        invalid_login = client.post(
            "/api/auth/login",
            json={"login": "locked-user", "password": "WrongPassw0rd!"},
        )
        assert invalid_login.status_code == 401, invalid_login.text

    locked_login = client.post(
        "/api/auth/login",
        json={"login": "locked-user", "password": "WrongPassw0rd!"},
    )
    assert locked_login.status_code == 423, locked_login.text
