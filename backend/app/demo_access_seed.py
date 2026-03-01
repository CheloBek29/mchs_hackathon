from __future__ import annotations

from dataclasses import dataclass
import os

from sqlalchemy import select

from .auth import get_password_hash
from .database import Base, SessionLocal, engine
from .enums import SessionStatus, UserRole
from .models import Role, SimulationSession, User
from .services.admin_lock_service import get_or_create_role

DEMO_SESSION_NAME = "DEMO 4PC"


@dataclass(frozen=True)
class DemoUserSpec:
    username: str
    password: str
    role: UserRole
    title_ru: str


def _get_demo_password(role_key: str) -> str:
    env_key = f"DEMO_{role_key.upper()}_PASSWORD"
    pwd = os.getenv(env_key)
    if not pwd:
        raise RuntimeError(f"Missing required environment variable for demo seed: {env_key}")
    return pwd


DEMO_USER_SPECS: tuple[DemoUserSpec, ...] = (
    DemoUserSpec(
        username="demo_training_lead",
        password=_get_demo_password("training_lead"),
        role=UserRole.TRAINING_LEAD,
        title_ru="Руководитель занятий",
    ),
    DemoUserSpec(
        username="demo_dispatcher",
        password=_get_demo_password("dispatcher"),
        role=UserRole.DISPATCHER,
        title_ru="Диспетчер",
    ),
    DemoUserSpec(
        username="demo_rtp",
        password=_get_demo_password("rtp"),
        role=UserRole.RTP,
        title_ru="РТП",
    ),
    DemoUserSpec(
        username="demo_hq",
        password=_get_demo_password("hq"),
        role=UserRole.HQ,
        title_ru="Штаб",
    ),
    DemoUserSpec(
        username="demo_bu1",
        password=_get_demo_password("bu1"),
        role=UserRole.COMBAT_AREA_1,
        title_ru="БУ-1",
    ),
    DemoUserSpec(
        username="demo_bu2",
        password=_get_demo_password("bu2"),
        role=UserRole.COMBAT_AREA_2,
        title_ru="БУ-2",
    ),
)


def _build_demo_email(login: str) -> str:
    return f"{login}@demo.local"


def _ensure_demo_session(db) -> SimulationSession:
    session_obj = (
        db.execute(
            select(SimulationSession)
            .where(SimulationSession.scenario_name == DEMO_SESSION_NAME)
            .order_by(SimulationSession.created_at.asc())
        )
        .scalars()
        .first()
    )
    if session_obj is not None:
        return session_obj

    session_obj = SimulationSession(
        status=SessionStatus.CREATED,
        scenario_name=DEMO_SESSION_NAME,
        weather={"wind_speed": 5, "wind_dir": 90, "temp": 20},
        time_multiplier=1.0,
    )
    db.add(session_obj)
    db.flush()
    return session_obj


def seed_demo_users() -> dict[str, str]:
    Base.metadata.create_all(bind=engine)

    with SessionLocal() as db:
        demo_session = _ensure_demo_session(db)

        for spec in DEMO_USER_SPECS:
            role_obj: Role = get_or_create_role(db, spec.role.value)
            user_obj = (
                db.execute(select(User).where(User.username == spec.username))
                .scalars()
                .first()
            )

            password_hash = get_password_hash(spec.password)

            if user_obj is None:
                user_obj = User(
                    username=spec.username,
                    email=_build_demo_email(spec.username),
                    password_hash=password_hash,
                    is_active=True,
                    failed_login_attempts=0,
                    lockout_until=None,
                    session_id=demo_session.id,
                )
                user_obj.roles.append(role_obj)
                db.add(user_obj)
            else:
                user_obj.password_hash = password_hash
                user_obj.is_active = True
                user_obj.failed_login_attempts = 0
                user_obj.lockout_until = None
                user_obj.session_id = demo_session.id
                user_obj.roles.clear()
                user_obj.roles.append(role_obj)

        db.commit()

        return {
            "session_id": str(demo_session.id),
            "session_name": demo_session.scenario_name,
        }


def main() -> None:
    seed_info = seed_demo_users()
    print(f"Demo session: {seed_info['session_name']} ({seed_info['session_id']})")
    print("Credentials:")
    for spec in DEMO_USER_SPECS:
        print(
            f"- {spec.title_ru}: login={spec.username} password={spec.password} role={spec.role.value}"
        )


if __name__ == "__main__":
    main()
