"""Create demo accounts. Safe to run repeatedly.

    python -m app.seed [--riders 50]
"""
import argparse

from app.db import SessionLocal
from app.models import RiderProfile, Role, User
from app.security import hash_password

DEMO_PASSWORD = "dispatchx123"


def upsert(db, email, name, role, phone=None):
    u = db.query(User).filter(User.email == email).first()
    if u:
        return u, False
    u = User(email=email, name=name, role=role, phone=phone, password_hash=hash_password(DEMO_PASSWORD))
    db.add(u)
    db.flush()
    return u, True


def main(n_riders: int, n_customers: int):
    pw = hash_password(DEMO_PASSWORD)
    with SessionLocal() as db:
        upsert(db, "admin@dispatchx.dev", "Admin", Role.admin)
        upsert(db, "dispatch@dispatchx.dev", "Dispatch Desk", Role.dispatcher)
        upsert(db, "customer@dispatchx.dev", "Demo Customer", Role.customer, "+910000000000")
        upsert(db, "rider@dispatchx.dev", "Demo Rider", Role.rider)
        existing = {e for (e,) in db.query(User.email).filter(User.email.like("%@sim.dispatchx.dev"))}
        for i in range(1, n_riders + 1):
            email = f"rider{i}@sim.dispatchx.dev"
            if email not in existing:
                db.add(User(email=email, name=f"Sim Rider {i}", role=Role.rider, password_hash=pw))
        for i in range(1, n_customers + 1):
            email = f"customer{i}@sim.dispatchx.dev"
            if email not in existing:
                db.add(User(email=email, name=f"Sim Customer {i}", role=Role.customer, password_hash=pw))
        db.flush()
        riders = db.query(User).filter(User.role == Role.rider).all()
        have = {p.user_id for p in db.query(RiderProfile)}
        for i, u in enumerate(riders):
            if u.id not in have:
                db.add(RiderProfile(user_id=u.id, vehicle="bike" if i % 4 else "scooter",
                                    rating=round(4.2 + (i * 37 % 8) / 10, 1)))
        db.commit()
    print(f"Seeded demo users (password: {DEMO_PASSWORD}), {n_riders} sim riders, {n_customers} sim customers")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--riders", type=int, default=50)
    ap.add_argument("--customers", type=int, default=20)
    a = ap.parse_args()
    main(a.riders, a.customers)
