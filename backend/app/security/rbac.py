from __future__ import annotations

from collections.abc import Iterable
from uuid import UUID

from fastapi import Depends, HTTPException, status

from ..auth import get_current_user, normalize_role_name
from ..enums import UserRole
from ..models import User

PermissionName = str


PERMISSION_MATRIX: dict[PermissionName, frozenset[UserRole]] = {
    "sessions:read": frozenset(
        {
            UserRole.ADMIN,
            UserRole.COMBAT_AREA_1,
            UserRole.COMBAT_AREA_2,
            UserRole.DISPATCHER,
            UserRole.HQ,
            UserRole.RTP,
            UserRole.TRAINING_LEAD,
        }
    ),
    "sessions:write": frozenset(
        {UserRole.ADMIN, UserRole.DISPATCHER, UserRole.TRAINING_LEAD}
    ),
    "state:read": frozenset(
        {
            UserRole.ADMIN,
            UserRole.COMBAT_AREA_1,
            UserRole.COMBAT_AREA_2,
            UserRole.DISPATCHER,
            UserRole.HQ,
            UserRole.RTP,
            UserRole.TRAINING_LEAD,
        }
    ),
    "state:write": frozenset(
        {
            UserRole.ADMIN,
            UserRole.COMBAT_AREA_1,
            UserRole.COMBAT_AREA_2,
            UserRole.DISPATCHER,
            UserRole.HQ,
            UserRole.RTP,
            UserRole.TRAINING_LEAD,
        }
    ),
    "scene:write": frozenset(
        {
            UserRole.ADMIN,
            UserRole.TRAINING_LEAD,
        }
    ),
    "vehicles:read": frozenset(
        {
            UserRole.ADMIN,
            UserRole.COMBAT_AREA_1,
            UserRole.COMBAT_AREA_2,
            UserRole.DISPATCHER,
            UserRole.HQ,
            UserRole.RTP,
            UserRole.TRAINING_LEAD,
        }
    ),
    "vehicles:write": frozenset({UserRole.ADMIN, UserRole.TRAINING_LEAD}),
    "users:manage": frozenset({UserRole.ADMIN}),
    "admin:manage": frozenset({UserRole.ADMIN}),
}

# Roles that can access data from any simulation session.
GLOBAL_SESSION_SCOPE_ROLES: frozenset[UserRole] = frozenset(
    {UserRole.ADMIN, UserRole.DISPATCHER, UserRole.TRAINING_LEAD}
)


def canonical_user_roles(user: User) -> set[UserRole]:
    roles: set[UserRole] = set()
    for role in user.roles:
        normalized = normalize_role_name(role.name)
        try:
            roles.add(UserRole(normalized))
        except ValueError:
            continue
    return roles


def has_any_role(user: User, allowed_roles: Iterable[UserRole]) -> bool:
    return bool(canonical_user_roles(user).intersection(set(allowed_roles)))


def has_permission(user: User, permission: PermissionName) -> bool:
    allowed_roles = PERMISSION_MATRIX.get(permission)
    if allowed_roles is None:
        raise RuntimeError(f"Unknown permission: {permission}")
    return has_any_role(user, allowed_roles)


def require_permission(permission: PermissionName):
    def dependency(user: User = Depends(get_current_user)) -> User:
        if has_permission(user, permission):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not enough permissions",
        )

    return dependency


def has_global_session_scope(user: User) -> bool:
    return has_any_role(user, GLOBAL_SESSION_SCOPE_ROLES)


def assert_session_scope(user: User, session_id: UUID) -> None:
    if has_global_session_scope(user):
        return
    if user.session_id is None or user.session_id != session_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not enough permissions for this session",
        )
