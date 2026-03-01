from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException, status
from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import get_password_hash, normalize_role_name
from ..enums import UserRole
from ..models import Role, SystemAdminLock, User
from ..schemas import PASSWORD_POLICY_PATTERN

EMAIL_ADAPTER = TypeAdapter(EmailStr)


def get_or_create_role(db: Session, role_name: str) -> Role:
    canonical_role = normalize_role_name(role_name)
    role = db.execute(select(Role).where(Role.name == canonical_role)).scalars().first()
    if role is not None:
        return role

    role = Role(name=canonical_role)
    db.add(role)
    db.flush()
    return role


def ensure_admin_lock(db: Session, for_update: bool = False) -> SystemAdminLock:
    stmt = select(SystemAdminLock).where(SystemAdminLock.id == 1)
    if for_update:
        stmt = stmt.with_for_update()

    lock = db.execute(stmt).scalars().first()
    if lock is not None:
        return lock

    lock = SystemAdminLock(id=1, admin_user_id=None)
    db.add(lock)
    db.flush()
    return lock


def user_has_admin_role(user: User) -> bool:
    return any(normalize_role_name(role.name) == UserRole.ADMIN.value for role in user.roles)


def is_locked_admin_user(db: Session, user_id: UUID) -> bool:
    lock = ensure_admin_lock(db, for_update=False)
    return lock.admin_user_id == user_id


def _normalize_email_or_400(email: str) -> str:
    try:
        normalized_email = EMAIL_ADAPTER.validate_python(email.strip().lower())
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail="Invalid email format") from exc
    return str(normalized_email)


def _validate_password_or_400(password: str) -> None:
    if not PASSWORD_POLICY_PATTERN.match(password):
        raise HTTPException(
            status_code=400,
            detail="Password must include lower/upper letters, number and special character",
        )


def _remove_admin_role_from_others(db: Session, admin_role: Role, keep_user_id: UUID) -> None:
    admin_users = (
        db.execute(
            select(User)
            .join(User.roles)
            .where(Role.name == UserRole.ADMIN.value, User.id != keep_user_id)
        )
        .scalars()
        .all()
    )
    for user in admin_users:
        if admin_role in user.roles:
            user.roles.remove(admin_role)


def reconcile_single_admin_invariant(db: Session) -> SystemAdminLock:
    lock = ensure_admin_lock(db, for_update=True)
    admin_role = get_or_create_role(db, UserRole.ADMIN.value)
    admin_users = (
        db.execute(
            select(User)
            .join(User.roles)
            .where(Role.name == UserRole.ADMIN.value)
            .order_by(User.created_at.asc())
        )
        .scalars()
        .all()
    )

    if lock.admin_user_id is None and admin_users:
        lock.admin_user_id = admin_users[0].id

    if lock.admin_user_id is not None:
        locked_user = db.get(User, lock.admin_user_id)
        if locked_user is None:
            lock.admin_user_id = None
        else:
            if admin_role not in locked_user.roles:
                locked_user.roles.append(admin_role)
            _remove_admin_role_from_others(db, admin_role, keep_user_id=locked_user.id)

    db.flush()
    return lock


def transfer_admin_role(db: Session, current_admin_user_id: UUID, new_admin_user_id: UUID) -> User:
    lock = ensure_admin_lock(db, for_update=True)
    if lock.admin_user_id is None:
        raise HTTPException(status_code=409, detail="Admin is not initialized")

    if lock.admin_user_id != current_admin_user_id:
        raise HTTPException(status_code=403, detail="Only current admin can transfer admin role")

    new_admin = db.get(User, new_admin_user_id)
    if new_admin is None:
        raise HTTPException(status_code=404, detail="Target user not found")
    if not new_admin.is_active:
        raise HTTPException(status_code=400, detail="Target user must be active")

    admin_role = get_or_create_role(db, UserRole.ADMIN.value)
    if admin_role not in new_admin.roles:
        new_admin.roles.append(admin_role)

    lock.admin_user_id = new_admin.id
    _remove_admin_role_from_others(db, admin_role, keep_user_id=new_admin.id)
    db.flush()
    return new_admin


def bootstrap_first_admin(db: Session, username: str, email: str, password: str) -> User:
    normalized_username = username.strip()
    normalized_email = _normalize_email_or_400(email)
    _validate_password_or_400(password)

    if not normalized_username:
        raise HTTPException(status_code=400, detail="Username is required")

    existing_user = (
        db.execute(
            select(User).where(
                (func.lower(User.email) == normalized_email)
                | (func.lower(User.username) == normalized_username.lower())
            )
        )
        .scalars()
        .first()
    )
    if existing_user is not None:
        raise HTTPException(status_code=400, detail="Username or Email already registered")

    lock = ensure_admin_lock(db, for_update=True)
    if lock.admin_user_id is not None:
        raise HTTPException(status_code=409, detail="Admin already initialized")

    admin_role = get_or_create_role(db, UserRole.ADMIN.value)
    user = User(
        username=normalized_username,
        email=normalized_email,
        password_hash=get_password_hash(password),
    )
    user.roles.append(admin_role)
    db.add(user)
    db.flush()

    lock.admin_user_id = user.id
    _remove_admin_role_from_others(db, admin_role, keep_user_id=user.id)
    db.flush()
    return user
