from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_rider
from app.models import Order, OrderStatus, RiderProfile, User
from app.redis_client import ONLINE, r, rider_offer
from app.schemas import DeliverIn, OnlineIn
from app.services import dispatch
from app.services.dispatch import OfferError
from app.services.orders import InvalidTransition, serialize, transition

router = APIRouter(prefix="/riders", tags=["riders"])


def _active_order(db: Session, rider_id: int) -> Order | None:
    return db.query(Order).filter(
        Order.rider_id == rider_id,
        Order.status.in_([OrderStatus.assigned, OrderStatus.picked_up]),
    ).first()


@router.get("/me")
def me(user: User = Depends(require_rider), db: Session = Depends(get_db)):
    profile = db.get(RiderProfile, user.id)
    active = _active_order(db, user.id)
    offer = None
    offered_id = r.get(rider_offer(user.id))
    if offered_id:
        o = db.get(Order, int(offered_id))
        if o and o.status == OrderStatus.pending:
            offer = {"order": serialize(o), "expires_in": max(0, r.ttl(rider_offer(user.id)) - dispatch.OFFER_GRACE_S)}
    return {
        "id": user.id, "name": user.name,
        "vehicle": profile.vehicle if profile else None,
        "rating": profile.rating if profile else None,
        "deliveries": profile.deliveries if profile else 0,
        "earnings": profile.earnings if profile else 0,
        "online": r.sismember(ONLINE, user.id),
        "active_order": serialize(active) if active else None,
        "offer": offer,
    }


@router.post("/me/online")
def online(body: OnlineIn, user: User = Depends(require_rider), db: Session = Depends(get_db)):
    return dispatch.go_online(db, user.id, user.name, body.lat, body.lng)


@router.post("/me/offline")
def offline(user: User = Depends(require_rider), db: Session = Depends(get_db)):
    if _active_order(db, user.id):
        raise HTTPException(409, "Finish your active delivery before going offline")
    dispatch.go_offline(user.id)
    return {"online": False}


@router.post("/offers/{order_id}/accept")
def accept(order_id: int, user: User = Depends(require_rider), db: Session = Depends(get_db)):
    try:
        order = dispatch.accept_offer(db, order_id, user.id)
    except OfferError as e:
        raise HTTPException(409, str(e))
    return serialize(order)


@router.post("/offers/{order_id}/reject")
def reject(order_id: int, user: User = Depends(require_rider)):
    try:
        dispatch.reject_offer(order_id, user.id)
    except OfferError as e:
        raise HTTPException(409, str(e))
    return {"ok": True}


def _my_order(db: Session, order_id: int, rider_id: int) -> Order:
    order = db.get(Order, order_id)
    if not order or order.rider_id != rider_id:
        raise HTTPException(404, "Order not found")
    return order


@router.post("/orders/{order_id}/pickup")
def pickup(order_id: int, user: User = Depends(require_rider), db: Session = Depends(get_db)):
    order = _my_order(db, order_id, user.id)
    try:
        transition(db, order, OrderStatus.picked_up, f"rider:{user.id}")
    except InvalidTransition as e:
        raise HTTPException(409, str(e))
    return serialize(order)


@router.post("/orders/{order_id}/deliver")
def deliver(order_id: int, body: DeliverIn, user: User = Depends(require_rider), db: Session = Depends(get_db)):
    order = _my_order(db, order_id, user.id)
    if body.pod_key:
        if not body.pod_key.startswith(f"pod/{order_id}/"):
            raise HTTPException(422, "Invalid proof-of-delivery key")
        order.pod_key = body.pod_key
    profile = db.get(RiderProfile, user.id)
    if profile:
        profile.deliveries += 1
        profile.earnings += round(order.price * 0.8, 2)   # rider keeps 80%
    try:
        transition(db, order, OrderStatus.delivered, f"rider:{user.id}", pod=bool(body.pod_key))
    except InvalidTransition as e:
        raise HTTPException(409, str(e))
    dispatch.release_rider(user.id)
    return serialize(order)
