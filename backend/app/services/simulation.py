"""In-cluster traffic simulator, started and stopped from the dispatcher UI.

The same virtual riders and customers as simulator/simulator.py, run as an
asyncio task inside whichever API process received the start request. They
talk to that process over loopback (settings.simulator_base_url) through the
real REST + Socket.IO API, so dispatch, offers, queues and the live map all
behave exactly as with the terminal simulator, with no extra infrastructure.

Control and status live in Redis, so any API replica can start, stop or
report on the run:
    sim:lock    owner id of the process running the simulation (TTL heartbeat)
    sim:stop    set by the stop endpoint; the owner polls it
    sim:status  JSON snapshot the owner rewrites every couple of seconds
"""
import asyncio
import json
import math
import random
import time
import uuid
from dataclasses import asdict, dataclass

import httpx
import socketio

from app.config import settings
from app.redis_client import ar

PASSWORD = "dispatchx123"
CENTER = (12.9716, 77.5946)
AREAS = ["Koramangala", "Indiranagar", "HSR Layout", "Whitefield", "Jayanagar", "MG Road",
         "Malleshwaram", "BTM Layout", "Marathahalli", "Hebbal", "Electronic City", "JP Nagar"]
CUSTOMERS = 20
TICK = 2.0
LOCK, STOP, STATUS = "sim:lock", "sim:stop", "sim:status"
LEASE_S = 30

_task: asyncio.Task | None = None     # strong ref so the run isn't garbage-collected


@dataclass
class SimParams:
    riders: int = 30
    orders_per_min: float = 6
    accept_rate: float = 0.85
    duration_s: int = 300
    speedup: float = 8
    radius_km: float = 5


def _km_to_deg(lat, dx_km, dy_km):
    return dy_km / 110.574, dx_km / (111.320 * math.cos(math.radians(lat)))


def _dist_km(a, b):
    dlat = (b[0] - a[0]) * 110.574
    dlng = (b[1] - a[1]) * 111.320 * math.cos(math.radians(a[0]))
    return math.hypot(dlat, dlng)


def _random_point(center, radius_km):
    r = radius_km * math.sqrt(random.random())
    t = random.random() * 2 * math.pi
    dlat, dlng = _km_to_deg(center[0], r * math.cos(t), r * math.sin(t))
    return (center[0] + dlat, center[1] + dlng)


class _Run:
    def __init__(self, p: SimParams, owner: str, started_by: str):
        self.p, self.owner, self.started_by = p, owner, started_by
        self.started = time.time()
        self.running = True
        self.state = "starting"
        self.stats = dict(riders_online=0, rider_errors=0, orders_placed=0, order_errors=0,
                          offers=0, accepted=0, rejected=0, ignored=0, delivered=0, pings=0)

    def snapshot(self, state=None):
        now = time.time()
        return {
            "state": state or self.state,
            "params": asdict(self.p),
            "stats": self.stats,
            "started_at": self.started,
            "ends_at": self.started + self.p.duration_s,
            "elapsed_s": round(now - self.started),
            "started_by": self.started_by,
        }


async def _login(http, email):
    for attempt in range(4):
        try:
            res = await http.post("/api/auth/login", json={"email": email, "password": PASSWORD})
            res.raise_for_status()
            return res.json()["access_token"]
        except Exception:
            await asyncio.sleep(1 + attempt)
    raise RuntimeError(f"login failed for {email}")


class _Rider:
    def __init__(self, idx, run: _Run, http):
        self.idx, self.run, self.http, self.p = idx, run, http, run.p
        self.pos = _random_point(CENTER, self.p.radius_km)
        self.target = _random_point(CENTER, self.p.radius_km)
        self.heading = 0.0
        self.job = None
        self.phase = "idle"
        self.speed_kmh = random.uniform(18, 32)
        self.sio = socketio.AsyncClient(reconnection=True, reconnection_delay=1)
        self.token = None
        self.online = False

    @property
    def headers(self):
        return {"Authorization": f"Bearer {self.token}"}

    async def start(self):
        self.token = await _login(self.http, f"rider{self.idx}@sim.dispatchx.dev")
        self.sio.on("job:offer", self.on_offer)
        await self.sio.connect(settings.simulator_base_url, auth={"token": self.token}, transports=["websocket"])
        res = await self.http.post("/api/riders/me/online", headers=self.headers,
                                   json={"lat": self.pos[0], "lng": self.pos[1]})
        res.raise_for_status()
        self.online = True
        self.run.stats["riders_online"] += 1
        me = (await self.http.get("/api/riders/me", headers=self.headers)).json()
        if me.get("active_order"):
            self.job = me["active_order"]
            self.phase = "to_drop" if self.job["status"] == "picked_up" else "to_pickup"
        await self.loop()

    async def on_offer(self, data):
        st = self.run.stats
        st["offers"] += 1
        order = data["order"]
        await asyncio.sleep(random.uniform(0.5, 3.0))       # human reaction time
        if self.job or not self.run.running:
            return
        roll = random.random()
        if roll < self.p.accept_rate:
            res = await self.http.post(f"/api/riders/offers/{order['id']}/accept", headers=self.headers)
            if res.status_code == 200:
                st["accepted"] += 1
                self.job, self.phase = res.json(), "to_pickup"
        elif roll < self.p.accept_rate + (1 - self.p.accept_rate) / 2:
            await self.http.post(f"/api/riders/offers/{order['id']}/reject", headers=self.headers)
            st["rejected"] += 1
        else:
            st["ignored"] += 1     # let it time out -> exercises the offer-timeout path

    def step_towards(self, target) -> bool:
        step = self.speed_kmh * self.p.speedup / 3600 * TICK
        d = _dist_km(self.pos, target)
        if d <= step:
            self.pos = target
            return True
        frac = step / d
        lat = self.pos[0] + (target[0] - self.pos[0]) * frac
        lng = self.pos[1] + (target[1] - self.pos[1]) * frac
        wob_lat, wob_lng = _km_to_deg(lat, random.uniform(-0.01, 0.01), random.uniform(-0.01, 0.01))
        self.heading = (math.degrees(math.atan2(target[1] - self.pos[1], target[0] - self.pos[0])) + 360) % 360
        self.pos = (lat + wob_lat, lng + wob_lng)
        return False

    async def loop(self):
        while self.run.running:
            try:
                if self.phase == "idle":
                    if self.step_towards(self.target):
                        self.target = _random_point(CENTER, self.p.radius_km)
                elif self.phase == "to_pickup":
                    if self.step_towards((self.job["pickup_lat"], self.job["pickup_lng"])):
                        res = await self.http.post(f"/api/riders/orders/{self.job['id']}/pickup", headers=self.headers)
                        self.phase = "to_drop" if res.status_code == 200 else "idle"
                        if res.status_code != 200:
                            self.job = None
                elif self.phase == "to_drop":
                    if self.step_towards((self.job["drop_lat"], self.job["drop_lng"])):
                        await self.http.post(f"/api/riders/orders/{self.job['id']}/deliver",
                                             headers=self.headers, json={})
                        self.run.stats["delivered"] += 1
                        self.job, self.phase = None, "idle"
                if self.sio.connected:
                    await self.sio.emit("rider:location", {
                        "lat": self.pos[0], "lng": self.pos[1],
                        "heading": round(self.heading), "speed": round(self.speed_kmh),
                    })
                    self.run.stats["pings"] += 1
            except Exception:
                pass
            await asyncio.sleep(TICK)

    async def stop(self):
        """Finish any job in hand so no order is left stranded, then go offline."""
        if not self.online:
            return
        try:
            if self.job:
                if self.phase == "to_pickup":
                    await self.http.post(f"/api/riders/orders/{self.job['id']}/pickup", headers=self.headers)
                await self.http.post(f"/api/riders/orders/{self.job['id']}/deliver", headers=self.headers, json={})
                self.run.stats["delivered"] += 1
                self.job = None
            await self.http.post("/api/riders/me/offline", headers=self.headers)
        except Exception:
            pass
        try:
            await self.sio.disconnect()
        except Exception:
            pass


async def _customers(run: _Run, http):
    tokens = []
    for i in range(1, CUSTOMERS + 1):
        try:
            tokens.append(await _login(http, f"customer{i}@sim.dispatchx.dev"))
        except RuntimeError:
            pass
    if not tokens or run.p.orders_per_min <= 0:
        return
    interval = 60.0 / run.p.orders_per_min

    async def place(tok, body):
        try:
            res = await http.post("/api/orders", json=body, headers={"Authorization": f"Bearer {tok}"})
            res.raise_for_status()
            run.stats["orders_placed"] += 1
        except Exception:
            run.stats["order_errors"] += 1

    pending = set()
    while run.running:
        pickup = _random_point(CENTER, run.p.radius_km * 0.8)
        ang, km = random.random() * 2 * math.pi, random.uniform(1, 6)
        dlat, dlng = _km_to_deg(pickup[0], km * math.cos(ang), km * math.sin(ang))
        body = {
            "pickup": {"address": f"{random.randint(1, 300)}, {random.choice(AREAS)}", "lat": pickup[0], "lng": pickup[1]},
            "drop": {"address": f"{random.randint(1, 300)}, {random.choice(AREAS)}",
                     "lat": pickup[0] + dlat, "lng": pickup[1] + dlng},
            "package_note": random.choice(["Documents", "Food", "Electronics", "Groceries", "Keys", "Medicines"]),
        }
        t = asyncio.create_task(place(random.choice(tokens), body))
        pending.add(t)
        t.add_done_callback(pending.discard)
        await asyncio.sleep(random.expovariate(1 / interval))     # Poisson arrivals


async def _publish(run: _Run, state=None, ttl=LEASE_S):
    await ar.set(STATUS, json.dumps(run.snapshot(state)), ex=ttl)


async def _execute(run: _Run):
    limits = httpx.Limits(max_connections=200, max_keepalive_connections=100)
    riders: list[_Rider] = []
    tasks: list[asyncio.Task] = []
    try:
        async with httpx.AsyncClient(base_url=settings.simulator_base_url, timeout=20, limits=limits) as http:
            riders = [_Rider(i, run, http) for i in range(1, run.p.riders + 1)]

            async def staggered(rd, delay):
                await asyncio.sleep(delay)
                try:
                    await rd.start()
                except Exception:
                    run.stats["rider_errors"] += 1

            tasks = [asyncio.create_task(staggered(rd, i * 0.1)) for i, rd in enumerate(riders)]
            tasks.append(asyncio.create_task(_customers(run, http)))
            run.state = "running"
            deadline = run.started + run.p.duration_s
            while time.time() < deadline:
                await _publish(run)
                if await ar.get(LOCK) == run.owner:
                    await ar.expire(LOCK, LEASE_S)
                if await ar.exists(STOP):
                    break
                await asyncio.sleep(2)
            run.running = False
            run.state = "stopping"
            await _publish(run)
            await asyncio.gather(*(rd.stop() for rd in riders), return_exceptions=True)
            for t in tasks:
                t.cancel()
    finally:
        run.running = False
        for t in tasks:
            t.cancel()
        run.stats["riders_online"] = 0
        await _publish(run, "finished", ttl=600)
        await ar.delete(STOP)
        if await ar.get(LOCK) == run.owner:
            await ar.delete(LOCK)


async def start(p: SimParams, started_by: str) -> dict:
    global _task
    owner = uuid.uuid4().hex
    if not await ar.set(LOCK, owner, nx=True, ex=LEASE_S):
        raise RuntimeError("A simulation is already running")
    await ar.delete(STOP)
    run = _Run(p, owner, started_by)
    await _publish(run)
    _task = asyncio.create_task(_execute(run))
    return run.snapshot()


async def stop() -> dict:
    if await ar.exists(LOCK):
        await ar.set(STOP, "1", ex=LEASE_S * 4)
    return await status()


async def status() -> dict:
    raw = await ar.get(STATUS)
    snap = json.loads(raw) if raw else None
    if not snap:
        return {"state": "idle"}
    # A "running" snapshot without a live lock means its API process died
    if snap["state"] in ("starting", "running", "stopping") and not await ar.exists(LOCK):
        snap["state"] = "finished"
    if snap["state"] in ("running", "starting") and await ar.exists(STOP):
        snap["state"] = "stopping"
    return snap
