from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("SECRET_KEY", "test-secret-key")

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
if TEST_DATABASE_URL:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL


@pytest.fixture(scope="session")
def postgres_enabled() -> bool:
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is not set; PostgreSQL integration tests are skipped")

    from app.database import engine

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - infrastructure dependent.
        pytest.skip(f"PostgreSQL is not reachable for tests: {exc}")

    return True


@pytest.fixture(autouse=True)
def reset_rate_limits() -> None:
    from app.security.rate_limit import _RATE_LIMIT_STORAGE

    _RATE_LIMIT_STORAGE.clear()


@pytest.fixture(autouse=True)
def reset_postgres_db(request: pytest.FixtureRequest) -> None:
    if "postgres" not in request.keywords:
        return

    request.getfixturevalue("postgres_enabled")

    from app.database import Base, SessionLocal, engine
    from app.main import ensure_system_settings_row
    from app.services.admin_lock_service import reconcile_single_admin_invariant
    from app.vehicle_seed import seed_vehicles_dictionary

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    with SessionLocal() as db:
        reconcile_single_admin_invariant(db)
        ensure_system_settings_row(db)
        seed_vehicles_dictionary(db)
        db.commit()


@pytest.fixture
def client(request: pytest.FixtureRequest, postgres_enabled: bool) -> TestClient:
    if "postgres" not in request.keywords:
        pytest.skip("Client fixture is intended for PostgreSQL integration tests")

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def login_and_get_tokens() -> Callable[[TestClient, str, str], dict[str, Any]]:
    def _login(client: TestClient, login: str, password: str) -> dict[str, Any]:
        response = client.post(
            "/api/auth/login",
            json={"login": login, "password": password},
            headers={"x-device-id": "pytest-device"},
        )
        assert response.status_code == 200, response.text
        return response.json()

    return _login


@pytest.fixture
def bootstrap_admin_user(postgres_enabled: bool) -> dict[str, str]:
    from app.database import SessionLocal
    from app.services.admin_lock_service import bootstrap_first_admin

    credentials = {
        "username": "admin",
        "login": "admin",
        "email": "admin@example.com",
        "password": "StrongPassw0rd!",
    }
    with SessionLocal() as db:
        user = bootstrap_first_admin(
            db=db,
            username=credentials["username"],
            email=credentials["email"],
            password=credentials["password"],
        )
        db.commit()
        user_id = str(user.id)

    return {
        **credentials,
        "id": user_id,
    }
