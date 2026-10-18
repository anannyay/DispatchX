"""DispatchX load & demo simulator.

Spawns virtual riders that drive around the city streaming GPS over
Socket.IO, accept or decline job offers like real people, and complete
deliveries, plus virtual customers placing orders at a configurable rate.

    python simulator.py --base-url http://localhost:8000 --riders 50 --orders-per-min 20
    python simulator.py --base-url https://dxxxx.cloudfront.net --riders 300 --orders-per-min 120

Seed the accounts first:  python -m app.seed --riders 300 --customers 50
"""
import argparse
import asyncio
import math
import random
import signal
import time
from dataclasses import dataclass, field

import httpx
import socketio

PASSWORD = "dispatchx123"
CITIES = {
    "bangalore": (12.9716, 77.5946, [
        "Koramangala", "Indiranagar", "HSR Layout", "Whitefield", "Jayanagar", "MG Road",
        "Malleshwaram", "BTM Layout", "Marathahalli", "Hebbal", "Electronic City", "JP Nagar",
    ]),
    "mumbai": (19.0760, 72.8777, ["Bandra", "Andheri", "Powai", "Dadar", "Colaba", "Worli", "Juhu"]),
    "delhi": (28.6139, 77.2090, ["Connaught Place", "Saket", "Dwarka", "Karol Bagh", "Hauz Khas"]),
}


@dataclass
class Stats:
    orders_placed: int = 0
    order_errors: int = 0
    offers: int = 0
    accepted: int = 0
    rejected: int = 0
    ignored: int = 0
    delivered: int = 0
    pings: int = 0
    started: float = field(default_factory=time.time)


stats = Stats()
running = True


def km_to_deg(lat: float, dx_km: float, dy_km: float):
    return dy_km / 110.574, dx_km / (111.320 * math.cos(math.radians(lat)))


def dist_km(a, b):
    dlat = (b[0] - a[0]) * 110.574
    dlng = (b[1] - a[1]) * 111.320 * math.cos(math.radians(a[0]))
    return math.hypot(dlat, dlng)


def random_point(center, radius_km):
    r = radius_km * math.sqrt(random.random())
    t = random.random() * 2 * math.pi
    dlat, dlng = km_to_deg(center[0], r * math.cos(t), r * math.sin(t))
    return (center[0] + dlat, center[1] + dlng)


async def login(http: httpx.AsyncClient, email: str) -> str:
    for attempt in range(5):
        try:
            res = await http.post("/api/auth/login", json={"email": email, "password": PASSWORD})
            res.raise_for_status()
            return res.json()["access_token"]
        except Exception:
            await asyncio.sleep(1 + attempt)
    raise RuntimeError(f"login failed for {email}")


class Rider:
    def __init__(self, idx, args, http, center):
        self.idx, self.args, self.http, self.center = idx, args, http, center
        self.email = f"rider{idx}@sim.dispatchx.dev"
        self.pos = random_point(center, args.radius_km)
        self.heading = 0.0
        self.target = random_point(center, args.radius_km)
        self.job = None            # active order dict
        self.phase = "idle"        # idle | to_pickup | to_drop
        self.sio = socketio.AsyncClient(reconnection=True, reconnection_delay=1)
        self.token = None
        self.speed_kmh = random.uniform(18, 32)
        self.patience = random.random()  # some riders ignore offers more than others

    @property
    def headers(self):
        return {"Authorization": f"Bearer {self.token}"}

    async def start(self):
        self.token = await login(self.http, self.email)
        self.sio.on("job:offer", self.on_offer)
        await self.sio.connect(self.args.base_url, auth={"token": self.token}, transports=["websocket"])
        res = await self.http.post("/api/riders/me/online", headers=self.headers,
                                   json={"lat": self.pos[0], "lng": self.pos[1]})
        res.raise_for_status()
        me = (await self.http.get("/api/riders/me", headers=self.headers)).json()
        if me.get("active_order"):        # resume after a simulator restart
            self.job = me["active_order"]
            self.phase = "to_drop" if self.job["status"] == "picked_up" else "to_pickup"
        await self.loop()

    async def on_offer(self, data):
        stats.offers += 1
        order = data["order"]
        await asyncio.sleep(random.uniform(0.5, 3.0))   # human reaction time
        roll = random.random()
        if self.job:
            return
        if roll < self.args.accept_rate:
            res = await self.http.post(f"/api/riders/offers/{order['id']}/accept", headers=self.headers)
            if res.status_code == 200:
                stats.accepted += 1
                self.job, self.phase = res.json(), "to_pickup"
        elif roll < self.args.accept_rate + (1 - self.args.accept_rate) / 2:
            await self.http.post(f"/api/riders/offers/{order['id']}/reject", headers=self.headers)
            stats.rejected += 1
        else:
            stats.ignored += 1     # let it time out -> exercises the Celery offer-timeout path

    def step_towards(self, target) -> bool:
        """Move toward target; returns True on arrival."""
        step = self.speed_kmh * self.args.speedup / 3600 * self.args.tick
        d = dist_km(self.pos, target)
        if d <= step:
            self.pos = target
            return True
        frac = step / d
        lat = self.pos[0] + (target[0] - self.pos[0]) * frac
        lng = self.pos[1] + (target[1] - self.pos[1]) * frac
        # small lateral wobble so tracks don't look like ruler lines
        wob_lat, wob_lng = km_to_deg(lat, random.uniform(-0.01, 0.01), random.uniform(-0.01, 0.01))
        self.heading = (math.degrees(math.atan2(target[1] - self.pos[1], target[0] - self.pos[0])) + 360) % 360
        self.pos = (lat + wob_lat, lng + wob_lng)
        return False

    async def loop(self):
        while running:
            try:
                if self.phase == "idle":
                    if self.step_towards(self.target):
                        self.target = random_point(self.center, self.args.radius_km)
                elif self.phase == "to_pickup":
                    if self.step_towards((self.job["pickup_lat"], self.job["pickup_lng"])):
                        await asyncio.sleep(random.uniform(1, 3))
                        res = await self.http.post(f"/api/riders/orders/{self.job['id']}/pickup", headers=self.headers)
                        self.phase = "to_drop" if res.status_code == 200 else "idle"
                        if res.status_code != 200:
                            self.job = None
                elif self.phase == "to_drop":
                    if self.step_towards((self.job["drop_lat"], self.job["drop_lng"])):
                        await asyncio.sleep(random.uniform(1, 2))
                        await self.http.post(f"/api/riders/orders/{self.job['id']}/deliver",
                                             headers=self.headers, json={})
                        stats.delivered += 1
                        self.job, self.phase = None, "idle"
                if self.sio.connected:
                    await self.sio.emit("rider:location", {
                        "lat": self.pos[0], "lng": self.pos[1],
                        "heading": round(self.heading), "speed": round(self.speed_kmh),
                    })
                    stats.pings += 1
            except Exception as e:
                if self.args.verbose:
                    print(f"rider {self.idx}: {e!r}")
            await asyncio.sleep(self.args.tick)

    async def stop(self):
        try:
            if not self.job:
                await self.http.post("/api/riders/me/offline", headers=self.headers)
            await self.sio.disconnect()
        except Exception:
            pass


async def customers(args, http, center, areas):
    tokens = []
    for i in range(1, args.customers + 1):
        try:
            tokens.append(await login(http, f"customer{i}@sim.dispatchx.dev"))
        except RuntimeError:
            pass
    if not tokens:
        print("No sim customers could log in. Did you run the seed script?")
        return
    interval = 60.0 / args.orders_per_min if args.orders_per_min > 0 else None
    while running and interval:
        tok = random.choice(tokens)
        pickup = random_point(center, args.radius_km * 0.8)
        # Most deliveries are short hops (1-6 km)
        ang, km = random.random() * 2 * math.pi, random.uniform(1, 6)
        dlat, dlng = km_to_deg(pickup[0], km * math.cos(ang), km * math.sin(ang))
        drop = (pickup[0] + dlat, pickup[1] + dlng)
        body = {
            "pickup": {"address": f"{random.randint(1, 300)}, {random.choice(areas)}", "lat": pickup[0], "lng": pickup[1]},
            "drop": {"address": f"{random.randint(1, 300)}, {random.choice(areas)}", "lat": drop[0], "lng": drop[1]},
            "package_note": random.choice(["Documents", "Food", "Electronics", "Groceries", "Keys", "Medicines"]),
        }

        async def place(t=tok, b=body):
            try:
                res = await http.post("/api/orders", json=b, headers={"Authorization": f"Bearer {t}"})
                res.raise_for_status()
                stats.orders_placed += 1
            except Exception as e:
                stats.order_errors += 1
                if args.verbose:
                    print(f"order failed: {e!r}")

        asyncio.create_task(place())
        # Poisson arrivals look like real demand
        await asyncio.sleep(random.expovariate(1 / interval))


async def reporter():
    while running:
        await asyncio.sleep(10)
        el = time.time() - stats.started
        print(f"[{el:6.0f}s] orders={stats.orders_placed} (err {stats.order_errors}) "
              f"offers={stats.offers} accepted={stats.accepted} rejected={stats.rejected} "
              f"ignored={stats.ignored} delivered={stats.delivered} gps/s={stats.pings / el:.1f}")


async def main(args):
    global running
    lat, lng, areas = CITIES[args.city]
    center = (lat, lng)
    limits = httpx.Limits(max_connections=200, max_keepalive_connections=100)
    async with httpx.AsyncClient(base_url=args.base_url, timeout=20, limits=limits) as http:
        riders = [Rider(i, args, http, center) for i in range(args.start_index, args.start_index + args.riders)]
        print(f"Starting {len(riders)} riders and {args.orders_per_min} orders/min against {args.base_url}")

        async def staggered(rd, delay):
            await asyncio.sleep(delay)
            try:
                await rd.start()
            except Exception as e:
                print(f"rider {rd.idx} failed to start: {e!r}")

        tasks = [asyncio.create_task(staggered(rd, i * args.ramp)) for i, rd in enumerate(riders)]
        tasks.append(asyncio.create_task(customers(args, http, center, areas)))
        tasks.append(asyncio.create_task(reporter()))

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        if args.duration:
            loop.call_later(args.duration, stop.set)
        await stop.wait()
        running = False
        print("Stopping: taking riders offline...")
        await asyncio.gather(*(rd.stop() for rd in riders), return_exceptions=True)
        for t in tasks:
            t.cancel()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--riders", type=int, default=30)
    ap.add_argument("--start-index", type=int, default=1, help="first rider number (run several simulators side by side)")
    ap.add_argument("--customers", type=int, default=20)
    ap.add_argument("--orders-per-min", type=float, default=10)
    ap.add_argument("--accept-rate", type=float, default=0.85)
    ap.add_argument("--city", choices=CITIES, default="bangalore")
    ap.add_argument("--radius-km", type=float, default=7)
    ap.add_argument("--speedup", type=float, default=6, help="riders move N x faster than real life")
    ap.add_argument("--tick", type=float, default=2.0, help="seconds between GPS pings")
    ap.add_argument("--ramp", type=float, default=0.05, help="seconds between rider logins")
    ap.add_argument("--duration", type=float, default=0, help="stop after N seconds (0 = run until Ctrl+C)")
    ap.add_argument("-v", "--verbose", action="store_true")
    asyncio.run(main(ap.parse_args()))
