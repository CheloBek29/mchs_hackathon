from __future__ import annotations

import argparse
import sys

from fastapi import HTTPException

from .database import Base, SessionLocal, engine
from .services.admin_lock_service import bootstrap_first_admin


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bootstrap first ADMIN user for TP-SIMULATOR"
    )
    parser.add_argument("--username", required=True, help="Admin username")
    parser.add_argument("--email", required=True, help="Admin email")
    parser.add_argument("--password", required=True, help="Admin password")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    Base.metadata.create_all(bind=engine)
    created_admin_id: str | None = None
    created_admin_email: str | None = None
    created_admin_username: str | None = None

    with SessionLocal() as db:
        try:
            user = bootstrap_first_admin(
                db=db,
                username=args.username,
                email=args.email,
                password=args.password,
            )
            db.commit()
            # Сохраняем значения до закрытия сессии во избежание DetachedInstanceError
            created_admin_id = str(user.id)
            created_admin_email = str(user.email)
            created_admin_username = str(user.username)
        except HTTPException as exc:
            db.rollback()
            print(f"Bootstrap failed [{exc.status_code}]: {exc.detail}", file=sys.stderr)
            return 1
        except Exception as exc:
            db.rollback()
            print(f"Bootstrap failed: {exc}", file=sys.stderr)
            return 1

    print(
        "Admin created: "
        f"id={created_admin_id} "
        f"email={created_admin_email} "
        f"username={created_admin_username}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
