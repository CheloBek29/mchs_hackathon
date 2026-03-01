from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import SystemSettingsUpdate, UserCreate


def test_user_create_accepts_login_only() -> None:
    payload = UserCreate(
        username="dispatcher-1",
        password="StrongPassw0rd!",
        requested_role="DISPATCHER",
    )

    assert payload.username == "dispatcher-1"


def test_user_create_rejects_empty_login() -> None:
    with pytest.raises(ValidationError):
        UserCreate(
            username="   ",
            password="StrongPassw0rd!",
            requested_role="COMBAT_AREA_1",
        )


def test_user_create_rejects_weak_password() -> None:
    with pytest.raises(ValidationError):
        UserCreate(
            username="tester",
            password="password",
            requested_role="COMBAT_AREA_1",
        )


def test_user_create_rejects_public_admin_role() -> None:
    with pytest.raises(ValidationError):
        UserCreate(
            username="tester",
            password="StrongPassw0rd!",
            requested_role="ADMIN",
        )


def test_system_settings_update_rejects_invalid_tick_rate() -> None:
    with pytest.raises(ValidationError):
        SystemSettingsUpdate(tick_rate_hz=25)
