import redis
import redis.asyncio as aredis

from app.config import settings

r = redis.Redis.from_url(settings.redis_url, decode_responses=True)
ar = aredis.Redis.from_url(settings.redis_url, decode_responses=True)

# Key layout (documented here so every module agrees)
GEO = "riders:geo"                  # GEO set of online riders' positions
ONLINE = "riders:online"            # SET of online rider ids
AVAILABLE = "riders:available"      # SET of online riders without an active job


def rider_state(rid: int | str) -> str:
    return f"rider:{rid}:state"     # HASH lat,lng,heading,speed,ts,name,rating,vehicle,order_id


def rider_offer(rid: int | str) -> str:
    return f"rider:{rid}:offer"     # order id currently offered to this rider (TTL = offer timeout)


def order_offer(oid: int | str) -> str:
    return f"order:{oid}:offer"     # rider id the order is currently offered to


def order_tried(oid: int | str) -> str:
    return f"order:{oid}:tried"     # SET of riders that already declined / timed out


def dispatch_lock(oid: int | str) -> str:
    return f"lock:dispatch:{oid}"   # makes dispatch idempotent under duplicate SQS deliveries


def metric(name: str) -> str:
    return f"metrics:{name}"
