import math

from app.config import settings


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def quote(pickup_lat, pickup_lng, drop_lat, drop_lng) -> dict:
    # Straight-line distance x 1.3 road factor is a good approximation for city trips
    km = round(haversine_km(pickup_lat, pickup_lng, drop_lat, drop_lng) * 1.3, 2)
    price = round(settings.base_fare + settings.per_km_fare * km, 0)
    eta = round(km / settings.avg_speed_kmh * 60 + 8, 1)  # +8 min average pickup time
    return {"distance_km": km, "price": price, "eta_minutes": eta}
