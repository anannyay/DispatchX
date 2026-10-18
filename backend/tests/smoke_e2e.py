"""End-to-end smoke test against a running stack (local or AWS).

    BASE_URL=https://dxxxx.cloudfront.net python tests/smoke_e2e.py

Customer places an order -> rider near the pickup receives a live offer over
Socket.IO -> accepts -> customer sees the rider's GPS -> pickup -> delivery
with a proof-of-delivery photo upload.
"""
import os
import queue
import sys
import time

import httpx
import socketio

BASE = os.environ.get("BASE_URL", "http://localhost:8000").rstrip("/")
PW = "dispatchx123"
PICKUP = {"address": "Koramangala 5th Block", "lat": 12.9352, "lng": 77.6245}
DROP = {"address": "Indiranagar 100ft Rd", "lat": 12.9719, "lng": 77.6412}


def login(c, email):
    res = c.post("/api/auth/login", json={"email": email, "password": PW})
    res.raise_for_status()
    return res.json()["access_token"]


def step(msg):
    print(f"  ✓ {msg}")


def main():
    c = httpx.Client(base_url=BASE, timeout=15)
    cust = login(c, "customer@dispatchx.dev")
    rider = login(c, "rider@dispatchx.dev")
    H = lambda t: {"Authorization": f"Bearer {t}"}
    step("logged in customer + rider")

    # Finish anything a previous (interrupted) run left on the demo rider
    active = c.get("/api/riders/me", headers=H(rider)).json().get("active_order")
    if active:
        if active["status"] == "assigned":
            c.post(f"/api/riders/orders/{active['id']}/pickup", headers=H(rider))
        c.post(f"/api/riders/orders/{active['id']}/deliver", json={}, headers=H(rider))
        step(f"cleaned up leftover order #{active['id']}")

    offers, cust_updates, cust_locs = queue.Queue(), queue.Queue(), queue.Queue()
    rs = socketio.Client()
    rs.on("job:offer", lambda d: offers.put(d))
    rs.connect(BASE, auth={"token": rider}, transports=["websocket"])
    cs = socketio.Client()
    cs.on("order:update", lambda d: cust_updates.put(d))
    cs.on("rider:location", lambda d: cust_locs.put(d))
    cs.connect(BASE, auth={"token": cust}, transports=["websocket"])
    step("both sockets connected")

    # Rider goes online right next to the pickup
    c.post("/api/riders/me/online", json={"lat": 12.9360, "lng": 77.6250}, headers=H(rider)).raise_for_status()
    rs.call("rider:location", {"lat": 12.9360, "lng": 77.6250})
    step("rider online")

    q = c.post("/api/orders/quote", json={"pickup": PICKUP, "drop": DROP}, headers=H(cust)).json()
    step(f"quote: {q['distance_km']} km, Rs {q['price']}, ~{q['eta_minutes']} min")
    t0 = time.time()
    order = c.post("/api/orders", json={"pickup": PICKUP, "drop": DROP, "package_note": "Documents"}, headers=H(cust))
    order.raise_for_status()
    oid = order.json()["id"]
    cs.call("order:subscribe", {"order_id": oid})
    step(f"order #{oid} placed")

    # Other riders (e.g. the simulator) may win nearby orders; wait for ours
    deadline = time.time() + 60
    while True:
        offer = offers.get(timeout=max(1, deadline - time.time()))
        if offer["order"]["id"] == oid:
            break
    step(f"rider received offer in {time.time() - t0:.2f}s ({offer['distance_to_pickup_km']} km away)")

    c.post(f"/api/riders/offers/{oid}/accept", headers=H(rider)).raise_for_status()
    while (u := cust_updates.get(timeout=10))["status"] != "assigned" or u["id"] != oid:
        pass
    step(f"customer saw 'assigned' live (rider: {u['rider_name']})")

    rs.call("rider:location", {"lat": 12.9355, "lng": 77.6247, "heading": 90})
    loc = cust_locs.get(timeout=10)
    step(f"customer received live rider location {loc['lat']:.4f},{loc['lng']:.4f}")

    c.post(f"/api/riders/orders/{oid}/pickup", headers=H(rider)).raise_for_status()
    step("picked up")

    up = c.post("/api/uploads/pod", json={"order_id": oid, "content_type": "image/png"}, headers=H(rider)).json()
    png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                        "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082")
    httpx.put(up["upload_url"], content=png, headers=up["headers"], timeout=15).raise_for_status()
    step(f"proof of delivery uploaded -> {up['key']}")

    d = c.post(f"/api/riders/orders/{oid}/deliver", json={"pod_key": up["key"]}, headers=H(rider))
    d.raise_for_status()
    step(f"delivered in {time.time() - t0:.1f}s total")

    events = c.get(f"/api/orders/{oid}/events", headers=H(cust)).json()
    step("audit trail: " + " -> ".join(e["type"] for e in events))

    c.post("/api/riders/me/offline", headers=H(rider))
    rs.disconnect()
    cs.disconnect()
    print("SMOKE TEST PASSED")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"SMOKE TEST FAILED: {e!r}")
        sys.exit(1)
