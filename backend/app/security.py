from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings

ALGO = "HS256"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _token(user_id: int, role: str, kind: str, ttl: timedelta) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "role": role, "type": kind, "iat": now, "exp": now + ttl}
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGO)


def create_access_token(user_id: int, role: str) -> str:
    return _token(user_id, role, "access", timedelta(minutes=settings.jwt_access_minutes))


def create_refresh_token(user_id: int, role: str) -> str:
    return _token(user_id, role, "refresh", timedelta(days=settings.jwt_refresh_days))


def decode_token(token: str, expected_type: str = "access") -> dict:
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[ALGO])
    if payload.get("type") != expected_type:
        raise jwt.InvalidTokenError("wrong token type")
    return payload
