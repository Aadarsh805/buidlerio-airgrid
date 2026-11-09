// AirGrid city simulator, TypeScript port of sim/city.py (fictional district, simulated).
//
// Pure and deterministic: no timers, no IO, no Node-only APIs. CityState is plain JSON: store it
// in one row, load it, keep stepping. The functions below mutate the state they are given (and
// step returns it); clone first (structuredClone or JSON) if you need the old one.

import { CityState, CityError, CityInvalid, cityView, decide as cityDecide, idleView, newCity, order as cityOrder, randomFire, tick, trigger as cityTrigger, incidentView } from "./city";
import { EPS } from "./pymath";

export type { CityState } from "./city";
export { CityError, CityInvalid, idleView } from "./city";

/** POST /city/start: every drone docked at 100%, six roamers launched, the first city event. */
export function createCity(seed?: string | null): CityState {
  return newCity(seed);
}

/** Advance the sim clock by `minutes` (0.1 sim-min ticks), exactly like Engine.run_until(now +
 * minutes). Resumable: step(s, 3); step(s, 4) equals step(s, 7). */
export function step(state: CityState, minutes: number): CityState {
  const target = state.eng.now + minutes;
  while (state.eng.t <= target + EPS) tick(state);
  return state;
}

/** Advance exactly n ticks. */
export function ticks(state: CityState, n: number): CityState {
  for (let i = 0; i < n; i++) tick(state);
  return state;
}

/** POST /city/trigger {kind}: "fire" | "accident" | "random_fire". Same body as the Python route
 * (without ok/simulated). Throws CityError(NOT_FOUND) for an unknown kind. */
export function trigger(state: CityState, kind: string) {
  if (kind === "random_fire") return { incident: null, ...randomFire(state) };
  return { incident: cityTrigger(state, kind) };
}

/** POST /city/decide {incident | place, choice}. Throws CityError (NOT_FOUND, MISSION_EXPIRED)
 * or CityInvalid for a choice that doesn't fit the open call. */
export function decide(state: CityState, args: { incident?: string | null; place?: string | null; choice: string }) {
  if (!args.incident && !args.place) throw new CityInvalid("needs incident or place");
  return cityDecide(state, args.incident ?? null, args.choice, args.place ?? null);
}

/** POST /city/order {order, place, drone, minutes}: watch | unwatch | dock | release (L67). */
export function order(
  state: CityState,
  args: { order: string; place?: string; drone?: string; minutes?: number | null },
) {
  return cityOrder(state, args.order, args.place ?? "", args.drone ?? "", args.minutes ?? null);
}

/** GET /city. `operator: true` is the X-Game-Key view: it adds `unfound` (L63). Keyless never
 * reveals a hidden fire. */
export function view(state: CityState | null, opts: { operator?: boolean; since?: number } = {}) {
  const body = state === null ? idleView() : cityView(state, opts.since ?? 0, Boolean(opts.operator));
  return { ok: true, simulated: true, ...body };
}

/** City events with seq > since (the last `events_kept`). */
export function events(state: CityState, since = 0) {
  return state.events.filter((e) => e.seq > since);
}

/** One incident's view by id (null when closed). */
export function incident(state: CityState, id: string) {
  const inc = state.active[id];
  return inc ? incidentView(state, inc) : null;
}
