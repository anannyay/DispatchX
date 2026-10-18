"""Socket.IO layer.

Every API instance runs an AsyncServer attached to a shared Redis pub/sub
channel, so an event emitted on any instance (or from a Celery / SQS worker
through the write-only `emitter`) reaches clients connected to any other
instance behind the load balancer.
"""
import asyncio
import logging
import time

import jwt
import socketio

from app.config import settings
from app.db import SessionLocal
from app.models import Order, Role
from app.redis_client import GEO, ONLINE, ar, metric, rider_state
from app.security import decode_token

log = logging.getLogger(__name__)

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*" if settings.cors_origins == "*" else settings.cors_origins.split(","),
    client_manager=socketio.AsyncRedisManager(settings.redis_url),
    ping_interval=20,
    ping_timeout=20,
)

# Synchronous, write-only handle for emitting from sync code (REST handlers,
# Celery tasks, the SQS consumer). It only publishes to Redis.
emitter = socketio.RedisManager(settings.redis_url, write_only=True)


def emit(event: str, data, room: str | list[str]):
    rooms = room if isinstance(room, list) else [room]
    for rm in rooms:
        emitter.emit(event, data, room=rm)


STAFF = {Role.dispatcher.value, Role.admin.value}


@sio.event
async def connect(sid, environ, auth):
    token = (auth or {}).get("token")
    if not token:
        raise socketio.exceptions.ConnectionRefusedError("missing token")
    try:
        claims = decode_token(token)
    except jwt.PyJWTError:
        raise socketio.exceptions.ConnectionRefusedError("invalid token")

    uid, role = int(claims["sub"]), claims["role"]
    await sio.save_session(sid, {"uid": uid, "role": role})
    await sio.enter_room(sid, f"user:{uid}")
    if role == Role.rider.value:
        await sio.enter_room(sid, f"rider:{uid}")
    if role in STAFF:
        await sio.enter_room(sid, "dispatch")
    await ar.incr(metric("socket_connects"))


@sio.event
async def disconnect(sid):
    pass


def _can_watch(uid: int, role: str, order_id: int) -> bool:
    with SessionLocal() as db:
        order = db.get(Order, order_id)
        if not order:
            return False
        return role in STAFF or order.customer_id == uid or order.rider_id == uid


@sio.on("order:subscribe")
async def order_subscribe(sid, data):
    sess = await sio.get_session(sid)
    oid = int(data.get("order_id", 0))
    if await asyncio.to_thread(_can_watch, sess["uid"], sess["role"], oid):
        await sio.enter_room(sid, f"order:{oid}")
        # Send the rider's last known position straight away
        order_rider = await asyncio.to_thread(_rider_of, oid)
        if order_rider:
            st = await ar.hgetall(rider_state(order_rider))
            if st.get("lat"):
                await sio.emit("rider:location", _loc_payload(order_rider, st), to=sid)
        return {"ok": True}
    return {"ok": False, "error": "forbidden"}


@sio.on("order:unsubscribe")
async def order_unsubscribe(sid, data):
    await sio.leave_room(sid, f"order:{int(data.get('order_id', 0))}")


def _rider_of(order_id: int) -> int | None:
    with SessionLocal() as db:
        o = db.get(Order, order_id)
        return o.rider_id if o else None


def _loc_payload(rid, st: dict) -> dict:
    return {
        "rider_id": int(rid),
        "lat": float(st["lat"]),
        "lng": float(st["lng"]),
        "heading": float(st.get("heading") or 0),
        "speed": float(st.get("speed") or 0),
        "order_id": int(st["order_id"]) if st.get("order_id") else None,
        "available": not st.get("order_id"),
        "name": st.get("name"),
        "ts": float(st.get("ts") or time.time()),
    }


@sio.on("rider:location")
async def rider_location(sid, data):
    """High-frequency GPS ping from a rider app (every ~2 s)."""
    sess = await sio.get_session(sid)
    if sess["role"] != Role.rider.value:
        return
    rid = sess["uid"]
    if not await ar.sismember(ONLINE, rid):
        return {"ok": False, "error": "offline"}
    lat, lng = float(data["lat"]), float(data["lng"])
    now = time.time()
    pipe = ar.pipeline()
    pipe.geoadd(GEO, (lng, lat, str(rid)))
    pipe.hset(rider_state(rid), mapping={
        "lat": lat, "lng": lng,
        "heading": data.get("heading", 0), "speed": data.get("speed", 0), "ts": now,
    })
    pipe.hgetall(rider_state(rid))
    pipe.incr(metric("location_updates"))
    *_, st, _ = await pipe.execute()

    payload = _loc_payload(rid, st)
    if payload["order_id"]:
        await sio.emit("rider:location", payload, room=f"order:{payload['order_id']}")
    await sio.emit("fleet:location", payload, room="dispatch")
    return {"ok": True}
