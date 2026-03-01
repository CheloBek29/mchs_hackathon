from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.security.rbac import assert_session_scope, has_global_session_scope, has_permission


def build_user(role_names: list[str], session_id=None):
    return SimpleNamespace(
        roles=[SimpleNamespace(name=role_name) for role_name in role_names],
        session_id=session_id,
    )


def test_admin_has_users_manage_permission() -> None:
    user = build_user(["ADMIN"])
    assert has_permission(user, "users:manage")


def test_combat_area_does_not_have_users_manage_permission() -> None:
    user = build_user(["COMBAT_AREA_1"])
    assert not has_permission(user, "users:manage")


def test_dispatcher_has_global_scope() -> None:
    user = build_user(["DISPATCHER"])
    assert has_global_session_scope(user)


def test_rtp_has_no_global_scope() -> None:
    user = build_user(["RTP"])
    assert not has_global_session_scope(user)


def test_assert_session_scope_allows_owner_session() -> None:
    session_id = uuid4()
    user = build_user(["COMBAT_AREA_1"], session_id=session_id)
    assert_session_scope(user, session_id)


def test_assert_session_scope_rejects_foreign_session() -> None:
    user = build_user(["COMBAT_AREA_1"], session_id=uuid4())
    with pytest.raises(HTTPException) as exc_info:
        assert_session_scope(user, uuid4())
    assert exc_info.value.status_code == 403
