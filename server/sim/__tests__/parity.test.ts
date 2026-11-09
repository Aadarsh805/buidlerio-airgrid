// Parity with the Python sim: replay each recorded script and compare every result and every
// GET /city snapshot (stages, names, vehicles, counters, reports, events; numbers within 1e-6).
import { describe, expect, it } from "vitest";
import { CityState, view } from "../src/index";
import { diff, expected, load, run } from "./helpers";

const SCRIPTS = [
  "calm",
  "calm_long",
  "accident_transport",
  "fire_leave_stay",
  "random_fire",
  "two_at_once",
  "watch_order",
  "busy_day",
];

describe("parity with sim/city.py", () => {
  for (const name of SCRIPTS) {
    it(name, () => {
      const fx = load(name);
      let s: CityState | null = null;
      fx.ops.forEach((op: any, i: number) => {
        const r = run(s, op);
        s = r.state;
        const want = expected(op);
        if (want !== null) {
          const d = diff(r.got, want);
          expect(d, `${name} op #${i} (${op.op} ${op.kind ?? op.choice ?? op.order ?? ""})`).toEqual([]);
        }
        if (op.op === "snap") {
          // keyless view: identical minus `unfound`, and never mentions a hidden fire (rule 8)
          const keyless = view(s!, { operator: false }) as any;
          expect("unfound" in keyless).toBe(false);
          const { unfound, ...rest } = op.view;
          expect(diff(keyless, rest)).toEqual([]);
          for (const u of unfound ?? []) expect(JSON.stringify(keyless)).not.toContain(u.id);
        }
      });
    });
  }
});
