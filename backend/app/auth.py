import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from dotenv import load_dotenv

from .database import get_db
from .enums import ROLE_ALIASES_TO_CANONICAL, UserRole
from .models import Session as AuthSession
from .models import User

load_dotenv()


def _get_required_secret_key() -> str:
    secret_key = os.getenv("SECRET_KEY")
    if not secret_key:
        raise RuntimeError("SECRET_KEY must be set in environment")
    return secret_key


SECRET_KEY = _get_required_secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")
security = HTTPBearer()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _credentials_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = utcnow() + expires_delta
    else:
        expire = utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "typ": "access"})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def create_refresh_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = utcnow() + expires_delta
    else:
        expire = utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "typ": "refresh"})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def _is_session_expired(expires_at: datetime) -> bool:
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= utcnow()


def decode_jwt_payload(token: str, expected_token_type: str | None = None) -> dict:
    credentials_exception = _credentials_exception()
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        session_id = payload.get("sid")
        if user_id is None or session_id is None:
            raise credentials_exception
        if expected_token_type is not None and payload.get("typ") != expected_token_type:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    return payload


def _payload_ids(payload: dict) -> tuple[UUID, UUID]:
    credentials_exception = _credentials_exception()
    try:
        user_id = UUID(str(payload["sub"]))
        session_id = UUID(str(payload["sid"]))
    except (KeyError, ValueError, TypeError):
        raise credentials_exception
    return user_id, session_id


def get_auth_context_from_access_token(db: Session, access_token: str) -> tuple[User, AuthSession]:
    credentials_exception = _credentials_exception()
    payload = decode_jwt_payload(access_token, expected_token_type="access")
    user_id, session_id = _payload_ids(payload)

    user = db.get(User, user_id)
    if user is None:
        raise credentials_exception

    auth_session = db.get(AuthSession, session_id)
    if auth_session is None or auth_session.user_id != user.id or auth_session.is_revoked:
        raise credentials_exception
    if _is_session_expired(auth_session.expires_at):
        raise credentials_exception

    if not user.is_active:
        raise credentials_exception
    return user, auth_session


def get_current_auth_context(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> tuple[User, AuthSession]:
    return get_auth_context_from_access_token(db, credentials.credentials)


def get_current_user(auth_context: tuple[User, AuthSession] = Depends(get_current_auth_context)) -> User:
    user, _ = auth_context
    return user


def get_current_session(auth_context: tuple[User, AuthSession] = Depends(get_current_auth_context)) -> AuthSession:
    _, auth_session = auth_context
    return auth_session


def get_refresh_token_ids(refresh_token: str) -> tuple[UUID, UUID]:
    payload = decode_jwt_payload(refresh_token, expected_token_type="refresh")
    return _payload_ids(payload)


def get_access_token_ids(access_token: str) -> tuple[UUID, UUID]:
    payload = decode_jwt_payload(access_token, expected_token_type="access")
    return _payload_ids(payload)


def normalize_role_name(role_name: str) -> str:
    normalized = role_name.strip().upper()
    canonical_role = ROLE_ALIASES_TO_CANONICAL.get(normalized)
    if canonical_role is not None:
        return canonical_role.value
    return normalized


def require_roles(allowed_roles: list[str]):
    def role_checker(user: User = Depends(get_current_user)):
        allowed_canonical = {normalize_role_name(role) for role in allowed_roles}
        user_roles = {normalize_role_name(role.name) for role in user.roles}

        if UserRole.ADMIN.value in user_roles:
            return user

        if user_roles.intersection(allowed_canonical):
            return user

        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")

    return role_checker
