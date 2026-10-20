"""Atomic booking persistence and optional durable retry identities.

Only validated request fields enter the fingerprint, including default values.
Object key order and equivalent numeric inputs do not matter; string values do.
Keys are case-sensitive, are not trimmed, and have no expiry. Only SHA-256
digests are stored, so database collation cannot change key case sensitivity.

The order, initial audit event and identity commit together. Publishing happens
afterward in the router: a process crash or publish failure after commit can
leave a booking without its creation event. Replays intentionally do not publish
again. A transactional outbox would close that gap and is outside this change.
"""
import hashlib
import json
import re

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import BookingIdentity, Order
from app.schemas import OrderIn
from app.services.geo import quote
from app.services.orders import log_event

KEY_PATTERN = re.compile(r"[A-Za-z0-9._:-]{8,128}")
INVALID_KEY_DETAIL = "Idempotency-Key must be 8-128 characters using only A-Z, a-z, 0-9, '.', '_', ':', '-'"


def _key_hash(key: str | None) -> str | None:
    if key is None:
        return None
    if not KEY_PATTERN.fullmatch(key):
        # Do not echo a rejected header into errors, logs or metric labels.
        raise HTTPException(422, INVALID_KEY_DETAIL)
    return hashlib.sha256(key.encode("ascii")).hexdigest()


def _fingerprint(body: OrderIn) -> str:
    payload = body.model_dump(mode="json")
    for point in (payload["pickup"], payload["drop"]):
        for coordinate in ("lat", "lng"):
            # Pydantic coerces coordinates to floats; also equate -0.0 and 0.0.
            if point[coordinate] == 0:
                point[coordinate] = 0.0
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _replay(db: Session, customer_id: int, key_hash: str, fingerprint: str) -> Order | None:
    identity = db.query(BookingIdentity).filter_by(customer_id=customer_id, key_hash=key_hash).one_or_none()
    if identity is None:
        return None
    if identity.request_fingerprint != fingerprint:
        raise HTTPException(409, "Idempotency-Key was already used with a different booking payload")
    order = db.get(Order, identity.order_id)
    if order is None:
        raise RuntimeError("Booking identity references a missing order")
    return order


def book_order(db: Session, customer_id: int, body: OrderIn, key: str | None = None) -> tuple[Order, bool]:
    """Return (order, created); only the creator may publish creation side effects.

    The request's session may already have a transaction from authentication.
    Commit it once after all booking writes, or roll it back in full on failure.
    """
    key_hash = _key_hash(key)
    fingerprint = _fingerprint(body)
    try:
        if key_hash is not None:
            existing = _replay(db, customer_id, key_hash, fingerprint)
            if existing is not None:
                return existing, False

        q = quote(body.pickup.lat, body.pickup.lng, body.drop.lat, body.drop.lng)
        if q["distance_km"] > 60:
            raise HTTPException(422, "Deliveries are limited to 60 km")
        order = Order(
            customer_id=customer_id,
            pickup_address=body.pickup.address, pickup_lat=body.pickup.lat, pickup_lng=body.pickup.lng,
            drop_address=body.drop.address, drop_lat=body.drop.lat, drop_lng=body.drop.lng,
            package_note=body.package_note, **q,
        )
        db.add(order)
        db.flush()
        if key_hash is not None:
            db.add(BookingIdentity(
                order_id=order.id, customer_id=customer_id,
                key_hash=key_hash, request_fingerprint=fingerprint,
            ))
            try:
                # The database unique constraint, not a Redis lock, chooses the winner.
                db.flush()
            except IntegrityError:
                # Roll back the WHOLE transaction, including the losing order. A
                # savepoint rollback retains MySQL REPEATABLE READ's old snapshot.
                # Use scalar customer_id here: do not reload an expired User first.
                db.rollback()
                existing = _replay(db, customer_id, key_hash, fingerprint)
                if existing is None:
                    raise  # Not a booking-key conflict; preserve the database error.
                return existing, False

        log_event(db, order.id, "status.pending", {"actor": f"customer:{customer_id}", **q})
        db.commit()
    except Exception:
        db.rollback()
        raise
    return order, True
