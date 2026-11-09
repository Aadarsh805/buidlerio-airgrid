"""Record seeded city-mode scripts from the Python sim as JSON fixtures for the TS parity tests.

Run (read-only use of the airgrid repo):
    uv run --project D:/dronedrone/AirGrid-Kit-v1/airgrid python D:/dronedrone/AirGrid-Kit-v1/_an-staging/parity/make_fixtures.py

Writes:
    ../sim/world.json          the world data the TS sim needs (from world/airgrid.yaml)
    fixtures/<script>.json     {name, seed, ops: [...]}; each op carries its result, error or view

Ops: create, step {min} (Engine.run_until(now + min)), ticks {n} (n x Engine.step), trigger {kind},
decide {incident|place, choice}, order {order, place, drone, minutes}, snap {view} (GET /city with
the operator key, body as the route returns it).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

AIRGRID = Path("D:/dronedrone/AirGrid-Kit-v1/airgrid")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(AIRGRID))

from sim import city as ct  # noqa: E402
from sim.engine import Engine  # noqa: E402
from sim.world import load_world  # noqa: E402

W = load_world()


def write_world() -> None:
    raw = W.raw
    keep = {
        "district": {k: raw["district"][k] for k in ("name", "size_km", "sectors", "junctions", "landmarks")},
        "zones": raw["zones"],
        "docks": raw["docks"],
        "drone_model": raw["drone_model"],
        "fleet": raw["fleet"],
        "pilots": raw["pilots"],
        "policies": {
            k: raw["policies"][k]
            for k in (
                "ready_floor",
                "thermal_penalty_km",
                "slot_log_radius_km",
                "geofence_km",
                "safety_rtb_margin_pct",
            )
        },
        "ground_units": {"road_speed_km_per_min": raw["ground_units"]["road_speed_km_per_min"]},
        "city": raw["city"],
    }
    out = HERE.parent / "sim" / "world.json"
    out.write_text(json.dumps(keep, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class Rec:
    def __init__(self, name: str, seed: str | None):
        self.name, self.seed = name, seed
        scen = ct.scenario(W, seed)
        self.eng = Engine(W, scen, seed=scen["seed"], mode="city")
        self.c = ct.City(self.eng)
        self.c.start()
        self.ops: list[dict] = [{"op": "create", "seed": seed}]

    # --- time
    def step(self, minutes: float) -> None:
        self.eng.run_until(self.eng.now + minutes)
        self.ops.append({"op": "step", "min": minutes})

    def until(self, cond, limit_min: float = 240) -> int:
        n = 0
        while not cond():
            if n > limit_min * 10:
                raise RuntimeError(f"{self.name}: condition not reached")
            self.eng.step()
            n += 1
        if n:
            self.ops.append({"op": "ticks", "n": n})
        return n

    # --- writes, recorded with their result or error
    def _do(self, op: dict, fn):
        try:
            op["result"] = fn()
        except ct.CityError as e:
            op["error"] = e.rejection.body()
        except ValueError as e:
            op["invalid"] = str(e)
        self.ops.append(op)
        return op.get("result")

    def trigger(self, kind: str):
        def go():
            if kind == "random_fire":
                return {"incident": None, **self.c.random_fire()}
            return {"incident": self.c.trigger(kind)}

        return self._do({"op": "trigger", "kind": kind}, go)

    def decide(self, choice: str, incident: str | None = None, place: str | None = None):
        op = {"op": "decide", "incident": incident, "place": place, "choice": choice}
        return self._do(op, lambda: self.c.decide(incident, choice, place=place))

    def order(self, order: str, place: str = "", drone: str = "", minutes=None):
        op = {"op": "order", "order": order, "place": place, "drone": drone, "minutes": minutes}
        return self._do(op, lambda: self.c.order(order, place, drone, minutes))

    def snap(self) -> dict:
        v = {"ok": True, "simulated": True, **self.c.view(0, operator=True)}
        self.ops.append({"op": "snap", "view": json.loads(json.dumps(v))})
        return v

    # --- helpers
    def stage(self, iid: str) -> str:
        i = self.c.active.get(iid)
        return i["stage"] if i else "closed"

    def save(self) -> None:
        out = HERE / "fixtures" / f"{self.name}.json"
        body = {"name": self.name, "seed": self.seed, "ops": self.ops}
        out.write_text(json.dumps(body, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{self.name}: {len(self.ops)} ops, {sum(1 for o in self.ops if o['op'] == 'snap')} snaps")


def calm():
    r = Rec("calm", None)
    r.snap()
    r.step(5)
    r.snap()
    r.step(5)
    r.snap()
    r.save()


def calm_long():
    r = Rec("calm_long", "LONG-1")
    for m in (30, 30.5, 29.5, 40):
        r.step(m)
        r.snap()
    r.save()


def accident_transport():
    r = Rec("accident_transport", None)  # CITY-01: injuries, transport, a blocked junction
    r.step(2)
    iid = r.trigger("accident")["incident"]["id"]
    r.until(lambda: r.stage(iid) == "care_call")
    r.snap()
    r.decide("transport", incident=iid)
    r.until(lambda: r.stage(iid) == "blocked")
    r.snap()
    r.until(lambda: r.c.active[iid]["escort"]["status"] == "delivered")
    r.snap()
    r.until(lambda: r.stage(iid) == "watching")
    r.snap()
    scene = r.c.active[iid]["scene"].split()[0].lower()
    r.decide("leave", place=scene)
    r.snap()
    r.step(5)
    r.snap()
    r.save()


def fire_leave_stay():
    # stay then leave on one fire; then a seed whose second fire is at risk and flares up on leave
    for k in range(1, 300):
        r = Rec("fire_leave_stay", f"F-{k}")
        iid = r.trigger("fire")["incident"]["id"]
        r.until(lambda iid=iid: r.stage(iid) == "watching")
        r.snap()
        r.decide("bogus", incident=iid)  # invalid choice
        r.decide("stay", place="zzz")  # no such place: NOT_FOUND
        r.decide("stay", incident=iid)
        r.decide("stay", incident=iid)  # no open call: MISSION_EXPIRED
        r.snap()
        r.until(lambda iid=iid: r.stage(iid) == "watching")
        r.snap()
        r.decide("approve", incident=iid)
        r.decide("leave", incident=iid)  # closed now: NOT_FOUND
        r.step(2)
        iid2 = r.trigger("fire")["incident"]["id"]
        if not r.c.active[iid2]["at_risk"]:
            continue
        r.until(lambda iid2=iid2: r.stage(iid2) == "watching")
        r.decide("leave", incident=iid2)
        if not r.c.flares:
            continue
        r.step(3.5)
        r.snap()
        r.step(30)
        r.snap()
        r.save()
        return
    raise RuntimeError("no flaring seed found")


def random_fire():
    r = Rec("random_fire", None)
    r.step(1)
    r.trigger("random_fire")
    r.snap()
    r.until(lambda: r.c.detections() or r.c.active)
    r.snap()
    r.until(lambda: r.c.active)
    r.snap()
    iid = next(iter(r.c.active))
    r.until(lambda: r.stage(iid) == "watching")
    r.decide("leave", incident=iid)
    r.snap()
    r.trigger("random_fire")
    r.step(12)
    r.snap()
    r.save()


def two_at_once():
    r = Rec("two_at_once", "TWO-3")
    r.step(1.5)
    r.trigger("fire")
    r.trigger("accident")
    r.snap()
    for _ in range(8):
        if not r.c.active:
            break
        r.until(lambda: any(i["decision"] for i in r.c.active.values()) or not r.c.active)
        r.snap()
        for i in list(r.c.active.values()):
            if i["decision"]:
                r.decide("treat" if i["decision"]["kind"] == ct.TREAT_TRANSPORT else "leave", incident=i["id"])
    r.step(4)
    r.snap()
    r.save()


def watch_order():
    r = Rec("watch_order", None)
    r.step(3)
    r.order("watch", place="zzz")  # NOT_FOUND
    r.order("watch", place="street")  # ambiguous: NOT_FOUND
    r.order("watch", place="market", minutes=20)
    r.snap()
    r.step(10)
    r.snap()
    roamer = next(d.id for d in r.eng.drones.values() if d.mission == "roam")
    r.order("dock", drone=roamer.lower())
    r.order("dock", drone=roamer)  # already grounded
    r.order("dock", drone="D-99")  # NOT_FOUND
    r.order("release", drone="D-01" if roamer != "D-01" else "D-02")  # not grounded
    r.snap()
    r.step(12)
    r.snap()
    r.order("release", drone=roamer)
    r.order("unwatch", place="market")  # ended already: NOT_FOUND
    r.order("watch", place="north road", minutes=120)
    r.order("watch", place="north road", minutes=3)  # extends, clamps to 5
    r.order("watch", place="ring road")
    r.step(20)
    r.snap()
    r.order("unwatch", place="ring")
    r.order("fly", place="ring")  # unknown order
    r.step(40)
    r.snap()
    r.save()


def busy_day():
    r = Rec("busy_day", "BUSY-7")
    r.trigger("accident")
    r.trigger("fire")
    r.trigger("random_fire")
    r.step(6)
    r.trigger("fire")
    r.trigger("flood")  # unknown trigger
    for _ in range(14):
        r.step(8)
        for i in list(r.c.active.values()):
            if i["decision"]:
                if i["decision"]["kind"] == ct.TREAT_TRANSPORT:
                    r.decide("transport", incident=i["id"])
                else:
                    r.decide("stay" if i["stage"] == "watching" and i["at_risk"] else "leave", incident=i["id"])
        r.snap()
    r.save()


def primitives():
    import math
    import random

    from sim.geo import fmt

    rng_out = []
    for seed in ("CITY-01", "CITY-01:care:1", "T-1:random_fire:3", "", "ünïcode-seed", "x" * 300):
        g = random.Random(seed)
        rng_out.append(
            {
                "seed": seed,
                "random": [g.random() for _ in range(700)],
                "choice7": [g.choice(range(7)) for _ in range(50)],
                "randint13": [g.randint(1, 3) for _ in range(50)],
                "choice100": [g.choice(range(100)) for _ in range(50)],
            }
        )
    g = random.Random("hypot")
    pairs = [[g.uniform(-6, 6), g.uniform(-6, 6)] for _ in range(3000)]
    pairs += [[g.choice([0.05, 0.15, 0.25, 0.3, 1.5, 0.75]) * g.randint(0, 9), 0.0] for _ in range(50)]
    pairs += [[3.0, 4.0], [0.0, 0.0], [1e-9, 2e-9], [0.1, 0.2]]
    hyp = [[x, y, math.hypot(x, y)] for x, y in pairs]
    xs = [g.uniform(0, 1500) for _ in range(500)] + [0.25, 0.75, 2.5, 0.125, 84.25, 1.0625, 2.0625, 540.05, 0.5, 1.5]
    rounds = [[x, n, round(x, n), f"{x:.{n}f}" if n <= 1 else None] for x in xs for n in (0, 1, 3, 4)]
    fmts = [[t, fmt(t)] for t in xs + [540 + k * 0.1 for k in range(0, 700, 7)]]
    gs = [[x, f"{x:g}"] for x in [2.25, 1.5, 3.0, 0.75, 4.5, 5.25, 1.0, 0.1, 3.1416, 2.0625, 1e-5, 123456789.0]]
    out = {"rng": rng_out, "hypot": hyp, "round": rounds, "fmt": fmts, "g": gs}
    (HERE / "fixtures" / "primitives.json").write_text(json.dumps(out) + chr(10), encoding="utf-8")
    print("primitives written")


if __name__ == "__main__":
    (HERE / "fixtures").mkdir(exist_ok=True)
    write_world()
    primitives()
    calm()
    calm_long()
    accident_transport()
    fire_leave_stay()
    random_fire()
    two_at_once()
    watch_order()
    busy_day()
