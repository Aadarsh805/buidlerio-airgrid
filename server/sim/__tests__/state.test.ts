// The state is plain JSON and stepping is resumable: what the app's one SQL row needs.
import { describe, expect, it } from "vitest";
import { createCity, decide, events, order, step, trigger, view } from "../src/index";

const roundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("state", () => {
  it("step(a, 3) then step(4) equals step(c, 7)", () => {
    const a = step(createCity(), 3);
    step(a, 4);
    const c = step(createCity(), 7);
    expect(a).toEqual(c);
  });

  it("round-trips through JSON mid-incident and keeps stepping identically", () => {
    const a = createCity("RT-1");
    trigger(a, "accident");
    trigger(a, "random_fire");
    step(a, 20);
    let b = roundTrip(a);
    expect(b).toEqual(a);
    for (let k = 0; k < 12; k++) {
      step(a, 5);
      b = roundTrip(step(b, 5));
      for (const s of [a, b]) {
        for (const inc of Object.values<any>(s.active)) {
          if (inc.decision) {
            const choice = inc.decision.kind === "treat_transport" ? "transport" : "leave";
            decide(s, { incident: inc.id, choice });
          }
        }
      }
      expect(b).toEqual(a);
    }
    expect(view(b)).toEqual(view(a));
  });

  it("is deterministic per seed and differs across seeds", () => {
    const go = (seed: string) => {
      const s = createCity(seed);
      trigger(s, "fire");
      order(s, { order: "watch", place: "ring road" });
      return JSON.stringify(view(step(s, 30)));
    };
    expect(go("D-1")).toEqual(go("D-1"));
    const scenes = ["A", "B", "C", "D", "E"].map((sd) => (trigger(createCity(sd), "fire") as any).incident.scene);
    expect(new Set(scenes).size).toBeGreaterThan(1); // the seed picks the scene; physics has no RNG
  });

  it("events(since) returns only newer city events", () => {
    const s = step(createCity(), 2);
    const all = events(s);
    const last = all[all.length - 1].seq;
    trigger(s, "fire");
    const fresh = events(s, last);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((e) => e.seq > last)).toBe(true);
  });

  it("keyless view never reveals a hidden fire", () => {
    const s = createCity();
    trigger(s, "random_fire");
    const keyless = JSON.stringify(view(s));
    const op = view(s, { operator: true }) as any;
    expect(op.unfound).toHaveLength(1);
    expect(keyless).not.toContain("unfound");
    expect(JSON.stringify((view(s) as any).detections)).toBe("[]");
  });
});
