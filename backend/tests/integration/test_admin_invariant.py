from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.mark.postgres
def test_public_register_cannot_assign_admin(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "username": "hacker",
            "password": "StrongPassw0rd!",
            "requested_role": "ADMIN",
        },
    )
    assert response.status_code in (400, 422)


@pytest.mark.postgres
def test_single_admin_transfer_flow(
    client: TestClient,
    bootstrap_admin_user,
    login_and_get_tokens,
) -> None:
    target_password = "StrongPassw0rd!"
    target_login = "target-admin"
    target_register = client.post(
        "/api/auth/register",
        json={
            "username": target_login,
            "password": target_password,
            "requested_role": "COMBAT_AREA_1",
        },
    )
    assert target_register.status_code == 201, target_register.text
    target_user_id = target_register.json()["id"]

    admin_tokens = login_and_get_tokens(
        client,
        bootstrap_admin_user["login"],
        bootstrap_admin_user["password"],
    )
    admin_headers = {"Authorization": f"Bearer {admin_tokens['access_token']}"}

    # ADMIN cannot be assigned via generic roles endpoint.
    direct_admin_assign = client.patch(
        f"/api/users/{target_user_id}/roles",
        headers=admin_headers,
        json={"roles": ["ADMIN"]},
    )
    assert direct_admin_assign.status_code == 400

    transfer_response = client.post(
        "/api/admin/transfer",
        headers=admin_headers,
        json={"new_admin_user_id": target_user_id},
    )
    assert transfer_response.status_code == 200, transfer_response.text
    assert transfer_response.json()["id"] == target_user_id

    # Old admin loses ADMIN rights after transfer.
    old_admin_lock_read = client.get("/api/admin/lock", headers=admin_headers)
    assert old_admin_lock_read.status_code == 403

    new_admin_tokens = login_and_get_tokens(client, target_login, target_password)
    new_admin_headers = {"Authorization": f"Bearer {new_admin_tokens['access_token']}"}

    lock_read = client.get("/api/admin/lock", headers=new_admin_headers)
    assert lock_read.status_code == 200, lock_read.text
    assert lock_read.json()["admin_user_id"] == target_user_id

    # Current locked admin cannot be deactivated without transfer.
    deactivate_admin = client.patch(
        f"/api/users/{target_user_id}",
        headers=new_admin_headers,
        json={"is_active": False},
    )
    assert deactivate_admin.status_code == 409
