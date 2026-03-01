from __future__ import annotations

import hashlib
import ipaddress
import os
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .admin import setup_admin
from .auth import (
    REFRESH_TOKEN_EXPIRE_DAYS,
    create_access_token,
    create_refresh_token,
    get_current_session,
    get_current_user,
    get_refresh_token_ids,
    get_password_hash,
    verify_password,
)
from .database import Base, SessionLocal, engine, get_db
from .enums import UserRole
from .models import (
    FireObject,
    Role,
    ResourceDeployment,
    Session as AuthSession,
    SessionStateSnapshot,
    SimulationSession,
    SystemSetting,
    User,
    VehicleDictionary,
    WeatherSnapshot,
)
from .schemas import (
    AuthSessionRead,
    AdminLockRead,
    AdminTransferRequest,
    CurrentUserSessionUpdate,
    FireObjectCreate,
    FireObjectRead,
    FireObjectUpdate,
    RefreshTokenRequest,
    ResourceDeploymentCreate,
    ResourceDeploymentRead,
    ResourceDeploymentUpdate,
    SessionRevokeRequest,
    SessionStateBundleRead,
    SessionStateSnapshotCreate,
    SessionStateSnapshotRead,
    SessionStateSnapshotUpdate,
    SystemSettingsRead,
    SystemSettingsUpdate,
    SimulationSessionCreate,
    SimulationSessionRead,
    SimulationSessionUpdate,
    UserCreate,
    UserLogin,
    UserRolesUpdate,
    Token,
    UserRead,
    UserUpdate,
    VehicleDictionaryCreate,
    VehicleDictionaryRead,
    VehicleDictionaryUpdate,
    WeatherSnapshotCreate,
    WeatherSnapshotRead,
    WeatherSnapshotUpdate,
)
from .security.rate_limit import rate_limit_dependency
from .security.rbac import (
    assert_session_scope,
    has_global_session_scope,
    has_permission,
    require_permission,
)
from .services.admin_lock_service import (
    get_or_create_role,
    is_locked_admin_user,
    reconcile_single_admin_invariant,
    ensure_admin_lock,
    transfer_admin_role,
)
from .vehicle_seed import seed_vehicles_dictionary
from .ws import ws_router


def _parse_allowed_origins(raw_value: str) -> list[str]:
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]


ALLOWED_ORIGINS = _parse_allowed_origins(
    os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://0.0.0.0:5173,http://localhost:4173,http://127.0.0.1:4173",
    )
)
ALLOWED_ORIGIN_REGEX = os.getenv(
    "ALLOWED_ORIGIN_REGEX",
    r"^http://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?$",
)

app = FastAPI(title="MCHS Sprint 1 CRUD", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Device-Id"],
)
setup_admin(app)
app.include_router(ws_router)

INVALID_LOGIN_DETAIL = "Invalid login or password"
LOCKED_LOGIN_DETAIL = "Account temporarily locked. Try again later."
MAX_FAILED_LOGIN_ATTEMPTS = 5
LOCKOUT_DURATION_MINUTES = 15
GLOBAL_SYSTEM_SETTINGS_KEY = "global"
DEFAULT_SYSTEM_SETTINGS = {
    "tick_rate_hz": 30,
    "voice_server_url": "wss://voice.simulator.local",
    "enforce_admin_2fa": True,
    "ip_whitelist_enabled": False,
    "entity_limit": 50000,
}

register_rate_limit = rate_limit_dependency("auth_register", max_requests=5, window_seconds=60)
login_rate_limit = rate_limit_dependency("auth_login", max_requests=10, window_seconds=60)
refresh_rate_limit = rate_limit_dependency("auth_refresh", max_requests=20, window_seconds=60)


@app.on_event("startup")
def on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        reconcile_single_admin_invariant(db)
        ensure_system_settings_row(db)
        seed_vehicles_dictionary(db)
        db.commit()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def commit_or_400(db: Session, detail: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=detail) from exc


def normalize_login(login: str) -> str:
    return login.strip().lower()


def build_internal_email_from_login(login: str) -> str:
    # Email remains in DB for compatibility, but auth works by login (username).
    digest = hashlib.sha256(login.encode("utf-8")).hexdigest()[:24]
    return f"user-{digest}@example.com"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_request_ip(request: Request) -> str | None:
    candidate = None
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        candidate = forwarded_for.split(",")[0].strip()
    elif request.client and request.client.host:
        candidate = request.client.host

    if candidate is None:
        return None
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return None
    return candidate


def is_session_expired(expires_at: datetime) -> bool:
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= utcnow()


def get_state_session_id_or_404(db: Session, state_id: UUID) -> UUID:
    session_id = (
        db.execute(
            select(SessionStateSnapshot.session_id).where(SessionStateSnapshot.id == state_id)
        )
        .scalars()
        .first()
    )
    if session_id is None:
        raise HTTPException(status_code=404, detail="State snapshot not found")
    return session_id


def ensure_system_settings_row(db: Session) -> SystemSetting:
    row = db.get(SystemSetting, GLOBAL_SYSTEM_SETTINGS_KEY)
    if row is not None:
        return row

    row = SystemSetting(
        key=GLOBAL_SYSTEM_SETTINGS_KEY,
        value=DEFAULT_SYSTEM_SETTINGS.copy(),
    )
    db.add(row)
    db.flush()
    return row


def build_system_settings_read(value: dict) -> SystemSettingsRead:
    data = DEFAULT_SYSTEM_SETTINGS.copy()
    data.update(value)
    return SystemSettingsRead(**data)


# --- Simulation sessions ---
@app.get("/api/sessions", response_model=list[SimulationSessionRead], dependencies=[Depends(require_permission("sessions:read"))])
def list_sessions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    stmt = select(SimulationSession).order_by(SimulationSession.created_at.desc())
    if not has_global_session_scope(current_user):
        if current_user.session_id is None:
            return []
        stmt = stmt.where(SimulationSession.id == current_user.session_id)
    return db.execute(stmt).scalars().all()


@app.post(
    "/api/sessions",
    response_model=SimulationSessionRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("sessions:write"))],
)
def create_session(payload: SimulationSessionCreate, db: Session = Depends(get_db)):
    obj = SimulationSession(**payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@app.get("/api/sessions/{session_id}", response_model=SimulationSessionRead, dependencies=[Depends(require_permission("sessions:read"))])
def get_session(session_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(SimulationSession, session_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Session not found")
    assert_session_scope(current_user, obj.id)
    return obj


@app.patch(
    "/api/sessions/{session_id}",
    response_model=SimulationSessionRead,
    dependencies=[Depends(require_permission("sessions:write"))],
)
def update_session(session_id: UUID, payload: SimulationSessionUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(SimulationSession, session_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Session not found")
    assert_session_scope(current_user, obj.id)

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)

    db.commit()
    db.refresh(obj)
    return obj


@app.delete(
    "/api/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("sessions:write"))],
)
def delete_session(session_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(SimulationSession, session_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Session not found")
    assert_session_scope(current_user, obj.id)
    db.delete(obj)
    db.commit()


@app.get(
    "/api/sessions/{session_id}/state",
    response_model=SessionStateBundleRead,
    dependencies=[Depends(require_permission("state:read"))],
)
def get_session_state_bundle(
    session_id: UUID,
    snapshot_id: UUID | None = Query(default=None),
    include_history: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_obj = db.get(SimulationSession, session_id)
    if not session_obj:
        raise HTTPException(status_code=404, detail="Session not found")
    assert_session_scope(current_user, session_id)

    snapshot_obj: SessionStateSnapshot | None = None
    if snapshot_id is not None:
        snapshot_obj = db.get(SessionStateSnapshot, snapshot_id)
        if not snapshot_obj or snapshot_obj.session_id != session_id:
            raise HTTPException(status_code=404, detail="State snapshot not found for this session")
    else:
        snapshot_obj = (
            db.execute(
                select(SessionStateSnapshot)
                .where(
                    SessionStateSnapshot.session_id == session_id,
                    SessionStateSnapshot.is_current.is_(True),
                )
                .order_by(SessionStateSnapshot.captured_at.desc())
            )
            .scalars()
            .first()
        )
        if snapshot_obj is None:
            snapshot_obj = (
                db.execute(
                    select(SessionStateSnapshot)
                    .where(SessionStateSnapshot.session_id == session_id)
                    .order_by(SessionStateSnapshot.captured_at.desc())
                )
                .scalars()
                .first()
            )

    weather_obj: WeatherSnapshot | None = None
    fire_objects: list[FireObject] = []
    resource_deployments: list[ResourceDeployment] = []

    if snapshot_obj is not None:
        weather_obj = (
            db.execute(
                select(WeatherSnapshot)
                .where(WeatherSnapshot.state_id == snapshot_obj.id)
                .order_by(WeatherSnapshot.created_at.desc())
            )
            .scalars()
            .first()
        )
        fire_objects = (
            db.execute(
                select(FireObject)
                .where(FireObject.state_id == snapshot_obj.id)
                .order_by(FireObject.created_at.asc())
            )
            .scalars()
            .all()
        )
        resource_deployments = (
            db.execute(
                select(ResourceDeployment)
                .where(ResourceDeployment.state_id == snapshot_obj.id)
                .order_by(ResourceDeployment.created_at.asc())
            )
            .scalars()
            .all()
        )

    snapshots_history: list[SessionStateSnapshot] = []
    if include_history:
        snapshots_history = (
            db.execute(
                select(SessionStateSnapshot)
                .where(SessionStateSnapshot.session_id == session_id)
                .order_by(SessionStateSnapshot.captured_at.desc())
            )
            .scalars()
            .all()
        )

    return SessionStateBundleRead(
        session=session_obj,
        snapshot=snapshot_obj,
        weather=weather_obj,
        fire_objects=fire_objects,
        resource_deployments=resource_deployments,
        snapshots_history=snapshots_history,
    )


# --- API Auth & Users ---
@app.post(
    "/api/auth/register",
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(register_rate_limit)],
)
def register_user(payload: UserCreate, db: Session = Depends(get_db)):
    normalized_username = normalize_login(payload.username)
    if not normalized_username:
        raise HTTPException(status_code=400, detail="Login is required")

    existing_user = (
        db.execute(
            select(User).where(func.lower(User.username) == normalized_username)
        )
        .scalars()
        .first()
    )
    if existing_user:
        raise HTTPException(status_code=400, detail="Login already registered")

    requested_role = payload.requested_role.value
    if requested_role == UserRole.ADMIN.value:
        raise HTTPException(
            status_code=400,
            detail="Requested role is not allowed for public registration",
        )

    role_obj = get_or_create_role(db, requested_role)
    hashed_password = get_password_hash(payload.password)
    obj = User(
        username=normalized_username,
        email=build_internal_email_from_login(normalized_username),
        password_hash=hashed_password,
    )
    obj.roles.append(role_obj)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@app.post("/api/auth/login", response_model=Token, dependencies=[Depends(login_rate_limit)])
def login_user(payload: UserLogin, request: Request, db: Session = Depends(get_db)):
    normalized_login = normalize_login(payload.login)
    now = utcnow()
    user = db.execute(select(User).where(func.lower(User.username) == normalized_login)).scalars().first()

    if user and user.lockout_until:
        lockout_until = user.lockout_until
        if lockout_until.tzinfo is None:
            lockout_until = lockout_until.replace(tzinfo=timezone.utc)
        if lockout_until > now:
            retry_after = max(1, int((lockout_until - now).total_seconds()))
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail=LOCKED_LOGIN_DETAIL,
                headers={"Retry-After": str(retry_after)},
            )
        user.lockout_until = None
        user.failed_login_attempts = 0
        db.commit()

    if not user or not verify_password(payload.password, user.password_hash):
        if user:
            user.failed_login_attempts += 1
            if user.failed_login_attempts >= MAX_FAILED_LOGIN_ATTEMPTS:
                user.lockout_until = now + timedelta(minutes=LOCKOUT_DURATION_MINUTES)
            db.commit()
            if user.lockout_until and user.lockout_until > now:
                retry_after = max(1, int((user.lockout_until - now).total_seconds()))
                raise HTTPException(
                    status_code=status.HTTP_423_LOCKED,
                    detail=LOCKED_LOGIN_DETAIL,
                    headers={"Retry-After": str(retry_after)},
                )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=INVALID_LOGIN_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=INVALID_LOGIN_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        )

    user.failed_login_attempts = 0
    user.lockout_until = None

    auth_session = AuthSession(
        user_id=user.id,
        device_id=request.headers.get("x-device-id"),
        ip_address=parse_request_ip(request),
        user_agent=request.headers.get("user-agent"),
        expires_at=now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(auth_session)
    db.flush()

    access_token = create_access_token(data={"sub": str(user.id), "sid": str(auth_session.id)})
    refresh_token = create_refresh_token(data={"sub": str(user.id), "sid": str(auth_session.id)})
    db.commit()
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "session_id": auth_session.id,
    }


@app.post("/api/auth/refresh", response_model=Token, dependencies=[Depends(refresh_rate_limit)])
def refresh_tokens(payload: RefreshTokenRequest, db: Session = Depends(get_db)):
    user_id, session_id = get_refresh_token_ids(payload.refresh_token)
    auth_session = db.get(AuthSession, session_id)
    if auth_session is None or auth_session.user_id != user_id or auth_session.is_revoked:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if is_session_expired(auth_session.expires_at):
        auth_session.is_revoked = True
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    auth_session.expires_at = utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    access_token = create_access_token(data={"sub": str(user.id), "sid": str(auth_session.id)})
    refresh_token = create_refresh_token(data={"sub": str(user.id), "sid": str(auth_session.id)})
    db.commit()
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "session_id": auth_session.id,
    }


@app.post("/api/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout_current_session(
    current_session: AuthSession = Depends(get_current_session),
    db: Session = Depends(get_db),
):
    current_session.is_revoked = True
    db.commit()


@app.post("/api/auth/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def logout_all_sessions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sessions = (
        db.execute(
            select(AuthSession).where(
                AuthSession.user_id == current_user.id,
                AuthSession.is_revoked.is_(False),
            )
        )
        .scalars()
        .all()
    )
    for auth_session in sessions:
        auth_session.is_revoked = True
    db.commit()


@app.get("/api/auth/sessions", response_model=list[AuthSessionRead])
def list_auth_sessions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.execute(
            select(AuthSession)
            .where(AuthSession.user_id == current_user.id)
            .order_by(AuthSession.created_at.desc())
        )
        .scalars()
        .all()
    )


@app.post("/api/auth/revoke", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session(
    payload: SessionRevokeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    target_session = db.get(AuthSession, payload.session_id)
    if target_session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if target_session.user_id != current_user.id and not has_permission(current_user, "users:manage"):
        raise HTTPException(status_code=403, detail="Not enough permissions")

    target_session.is_revoked = True
    db.commit()

@app.get("/api/auth/me", response_model=UserRead)
def read_users_me(current_user: User = Depends(get_current_user)):
    return current_user


@app.patch("/api/auth/session", response_model=UserRead, dependencies=[Depends(require_permission("sessions:write"))])
def update_current_user_session(
    payload: CurrentUserSessionUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if payload.session_id is not None:
        target_session = db.get(SimulationSession, payload.session_id)
        if target_session is None:
            raise HTTPException(status_code=404, detail="Session not found")
    current_user.session_id = payload.session_id
    db.commit()
    db.refresh(current_user)
    return current_user


@app.get("/api/users", response_model=list[UserRead], dependencies=[Depends(require_permission("users:manage"))])
def list_users(db: Session = Depends(get_db)):
    return db.execute(select(User).order_by(User.created_at.desc())).scalars().all()


@app.get("/api/roles", response_model=list[str], dependencies=[Depends(require_permission("users:manage"))])
def list_roles():
    return [role.value for role in UserRole]


@app.patch("/api/users/{user_id}/roles", response_model=UserRead, dependencies=[Depends(require_permission("users:manage"))])
def update_user_roles(user_id: UUID, payload: UserRolesUpdate, db: Session = Depends(get_db)):
    obj = db.get(User, user_id)
    if not obj:
        raise HTTPException(status_code=404, detail="User not found")

    requested_roles = {role.value for role in payload.roles}
    if UserRole.ADMIN.value in requested_roles:
        raise HTTPException(
            status_code=400,
            detail="Admin role cannot be assigned here. Use /api/admin/transfer",
        )
    if is_locked_admin_user(db, user_id):
        raise HTTPException(
            status_code=409,
            detail="Current admin role cannot be changed without transfer",
        )

    role_objects: list[Role] = []
    for role_name in sorted(requested_roles):
        role_obj = get_or_create_role(db, role_name)
        role_objects.append(role_obj)

    obj.roles.clear()
    obj.roles.extend(role_objects)
    db.commit()
    db.refresh(obj)
    return obj


@app.get("/api/system-settings", response_model=SystemSettingsRead, dependencies=[Depends(require_permission("admin:manage"))])
def get_system_settings(db: Session = Depends(get_db)):
    row = ensure_system_settings_row(db)
    return build_system_settings_read(row.value)


@app.patch("/api/system-settings", response_model=SystemSettingsRead, dependencies=[Depends(require_permission("admin:manage"))])
def update_system_settings(payload: SystemSettingsUpdate, db: Session = Depends(get_db)):
    row = ensure_system_settings_row(db)
    current = DEFAULT_SYSTEM_SETTINGS.copy()
    current.update(row.value)
    updates = payload.model_dump(exclude_unset=True)
    current.update(updates)

    # Validate final settings before persist.
    validated = SystemSettingsRead(**current)
    row.value = validated.model_dump()
    db.commit()
    return validated


@app.get("/api/admin/lock", response_model=AdminLockRead, dependencies=[Depends(require_permission("admin:manage"))])
def read_admin_lock(db: Session = Depends(get_db)):
    return ensure_admin_lock(db, for_update=False)


@app.post("/api/admin/transfer", response_model=UserRead, dependencies=[Depends(require_permission("admin:manage"))])
def transfer_admin(
    payload: AdminTransferRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    try:
        new_admin = transfer_admin_role(
            db=db,
            current_admin_user_id=current_user.id,
            new_admin_user_id=payload.new_admin_user_id,
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    db.refresh(new_admin)
    return new_admin


@app.patch("/api/users/{user_id}", response_model=UserRead)
def update_user(user_id: UUID, payload: UserUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    is_admin = has_permission(current_user, "users:manage")
    if str(current_user.id) != str(user_id) and not is_admin:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    obj = db.get(User, user_id)
    if not obj:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.is_active is False and is_locked_admin_user(db, user_id):
        raise HTTPException(status_code=409, detail="Current admin cannot be deactivated without role transfer")

    if not is_admin:
        forbidden_fields = {"is_active", "session_id"}
        updated_fields = set(payload.model_dump(exclude_unset=True))
        if updated_fields.intersection(forbidden_fields):
            raise HTTPException(status_code=403, detail="Not enough permissions")

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail="Invalid payload") from exc

    db.refresh(obj)
    return obj


@app.delete("/api/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_permission("users:manage"))])
def delete_user(user_id: UUID, db: Session = Depends(get_db)):
    if is_locked_admin_user(db, user_id):
        raise HTTPException(status_code=409, detail="Current admin cannot be deleted without role transfer")

    obj = db.get(User, user_id)
    if not obj:
        raise HTTPException(status_code=404, detail="User not found")
    db.delete(obj)
    db.commit()


# --- Vehicles dictionary ---
@app.get("/api/vehicles", response_model=list[VehicleDictionaryRead], dependencies=[Depends(require_permission("vehicles:read"))])
def list_vehicles(db: Session = Depends(get_db)):
    return db.execute(select(VehicleDictionary).order_by(VehicleDictionary.id.asc())).scalars().all()


@app.post(
    "/api/vehicles",
    response_model=VehicleDictionaryRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("vehicles:write"))],
)
def create_vehicle(payload: VehicleDictionaryCreate, db: Session = Depends(get_db)):
    obj = VehicleDictionary(**payload.model_dump())
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@app.get("/api/vehicles/{vehicle_id}", response_model=VehicleDictionaryRead, dependencies=[Depends(require_permission("vehicles:read"))])
def get_vehicle(vehicle_id: int, db: Session = Depends(get_db)):
    obj = db.get(VehicleDictionary, vehicle_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    return obj


@app.patch(
    "/api/vehicles/{vehicle_id}",
    response_model=VehicleDictionaryRead,
    dependencies=[Depends(require_permission("vehicles:write"))],
)
def update_vehicle(vehicle_id: int, payload: VehicleDictionaryUpdate, db: Session = Depends(get_db)):
    obj = db.get(VehicleDictionary, vehicle_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Vehicle not found")

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)

    db.commit()
    db.refresh(obj)
    return obj


@app.delete(
    "/api/vehicles/{vehicle_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("vehicles:write"))],
)
def delete_vehicle(vehicle_id: int, db: Session = Depends(get_db)):
    obj = db.get(VehicleDictionary, vehicle_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Vehicle not found")
    db.delete(obj)
    db.commit()


# --- Session state snapshots ---
@app.get(
    "/api/state-snapshots",
    response_model=list[SessionStateSnapshotRead],
    dependencies=[Depends(require_permission("state:read"))],
)
def list_state_snapshots(
    session_id: UUID | None = Query(default=None),
    is_current: bool | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(SessionStateSnapshot)
    if session_id is not None:
        assert_session_scope(current_user, session_id)
        stmt = stmt.where(SessionStateSnapshot.session_id == session_id)
    elif not has_global_session_scope(current_user):
        if current_user.session_id is None:
            return []
        stmt = stmt.where(SessionStateSnapshot.session_id == current_user.session_id)
    if is_current is not None:
        stmt = stmt.where(SessionStateSnapshot.is_current == is_current)
    stmt = stmt.order_by(SessionStateSnapshot.captured_at.desc())
    return db.execute(stmt).scalars().all()


@app.post(
    "/api/state-snapshots",
    response_model=SessionStateSnapshotRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("state:write"))],
)
def create_state_snapshot(
    payload: SessionStateSnapshotCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_session_scope(current_user, payload.session_id)
    obj = SessionStateSnapshot(**payload.model_dump())
    db.add(obj)
    commit_or_400(db, "Invalid state snapshot payload")
    db.refresh(obj)
    return obj


@app.get(
    "/api/state-snapshots/{snapshot_id}",
    response_model=SessionStateSnapshotRead,
    dependencies=[Depends(require_permission("state:read"))],
)
def get_state_snapshot(snapshot_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(SessionStateSnapshot, snapshot_id)
    if not obj:
        raise HTTPException(status_code=404, detail="State snapshot not found")
    assert_session_scope(current_user, obj.session_id)
    return obj


@app.patch(
    "/api/state-snapshots/{snapshot_id}",
    response_model=SessionStateSnapshotRead,
    dependencies=[Depends(require_permission("state:write"))],
)
def update_state_snapshot(
    snapshot_id: UUID,
    payload: SessionStateSnapshotUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    obj = db.get(SessionStateSnapshot, snapshot_id)
    if not obj:
        raise HTTPException(status_code=404, detail="State snapshot not found")
    assert_session_scope(current_user, obj.session_id)

    if payload.session_id is not None:
        assert_session_scope(current_user, payload.session_id)

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)

    commit_or_400(db, "Invalid state snapshot payload")
    db.refresh(obj)
    return obj


@app.delete(
    "/api/state-snapshots/{snapshot_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("state:write"))],
)
def delete_state_snapshot(snapshot_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(SessionStateSnapshot, snapshot_id)
    if not obj:
        raise HTTPException(status_code=404, detail="State snapshot not found")
    assert_session_scope(current_user, obj.session_id)
    db.delete(obj)
    db.commit()


# --- Weather snapshots ---
@app.get(
    "/api/weather-snapshots",
    response_model=list[WeatherSnapshotRead],
    dependencies=[Depends(require_permission("state:read"))],
)
def list_weather_snapshots(
    state_id: UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(WeatherSnapshot)
    if state_id is not None:
        session_id = get_state_session_id_or_404(db, state_id)
        assert_session_scope(current_user, session_id)
        stmt = stmt.where(WeatherSnapshot.state_id == state_id)
    elif not has_global_session_scope(current_user):
        if current_user.session_id is None:
            return []
        stmt = stmt.join(
            SessionStateSnapshot,
            SessionStateSnapshot.id == WeatherSnapshot.state_id,
        ).where(SessionStateSnapshot.session_id == current_user.session_id)
    stmt = stmt.order_by(WeatherSnapshot.created_at.desc())
    return db.execute(stmt).scalars().all()


@app.post(
    "/api/weather-snapshots",
    response_model=WeatherSnapshotRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("state:write"))],
)
def create_weather_snapshot(
    payload: WeatherSnapshotCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_id = get_state_session_id_or_404(db, payload.state_id)
    assert_session_scope(current_user, session_id)
    obj = WeatherSnapshot(**payload.model_dump())
    db.add(obj)
    commit_or_400(db, "Invalid weather snapshot payload")
    db.refresh(obj)
    return obj


@app.get(
    "/api/weather-snapshots/{weather_id}",
    response_model=WeatherSnapshotRead,
    dependencies=[Depends(require_permission("state:read"))],
)
def get_weather_snapshot(weather_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(WeatherSnapshot, weather_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Weather snapshot not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)
    return obj


@app.patch(
    "/api/weather-snapshots/{weather_id}",
    response_model=WeatherSnapshotRead,
    dependencies=[Depends(require_permission("state:write"))],
)
def update_weather_snapshot(
    weather_id: UUID,
    payload: WeatherSnapshotUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    obj = db.get(WeatherSnapshot, weather_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Weather snapshot not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)

    if payload.state_id is not None:
        new_session_id = get_state_session_id_or_404(db, payload.state_id)
        assert_session_scope(current_user, new_session_id)

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)

    commit_or_400(db, "Invalid weather snapshot payload")
    db.refresh(obj)
    return obj


@app.delete(
    "/api/weather-snapshots/{weather_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("state:write"))],
)
def delete_weather_snapshot(weather_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(WeatherSnapshot, weather_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Weather snapshot not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)
    db.delete(obj)
    db.commit()


# --- Fire objects ---
@app.get(
    "/api/fire-objects",
    response_model=list[FireObjectRead],
    dependencies=[Depends(require_permission("state:read"))],
)
def list_fire_objects(
    state_id: UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(FireObject)
    if state_id is not None:
        session_id = get_state_session_id_or_404(db, state_id)
        assert_session_scope(current_user, session_id)
        stmt = stmt.where(FireObject.state_id == state_id)
    elif not has_global_session_scope(current_user):
        if current_user.session_id is None:
            return []
        stmt = stmt.join(
            SessionStateSnapshot,
            SessionStateSnapshot.id == FireObject.state_id,
        ).where(SessionStateSnapshot.session_id == current_user.session_id)
    stmt = stmt.order_by(FireObject.created_at.desc())
    return db.execute(stmt).scalars().all()


@app.post(
    "/api/fire-objects",
    response_model=FireObjectRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("state:write"))],
)
def create_fire_object(
    payload: FireObjectCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_id = get_state_session_id_or_404(db, payload.state_id)
    assert_session_scope(current_user, session_id)
    obj = FireObject(**payload.model_dump())
    db.add(obj)
    commit_or_400(db, "Invalid fire object payload")
    db.refresh(obj)
    return obj


@app.get(
    "/api/fire-objects/{fire_id}",
    response_model=FireObjectRead,
    dependencies=[Depends(require_permission("state:read"))],
)
def get_fire_object(fire_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(FireObject, fire_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Fire object not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)
    return obj


@app.patch(
    "/api/fire-objects/{fire_id}",
    response_model=FireObjectRead,
    dependencies=[Depends(require_permission("state:write"))],
)
def update_fire_object(
    fire_id: UUID,
    payload: FireObjectUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    obj = db.get(FireObject, fire_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Fire object not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)

    if payload.state_id is not None:
        new_session_id = get_state_session_id_or_404(db, payload.state_id)
        assert_session_scope(current_user, new_session_id)

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)

    commit_or_400(db, "Invalid fire object payload")
    db.refresh(obj)
    return obj


@app.delete(
    "/api/fire-objects/{fire_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("state:write"))],
)
def delete_fire_object(fire_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(FireObject, fire_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Fire object not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)
    db.delete(obj)
    db.commit()


# --- Resource deployments ---
@app.get(
    "/api/resource-deployments",
    response_model=list[ResourceDeploymentRead],
    dependencies=[Depends(require_permission("state:read"))],
)
def list_resource_deployments(
    state_id: UUID | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(ResourceDeployment)
    if state_id is not None:
        session_id = get_state_session_id_or_404(db, state_id)
        assert_session_scope(current_user, session_id)
        stmt = stmt.where(ResourceDeployment.state_id == state_id)
    elif not has_global_session_scope(current_user):
        if current_user.session_id is None:
            return []
        stmt = stmt.join(
            SessionStateSnapshot,
            SessionStateSnapshot.id == ResourceDeployment.state_id,
        ).where(SessionStateSnapshot.session_id == current_user.session_id)
    stmt = stmt.order_by(ResourceDeployment.created_at.desc())
    return db.execute(stmt).scalars().all()


@app.post(
    "/api/resource-deployments",
    response_model=ResourceDeploymentRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission("state:write"))],
)
def create_resource_deployment(
    payload: ResourceDeploymentCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_id = get_state_session_id_or_404(db, payload.state_id)
    assert_session_scope(current_user, session_id)
    obj = ResourceDeployment(**payload.model_dump())
    db.add(obj)
    commit_or_400(db, "Invalid resource deployment payload")
    db.refresh(obj)
    return obj


@app.get(
    "/api/resource-deployments/{deployment_id}",
    response_model=ResourceDeploymentRead,
    dependencies=[Depends(require_permission("state:read"))],
)
def get_resource_deployment(deployment_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(ResourceDeployment, deployment_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Resource deployment not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)
    return obj


@app.patch(
    "/api/resource-deployments/{deployment_id}",
    response_model=ResourceDeploymentRead,
    dependencies=[Depends(require_permission("state:write"))],
)
def update_resource_deployment(
    deployment_id: UUID,
    payload: ResourceDeploymentUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    obj = db.get(ResourceDeployment, deployment_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Resource deployment not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)

    if payload.state_id is not None:
        new_session_id = get_state_session_id_or_404(db, payload.state_id)
        assert_session_scope(current_user, new_session_id)

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)

    commit_or_400(db, "Invalid resource deployment payload")
    db.refresh(obj)
    return obj


@app.delete(
    "/api/resource-deployments/{deployment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("state:write"))],
)
def delete_resource_deployment(deployment_id: UUID, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    obj = db.get(ResourceDeployment, deployment_id)
    if not obj:
        raise HTTPException(status_code=404, detail="Resource deployment not found")
    session_id = get_state_session_id_or_404(db, obj.state_id)
    assert_session_scope(current_user, session_id)
    db.delete(obj)
    db.commit()
