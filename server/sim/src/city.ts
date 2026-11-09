// sim/city.py ported: roaming, stations, road routing, incidents, assessment, ambulance escort,
// traffic, random hidden fire found by a simulated sensor, watch/dock/release orders,
// leave/stay/transport/treat, reports, #fleet board and log. Every function keeps the Python
// name (camelCased) and its op order; comments only where the port differs in form.

import {
  W,
  Drone,
  EngineState,
  ZONES,
  closeIncident,
  divert,
  dronesList,
  emit,
  firstHumanRemotePilot,
  floorAllows,
  fly,
  injectAlert,
  launch,
  launchIncident,
  movement,
  newEngine,
  noFlyOk,
  pilotFor,
  privacyUpdate,
  readyCandidates,
  rtb,
} from "./engine";
import { DT, dist, fmt, maxBy, minBy, pyFixed, pyG, pyRound, pyStr, pySum, sortBy, tmin } from "./pymath";
import { choice, randint, random, seedRng } from "./random";
import { Roads } from "./roads";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const NAME = "CITY";
export const CFG = W.city;
const MODEL = W.drone_model;
const SPEED: number = W.ground_units.road_speed_km_per_min;
const JUNCTIONS: Record<string, number[]> = W.district.junctions;
export const ROADS = new Roads(JUNCTIONS);
const ROUTES: number[][][] = CFG.roam.map((r: string[]) => r.map((j) => JUNCTIONS[j]));
const NL = "\n";

export const LEAVE_STAY = "leave_stay";
export const TREAT_TRANSPORT = "treat_transport";
const OPTIONS: Record<string, { id: string; label: string }[]> = {
  [LEAVE_STAY]: [
    { id: "leave", label: "Return to patrol" },
    { id: "stay", label: "Stay longer" },
  ],
  [TREAT_TRANSPORT]: [
    { id: "transport", label: "Transport to Hospital" },
    { id: "treat", label: "Treat on scene" },
  ],
};
const CHOICES: Record<string, Record<string, string>> = {
  [LEAVE_STAY]: { leave: "leave", approve: "leave", stay: "stay" },
  [TREAT_TRANSPORT]: { transport: "transport", treat: "treat" },
};
const ROLES: Record<string, string> = { [LEAVE_STAY]: "incident_lead", [TREAT_TRANSPORT]: "duty_doctor" };

// ------------------------------------------------------------------ errors (rules.Rejection)
export interface Rejection {
  code: string;
  reason: string;
  hint: string;
}

export class CityError extends Error {
  constructor(public rejection: Rejection) {
    super(`${rejection.code}: ${rejection.reason}`);
  }
  body() {
    return { ok: false, ...this.rejection };
  }
}

/** A malformed request (Python ValueError -> HTTP 422); not a rule rejection. */
export class CityInvalid extends Error {}

export const notFound = (kind: string, ident: unknown): Rejection => ({
  code: "NOT_FOUND",
  reason: `no ${kind} ${pyStr(ident)}`,
  hint: `airgrid status  # list valid ${kind}s`,
});

const missionExpired = (incident: string): Rejection => ({
  code: "MISSION_EXPIRED",
  reason: `${incident} is closed; no further tasking on it`,
  hint: "airgrid rtb --drone <id>  # open a new incident if there is a new need",
});

// ------------------------------------------------------------------ state
export interface Vehicle {
  id: string;
  kind: string;
  station: string;
  home: number[];
  pos: number[];
  state: string; // parked | en_route | working | returning | transporting | blocked
  incident: string | null;
  path: number[][];
  block: string | null; // incident id of the traffic block a police car is sent to
}

export interface CityEvent {
  seq: number;
  type: string;
  clock: string;
  text: string;
  payload: Json;
}

export interface CityState {
  version: 1;
  eng: EngineState;
  roam: Record<string, { route: number; wp: number }>;
  vehicles: Record<string, Vehicle>;
  active: Record<string, Json>;
  responses: number[];
  count: Record<string, number>;
  handled: number;
  flares: Json[];
  traffic: string[]; // incident ids whose escort block is listed (Python: the block dicts)
  hidden: Json[]; // random fires nobody has found yet: never served keyless (rule 8)
  feed: string[];
  events: CityEvent[];
  fleet: {
    at: number;
    home: number;
    out: number;
    phase: Record<string, string>;
    log: string[];
    log_at: number;
    first: boolean;
  };
  watches: Record<string, Json>;
  grounded: string[];
}

type S = CityState;
const dr = (s: S, id: string | null | undefined): Drone | undefined => (id ? s.eng.drones[id] : undefined);

function blockOf(s: S, iid: string): Json {
  return s.active[iid]?.escort?.block ?? null;
}

// ------------------------------------------------------------------ construction
function checkWorld(): void {
  const zones = ZONES.filter((z) => z.kind !== "no_record");
  const scenes = Object.values<Json[]>(CFG.scenes).flatMap((v) => v.map((x) => x.at));
  const spots = [...scenes, ...Object.values<Json>(CFG.stations).map((x) => x.road)];
  for (const p of spots) {
    if (!ROADS.onRoad(p)) throw new Error(`city spot ${JSON.stringify(p)} is not on a road`);
    if (!zones.every((z) => noFlyOk(p, p, [z]))) throw new Error(`city spot ${JSON.stringify(p)} is inside a zone`);
  }
}

export function newCity(seed?: string | null): S {
  const sd: string = seed || CFG.seed;
  const docked: Record<string, number> = {};
  for (const k of Object.keys(W.fleet)) docked[k] = 100.0;
  const eng = newEngine(sd, tmin(CFG.start), docked);
  const vehicles: Record<string, Vehicle> = {};
  for (const [sid, st] of Object.entries<Json>(CFG.stations)) {
    for (const [vid, kind] of Object.entries<string>(st.vehicles)) {
      vehicles[vid] = {
        id: vid,
        kind,
        station: sid,
        home: [...st.road],
        pos: [...st.road],
        state: "parked",
        incident: null,
        path: [],
        block: null,
      };
    }
  }
  const s: S = {
    version: 1,
    eng,
    roam: {},
    vehicles,
    active: {},
    responses: [],
    count: {},
    handled: 0,
    flares: [],
    traffic: [],
    hidden: [],
    feed: [],
    events: [],
    fleet: { at: eng.now, home: 0, out: 0, phase: {}, log: [], log_at: eng.now, first: true },
    watches: {},
    grounded: [],
  };
  checkWorld();
  start(s);
  return s;
}

function start(s: S): void {
  const bats: number[] = CFG.start_battery;
  if (bats.length !== ROUTES.length) throw new Error("start_battery must match roam routes");
  for (let k = 0; k < ROUTES.length; k++) {
    launchRoamer(s, k);
    const id = Object.keys(s.roam).find((i) => s.roam[i].route === k);
    if (id === undefined) throw new Error("StopIteration: no roamer launched");
    s.eng.drones[id].bat = Number(bats[k]);
  }
  say(s, "city_start", "The city is calm. Drones are out on patrol.");
}

// ------------------------------------------------------------------ talk
function say(s: S, type: string, text: string, inc: Json = null, feed = true, payload: Json = {}): void {
  const eng = s.eng;
  if (inc !== null) {
    payload.incident = inc.id;
    inc.timeline.push({ clock: fmt(eng.now), text });
  }
  const seq = emit(eng);
  if (feed) s.feed = [...s.feed, text].slice(-CFG.feed_lines);
  s.events.push({ seq, type, clock: fmt(eng.now), text, payload });
  const keep = CFG.events_kept;
  if (s.events.length > keep) s.events.splice(0, s.events.length - keep);
}

// ------------------------------------------------------------------ roaming
function nearestWp(route: number, pos: number[]): number {
  const wps = ROUTES[route];
  return minBy([...wps.keys()], (i) => [dist(pos, wps[i]), i])!;
}

function launchRoamer(s: S, route: number): boolean {
  const eng = s.eng;
  const startAt = ROUTES[route][0];
  const gate = MODEL.launch_gate_pct.patrol;
  const cands = readyCandidates(eng, startAt, gate).filter((d) => floorAllows(eng, d));
  const pilot = pilotFor(eng);
  if (!cands.length || pilot === null) return false;
  const d = cands[0];
  launch(eng, d, "roam", null, null, pilot);
  s.roam[d.id] = { route, wp: nearestWp(route, d.pos) };
  return true;
}

function roamMove(s: S, d: Drone): void {
  const r = s.roam[d.id];
  if (!r) throw new Error(`KeyError: ${d.id} not roaming`);
  const wps = ROUTES[r.route];
  const here = wps[r.wp];
  if (d.pos[0] === here[0] && d.pos[1] === here[1]) r.wp = (r.wp + 1) % wps.length;
  const target = wps[r.wp];
  if (fly(d, target, MODEL.cruise_km_per_min)) {
    d.onStation = true;
    r.wp = (r.wp + 1) % wps.length;
  }
}

function toRoam(s: S, d: Drone): void {
  const byRoute = ROUTES.map((_, k) => [Object.values(s.roam).filter((x) => x.route === k).length, k]);
  const route = minBy(byRoute, (x) => x)![1];
  d.mission = "roam";
  d.incident = null;
  d.target = null;
  d.onStation = true;
  s.roam[d.id] = { route, wp: nearestWp(route, d.pos) };
}

function roamPolicy(s: S): void {
  const eng = s.eng;
  const trigger = MODEL.relief_trigger_pct;
  for (const did of Object.keys(s.roam).filter((k) => eng.drones[k].mission !== "roam")) delete s.roam[did];
  for (let k = 0; k < ROUTES.length; k++) {
    const here = Object.entries(s.roam)
      .filter(([, r]) => r.route === k)
      .map(([i]) => eng.drones[i]);
    const low = here.filter((d) => d.bat <= trigger);
    const fit = here.filter((d) => d.bat > trigger);
    const on = fit.filter((d) => d.onStation);
    if (low.length && on.length) {
      for (const d of low) rtb(eng, d, `relieved by ${on[0].id} on route ${k + 1}`);
    } else if (!fit.length && !launchRoamer(s, k)) {
      for (const d of low) {
        if (d.bat <= CFG.home_pct) {
          rtb(eng, d, "low battery, no relief ready");
          fleetAlert(s, d, `patrol route ${k + 1}`);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ triggers
export function trigger(
  s: S,
  kind: string,
  flareOf: string | null = null,
  scene: Json = null,
  foundBy: Json = null,
): Json {
  if (!(kind in CFG.scenes)) throw new CityError(notFound("city trigger", kind));
  const eng = s.eng;
  if (scene === null) {
    const scenes: Json[] = CFG.scenes[kind];
    const busy = new Set(Object.values(s.active).map((i) => i.scene));
    const free = scenes.filter((x) => !busy.has(x.name));
    scene = choice(eng.rng, free.length ? free : scenes);
  }
  const atRisk = random(eng.rng) < CFG.risk_chance[kind];
  const iid = injectAlert(eng, { kind, at: [...scene.at], note: scene.name });
  s.count[kind] = (s.count[kind] ?? 0) + 1;
  const inc: Json = {
    id: iid,
    kind,
    scene: scene.name,
    name: `${scene.name} ${kind}`,
    scene_spec: scene,
    at: [...scene.at],
    t0: eng.now,
    stage: "alert",
    drone: null,
    relief: null,
    needs: [],
    vehicles: [],
    jobs: {},
    at_risk: atRisk,
    injuries: null,
    serial: s.count[kind] ?? 0,
    decision: null,
    hold_until: null,
    care: null,
    escort: null,
    traffic_cars: [],
    timeline: [],
    flare_of: flareOf,
    found_by: foundBy,
  };
  s.active[iid] = inc;
  const what = flareOf ? "Flare-up" : kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
  say(s, "city_alert", `${what} reported at ${scene.name}.`, inc, true, { kind });
  const finder = foundBy && foundBy.drone;
  if (finder && divertTo(s, finder, inc)) inc.drone = finder;
  else inc.drone = assignDrone(s, inc);
  return incidentView(s, inc);
}

function divertTo(s: S, did: string, inc: Json): boolean {
  return divert(s.eng, did, "incident", inc.id, inc.at);
}

// ------------------------------------------------------------------ random fire (L62)
export function randomFire(s: S): Json {
  const eng = s.eng;
  const n = (s.count.random_fire ?? 0) + 1;
  s.count.random_fire = n;
  const rng = seedRng(`${eng.seed}:random_fire:${n}`);
  const spot = choice(rng, fireSpots(s));
  s.hidden.push({ n, at: spot, t: eng.now, drone: null, best: 0, status: "hidden", sent: false });
  return { kind: "random_fire", status: "patrols searching" };
}

function fireSpots(s: S): number[][] {
  const det = CFG.detect;
  const step: number = det.spot_step_km;
  const clear: number = det.clear_km;
  const avoid: number[][] = Object.values<Json>(CFG.stations).map((x) => x.road);
  for (const v of Object.values<Json[]>(CFG.scenes)) for (const x of v) avoid.push(x.at);
  for (const i of Object.values(s.active)) avoid.push(i.at);
  for (const h of s.hidden) avoid.push(h.at);
  const zones = ZONES.map((z) => z.rect);
  const out = new Map<string, number[]>();
  for (const [[x0, y0], [x1, y1]] of ROADS.edges) {
    const k = pyRound(dist([x0, y0], [x1, y1]) / step);
    for (let i = 0; i <= k; i++) {
      const p = [pyRound(x0 + ((x1 - x0) * i) / k, 4), pyRound(y0 + ((y1 - y0) * i) / k, 4)];
      const nearZone = zones.some(
        (r) => r.x[0] - clear <= p[0] && p[0] <= r.x[1] + clear && r.y[0] - clear <= p[1] && p[1] <= r.y[1] + clear,
      );
      if (!nearZone && avoid.every((a) => dist(p, a) >= clear)) out.set(`${p[0]},${p[1]}`, p);
    }
  }
  return sortBy([...out.values()], (p) => [p[0], p[1]]);
}

export function confidence(km: number): number {
  return Math.max(0, Math.min(100, pyRound(100 * (1 - km / CFG.detect.sense_km))));
}

function detect(s: S, t: number): void {
  const det = CFG.detect;
  const eng = s.eng;
  for (const h of [...s.hidden]) {
    let d = h.drone ? eng.drones[h.drone] : undefined;
    if (d !== undefined && d.mission === "investigate" && d.bat <= CFG.home_pct) {
      rtb(eng, d, "low battery, heat reading left to another drone");
    }
    if (d !== undefined && d.mission !== "investigate") {
      h.drone = null;
      h.status = "hidden";
      d = undefined;
    }
    const sensing: [number, string][] = dronesList(eng)
      .filter((x) => x.state === "airborne" && (x.mission === "roam" || x.mission === "investigate") && x.launchWait <= 0)
      .map((x) => [confidence(dist(x.pos, h.at)), x.id]);
    const top = maxBy(sensing, (r) => [r[0], r[1] === h.drone]) ?? [0, null];
    const [best, who] = top as [number, string | null];
    if (d === undefined && best >= det.possible_pct && eng.drones[who!].mission === "roam") {
      investigate(s, h, eng.drones[who!], best);
      continue;
    }
    if (d !== undefined) {
      h.best = confidence(dist(d.pos, h.at));
      if (h.best >= det.confirm_pct) confirm(s, h, d);
      continue;
    }
    if (!h.sent && t - h.t >= det.fallback_min - 1e-9) fallback(s, h);
  }
}

function investigate(s: S, h: Json, d: Drone, pct: number): void {
  delete s.roam[d.id];
  d.mission = "investigate";
  d.onStation = false;
  d.target = null;
  h.drone = d.id;
  h.best = pct;
  h.status = "possible";
  const text = `${d.id} picks up a possible heat source (simulated sensor, ${pct}%) and goes to look.`;
  say(s, "heat_possible", text, null, true, { drone: d.id, confidence_pct: pct, sensor: "simulated" });
}

function fallback(s: S, h: Json): void {
  const gate = MODEL.launch_gate_pct.incident;
  const fit = dronesList(s.eng).filter((d) => d.mission === "roam" && d.bat >= gate);
  if (!fit.length) return;
  const d = minBy(fit, (x) => [dist(x.pos, h.at), x.id])!;
  h.sent = true;
  investigate(s, h, d, confidence(dist(d.pos, h.at)));
}

function investigateMove(s: S, d: Drone): void {
  const h = s.hidden.find((x) => x.drone === d.id);
  if (h === undefined) {
    toRoam(s, d);
    return;
  }
  fly(d, h.at, MODEL.cruise_km_per_min);
}

function allScenes(): Json[] {
  return Object.values<Json[]>(CFG.scenes).flat();
}

/** The nearest named place: the scenes double as the street names. */
export function street(p: number[]): string {
  return minBy(allScenes(), (x) => [dist(p, x.at), x.name])!.name;
}

function confirm(s: S, h: Json, d: Drone): void {
  s.hidden.splice(s.hidden.indexOf(h), 1);
  const st = street(h.at);
  const foundS = pyRound((s.eng.now - h.t) * 60);
  const found = { drone: d.id, how: "patrol sensor (simulated)", found_s: foundS };
  const text = `${d.id} confirms a fire near ${st} (simulated sensor, ${h.best}%).`;
  say(s, "fire_confirmed", text, null, true, { drone: d.id, confidence_pct: h.best });
  trigger(s, "fire", null, { name: st, at: [...h.at] }, found);
}

function detections(s: S): Json[] {
  return s.hidden
    .filter((h) => h.status === "possible")
    .map((h) => ({ drone: h.drone, confidence_pct: h.best, status: h.status }));
}

function assignDrone(s: S, inc: Json, mission = "incident", to: number[] | null = null): string | null {
  const eng = s.eng;
  const aim = [...(to && to.length ? to : inc.at)];
  const gate = MODEL.launch_gate_pct.incident;
  const near = dronesList(eng).filter((d) => d.mission === "roam" && d.bat >= gate);
  for (const d of sortBy(near, (x) => [dist(x.pos, aim), x.id])) {
    if (divert(eng, d.id, mission, inc.id, aim)) {
      delete s.roam[d.id];
      return d.id;
    }
  }
  const pilot = pilotFor(eng) ?? firstHumanRemotePilot(eng);
  for (const d of readyCandidates(eng, aim, gate)) {
    if (pilot && floorAllows(eng, d)) {
      if (launchIncident(eng, d.id, pilot, inc.id, aim)) {
        d.mission = mission;
        return d.id;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ the tick
function cityTick(s: S, t: number): void {
  roamPolicy(s);
  detect(s, t);
  for (const f of s.flares.filter((x) => x.t <= t + 1e-9)) {
    s.flares.splice(s.flares.indexOf(f), 1);
    trigger(s, f.kind, f.of, f.scene);
  }
  for (const inc of Object.values(s.active)) {
    cover(s, inc);
    advance(s, inc, t);
  }
  drive(s, t);
  watchTick(s, t);
  fleetTick(s, t);
}

/** One engine tick (Engine.step in city mode). */
export function tick(s: S): void {
  const eng = s.eng;
  const t = eng.t;
  eng.now = t;
  cityTick(s, t);
  movement(eng, t, {
    roam: (d) => roamMove(s, d),
    investigate: (d) => investigateMove(s, d),
    escort: (d) => escortMove(s, d),
    watch: (d) => watchMove(s, d),
  });
  privacyUpdate(eng, t);
  eng.ticks += 1;
  eng.t = pyRound(t + DT, 4);
}

// ------------------------------------------------------------------ orders (L67)
export function place(word: string): Json {
  const w = word.trim().toLowerCase();
  const byName = new Map<string, Json>();
  for (const x of allScenes()) byName.set(x.name, x);
  const scenes = sortBy([...byName.values()], (x) => [x.name]);
  let hits = scenes.filter((x) => w && (w === x.name.toLowerCase() || x.name.toLowerCase().includes(w)));
  const exact = hits.filter((x) => x.name.toLowerCase() === w);
  hits = exact.length ? exact : hits;
  if (hits.length !== 1) {
    const names = (hits.length ? hits : scenes).map((x) => x.name).join(", ");
    throw new CityError({ code: "NOT_FOUND", reason: `no single place matches '${word}'`, hint: `one of: ${names}` });
  }
  return hits[0];
}

export function order(s: S, kind: string, placeWord = "", drone = "", minutes: number | null = null): Json {
  if (kind === "watch") return watch(s, place(placeWord), minutes);
  if (kind === "unwatch") return unwatch(s, place(placeWord).name);
  if (kind === "dock" || kind === "release") {
    const d = s.eng.drones[drone.toUpperCase()];
    if (d === undefined) throw new CityError(notFound("drone", drone));
    return kind === "dock" ? dock(s, d) : release(s, d);
  }
  throw new CityError(notFound("order", kind));
}

function watchDrone(s: S, at: number[]): string | null {
  const eng = s.eng;
  const gate = MODEL.relief_trigger_pct + 10;
  const near = dronesList(eng).filter((d) => d.mission === "roam" && d.bat >= gate && !s.grounded.includes(d.id));
  if (near.length) {
    const d = minBy(near, (x) => [dist(x.pos, at), x.id])!;
    delete s.roam[d.id];
    d.mission = "watch";
    d.incident = null;
    d.target = null;
    d.onStation = false;
    return d.id;
  }
  const pilot = pilotFor(eng);
  for (const d of readyCandidates(eng, at, MODEL.launch_gate_pct.patrol)) {
    if (pilot && floorAllows(eng, d)) {
      launch(eng, d, "watch", null, null, pilot);
      return d.id;
    }
  }
  return null;
}

const hhmm = (t: number) => fmt(t % 1440).slice(0, 5);

function watch(s: S, scene: Json, minutes: number | null): Json {
  const eng = s.eng;
  const name: string = scene.name;
  let mins = minutes ? Number(minutes) : Number(CFG.watch_min);
  mins = Math.max(5.0, Math.min(mins, Number(CFG.watch_max_min)));
  let w = s.watches[name];
  if (w === undefined) {
    const did = watchDrone(s, scene.at);
    if (did === null) {
      const keep = W.policies.ready_floor;
      throw new CityError({
        code: "DRONE_NOT_READY",
        reason:
          `no spare drone to watch ${name}: every patrol drone is low or busy, ` +
          `and ${keep} stay ready for emergencies`,
        hint: "try again in a few minutes",
      });
    }
    w = { place: name, at: [...scene.at], drone: did, k: 0 };
    s.watches[name] = w;
  }
  w.until = eng.now + mins;
  const until = hhmm(w.until);
  const text = `${w.drone} watches ${name} until ${until} (no recording: not an incident).`;
  say(s, "city_order", text, null, false, { order: "watch", place: name, drone: w.drone });
  return { order: "watch", place: name, drone: w.drone, until, text };
}

function unwatch(s: S, name: string, why = "stopped by the operator"): Json {
  const w = s.watches[name];
  if (w === undefined) throw new CityError(notFound("watch", name));
  delete s.watches[name];
  const d = dr(s, w.drone);
  let back = "";
  if (d !== undefined && d.mission === "watch") {
    toRoam(s, d);
    back = ` ${w.drone} back on patrol.`;
  }
  const text = `Watch over ${name} ended: ${why}.${back}`;
  say(s, "city_order", text, null, false, { order: "unwatch", place: name, drone: w.drone });
  return { order: "unwatch", place: name, drone: w.drone, text };
}

function watchMove(s: S, d: Drone): void {
  const w = Object.values(s.watches).find((x) => x.drone === d.id);
  if (w === undefined) {
    toRoam(s, d);
    return;
  }
  const r: number = CFG.watch_km;
  const [x, y] = w.at;
  let ring = [
    [x + r, y],
    [x, y + r],
    [x - r, y],
    [x, y - r],
  ];
  const zones = ZONES.filter((z) => z.kind !== "no_record");
  ring = ring.filter((p) => noFlyOk(d.pos, p, zones));
  if (!ring.length) ring = [w.at];
  if (fly(d, ring[w.k % ring.length], MODEL.cruise_km_per_min)) {
    d.onStation = true;
    w.k += 1;
  }
}

function watchTick(s: S, t: number): void {
  const eng = s.eng;
  for (const [name, w] of Object.entries(s.watches)) {
    const d = dr(s, w.drone);
    if (t >= w.until - 1e-9) unwatch(s, name, "time is up");
    else if (d === undefined || d.mission !== "watch") replaceWatcher(s, name, w, null);
    else if (d.bat <= MODEL.relief_trigger_pct) replaceWatcher(s, name, w, d);
    void eng;
  }
}

function replaceWatcher(s: S, name: string, w: Json, tired: Drone | null): void {
  const eng = s.eng;
  if (tired !== null) {
    tired.mission = "roam";
    rtb(eng, tired, `low battery, watch over ${name} handed on`);
  }
  const did = watchDrone(s, w.at);
  if (did === null) {
    delete s.watches[name];
    const text = `Watch over ${name} ended early: no spare drone to take over.`;
    say(s, "fleet_alert", text, null, false, { place: name });
    return;
  }
  const old = w.drone;
  w.drone = did;
  const text = `${did} takes over the watch on ${name} from ${old}.`;
  say(s, "city_order", text, null, false, { order: "watch", place: name, drone: did });
}

function dock(s: S, d: Drone): Json {
  const eng = s.eng;
  if (s.grounded.includes(d.id)) {
    throw new CityError({ code: "DRONE_NOT_READY", reason: `${d.id} is already grounded`, hint: `release ${d.id}` });
  }
  if (d.mission === "incident" || d.mission === "escort" || d.mission === "investigate") {
    const job: Record<string, string> = {
      escort: "escorting an ambulance",
      investigate: "checking a heat reading",
    };
    throw new CityError({
      code: "DRONE_NOT_READY",
      reason: `${d.id} is ${job[d.mission] ?? "at an incident"}; it stays until that's done`,
      hint: "dock it after the incident, or pick another drone",
    });
  }
  for (const [name, w] of Object.entries(s.watches)) {
    if (w.drone === d.id) unwatch(s, name, `${d.id} docked by the operator`);
  }
  s.grounded.push(d.id);
  d.outOfService = true;
  if (d.state === "airborne") {
    delete s.roam[d.id];
    d.mission = "roam";
    rtb(eng, d, "docked by the operator");
  }
  const where = d.state === "airborne" ? `heads to dock ${pyStr(d.target)}` : `stays at ${pyStr(d.slot)}`;
  const text = `${d.id} ${where} and is grounded until released (${pyFixed(d.bat, 0)}%).`;
  say(s, "city_order", text, null, false, { order: "dock", drone: d.id });
  return { order: "dock", drone: d.id, text };
}

function release(s: S, d: Drone): Json {
  if (!s.grounded.includes(d.id)) {
    throw new CityError({ code: "DRONE_NOT_READY", reason: `${d.id} isn't grounded`, hint: `dock ${d.id}` });
  }
  s.grounded = s.grounded.filter((x) => x !== d.id);
  d.outOfService = false;
  const text = `${d.id} released: it flies again once charged (${pyFixed(d.bat, 0)}%).`;
  say(s, "city_order", text, null, false, { order: "release", drone: d.id });
  return { order: "release", drone: d.id, text };
}

function watchesView(s: S): Json[] {
  return Object.values(s.watches).map((w) => ({ place: w.place, at: w.at, drone: w.drone, until: hhmm(w.until) }));
}

// ------------------------------------------------------------------ #fleet (L64)
const PHASE: Record<string, string> = {
  "On patrol": "patrol",
  "Checking a heat reading": "patrol",
  "Heading to dock": "home",
};

function phaseOf(s: S, d: Drone): string {
  if (s.grounded.includes(d.id)) return "grounded";
  if (d.mission === "watch") return "watch";
  const lbl = label(s, d);
  const m: Record<string, string> = { Charging: "charging", Ready: "ready" };
  return m[lbl] || PHASE[lbl] || "incident";
}

function change(s: S, d: Drone, was: string, now: string): string {
  const b = `${pyFixed(d.bat, 0)}%`;
  if (now === "grounded") return `${d.id} grounded by the operator (${b})`;
  if (was === "grounded") return `${d.id} released by the operator (${b})`;
  if (now === "watch") return `${d.id} ${label(s, d).toLowerCase()} (${b})`;
  if (now === "home") return `${d.id} heads to dock ${pyStr(d.target)} (${b})`;
  if (now === "charging") return `${d.id} lands at ${pyStr(d.slot)} and charges (${b})`;
  if (now === "ready") return `${d.id} charged at ${pyStr(d.slot)}, ready (${b})`;
  const lbl = label(s, d);
  const what = lbl.charAt(0).toLowerCase() + lbl.slice(1);
  if (was === "charging" || was === "ready") {
    const goal =
      now === "patrol"
        ? "for patrol"
        : d.incident !== null && d.incident in s.active
          ? `for ${s.active[d.incident].scene}`
          : "on a job";
    return `${d.id} takes off ${goal} (${b})`;
  }
  if (now === "patrol" && was === "incident") return `${d.id} back on patrol (${b})`;
  return `${d.id} ${what} (${b})`;
}

function fleetAlert(s: S, d: Drone, where: string): void {
  const keep = W.policies.ready_floor;
  const text =
    `${d.id} heads to a dock at ${pyFixed(d.bat, 0)}% from ${where}. No spare drone to relieve it: ` +
    `${keep} stay ready for emergencies.`;
  say(s, "fleet_alert", text, null, false, { drone: d.id, battery: pyRound(d.bat, 1) });
}

function fleetTick(s: S, t: number): void {
  const f = s.fleet;
  const eng = s.eng;
  for (const d of dronesList(eng)) {
    const now = phaseOf(s, d);
    const was: string | undefined = f.phase[d.id];
    if ((was === "charging" || was === "ready") && now !== "charging" && now !== "ready") f.out += 1;
    if (![undefined, "home", "charging", "ready"].includes(was) && (now === "home" || now === "charging")) f.home += 1;
    if (was !== undefined && now !== was) f.log.push(`${hhmm(t)} ${change(s, d, was, now)}`);
    f.phase[d.id] = now;
  }
  // the live log (L66): every change, gathered into one post every fleet_log_min
  if (f.log.length && t - f.log_at >= CFG.fleet_log_min - 1e-9) {
    const rows = f.log;
    f.log = [];
    f.log_at = t;
    say(s, "fleet_log", rows.join(NL), null, false, { changes: rows.length });
  } else if (!f.log.length) f.log_at = t;
  if (t - f.at < CFG.fleet_board_min - 1e-9 && !f.first) return;
  f.first = false;
  const n: Record<string, number> = { patrol: 0, watch: 0, incident: 0, home: 0, charging: 0, ready: 0, grounded: 0 };
  for (const p of Object.values(f.phase)) n[p] += 1;
  const air = n.patrol + n.watch + n.incident + n.home;
  const low = minBy(
    dronesList(eng).filter((d) => d.state === "airborne"),
    (d) => [d.bat, d.id],
  );
  const bare: number[] = [];
  for (let k = 0; k < ROUTES.length; k++) {
    const covered = Object.entries(s.roam).some(([i, r]) => r.route === k && eng.drones[i].mission === "roam");
    if (!covered) bare.push(k + 1);
  }
  const doing = [`${n.patrol} on patrol`];
  if (n.watch) doing.push(`${n.watch} watching an area`);
  if (n.incident) doing.push(`${n.incident} at incidents`);
  if (n.home) doing.push(`${n.home} heading to a dock`);
  const held = n.ready <= W.policies.ready_floor ? " (kept for emergencies)" : "";
  let text = `${air} in the air (${doing.join(", ")}) · ${n.charging} charging · ` + `${n.ready} ready${held}.`;
  if (n.grounded) text += ` ${n.grounded} grounded by the operator.`;
  if (t > f.at + 1e-9) {
    const since = hhmm(f.at);
    text += ` Since ${since}: ${f.home} went to charge, ${f.out} took off.`;
  }
  if (low !== undefined) text += ` Lowest in the air: ${low.id} ${pyFixed(low.bat, 0)}%.`;
  if (bare.length) text += ` Patrol routes without a drone: ${bare.join(", ")}.`;
  say(s, "fleet_board", text, null, false, {
    ...n,
    went_home: f.home,
    took_off: f.out,
    uncovered: bare,
  });
  f.at = t;
  f.home = 0;
  f.out = 0;
}

// ------------------------------------------------------------------ incidents
function cover(s: S, inc: Json): void {
  const eng = s.eng;
  for (const key of ["drone", "relief"]) {
    const d = dr(s, inc[key]);
    if (d !== undefined && (d.mission !== "incident" || d.incident !== inc.id)) inc[key] = null;
  }
  if (inc.drone === null && inc.relief) {
    inc.drone = inc.relief;
    inc.relief = null;
  }
  if (inc.drone === null) {
    inc.drone = assignDrone(s, inc);
    return;
  }
  const d = eng.drones[inc.drone];
  if (inc.relief === null && d.bat <= MODEL.relief_trigger_pct) {
    inc.relief = assignDrone(s, inc);
    if (inc.relief) say(s, "city_relief", `${inc.relief} is coming to relieve ${d.id}.`, inc);
  }
  if (inc.relief === null && d.bat <= CFG.home_pct) {
    rtb(eng, d, "low battery, no relief ready");
    say(s, "city_relief", `${d.id} is low and heads home. Nobody could relieve it.`, inc);
    inc.drone = null;
    return;
  }
  const relief = dr(s, inc.relief);
  if (relief !== undefined && relief.onStation) {
    inc.drone = relief.id;
    inc.relief = null;
    rtb(eng, d, "relieved at the scene");
    say(s, "city_relief", `${relief.id} is on station. ${d.id} heads home.`, inc);
  }
}

const WORK_STAGES = new Set(["responding", "working", "care_call", "transporting", "blocked"]);

function advance(s: S, inc: Json, t: number): void {
  const stage = inc.stage;
  if (stage === "alert" && inc.id in s.eng.eyesOn) eyesOn(s, inc);
  else if (WORK_STAGES.has(stage)) {
    assess(s, inc);
    sendVehicles(s, inc);
    care(s, inc);
    work(s, inc, t);
    if (inc.escort) escortTick(s, inc, t);
  }
  // "watching" has no deadline: the drone keeps watching until the lead answers (L60)
  else if (stage === "holding" && t >= inc.hold_until - 1e-9) {
    inc.at_risk = false;
    ask(s, inc, "Clear reading now.");
  }
}

function eyesOn(s: S, inc: Json): void {
  const secs = (s.eng.eyesOn[inc.id] - inc.t0) * 60;
  inc.response_s = secs;
  if (!inc.found_by) s.responses.push(secs);
  inc.needs = [...CFG.services[inc.kind]];
  inc.stage = "responding";
  const [x, y] = inc.at;
  const text = `${pyStr(inc.drone)} is over ${inc.scene} at (${pyG(x)}, ${pyG(y)}).`;
  say(s, "city_eyes_on", text, inc, true, { drone: inc.drone, response_s: pyRound(secs) });
}

/** Seeded per incident kind and number, so other triggers can't change the outcome. */
export function rollInjuries(seed: string, kind: string, serial: number): number {
  const rng = seedRng(`${seed}:${kind}:${serial}`);
  if (random(rng) >= CFG.injury_chance[kind]) return 0;
  return randint(rng, 1, CFG.injuries_max);
}

function assess(s: S, inc: Json): void {
  const d = dr(s, inc.drone);
  if (inc.injuries !== null || !Object.keys(inc.jobs).length || d === undefined || !d.onStation) return;
  const n = (inc.injuries = rollInjuries(s.eng.seed, inc.kind, inc.serial));
  if (n) {
    inc.needs.push(...CFG.services.injuries);
    const text = `${n} injured at ${inc.scene}. Ambulance requested from the Hospital.`;
    say(s, "ambulance_requested", text, inc, true, { injuries: n });
  } else {
    const text = `Nobody hurt at ${inc.scene}. No ambulance needed.`;
    say(s, "ambulance_not_needed", text, inc, true, { injuries: 0 });
  }
}

function ambulance(s: S, inc: Json): string | null {
  return inc.vehicles.find((v: string) => s.vehicles[v].kind === "ambulance") ?? null;
}

function care(s: S, inc: Json): void {
  const amb = ambulance(s, inc);
  if (inc.kind !== "accident" || inc.care || amb === null || !(amb in inc.jobs)) return;
  const rng = seedRng(`${s.eng.seed}:care:${inc.serial}`);
  const go = random(rng) < CFG.transport_chance;
  const n = inc.injuries;
  const facts = go
    ? `${pyStr(n)} injured, condition needs the Hospital. Recommend transport.`
    : `${pyStr(n)} injured, stable and walking. Recommend treating on scene.`;
  inc.care = { recommend: go ? "transport" : "treat", choice: null };
  say(s, "care_assessed", facts, inc, true, { recommend: inc.care.recommend, injuries: n });
  inc.stage = "care_call";
  call(s, inc, TREAT_TRANSPORT, facts, `Duty Doctor, ${inc.scene}: ${facts}`);
}

function sendVehicles(s: S, inc: Json): void {
  for (const kind of [...inc.needs] as string[]) {
    const free = Object.values(s.vehicles).filter((v) => v.kind === kind && v.state === "parked");
    if (!free.length) continue; // waits for one to come home
    const v = minBy(free, (x) => [dist(x.pos, inc.at), x.id])!;
    inc.needs.splice(inc.needs.indexOf(kind), 1);
    v.state = "en_route";
    v.incident = inc.id;
    v.path = ROADS.route(v.pos, inc.at);
    inc.vehicles.push(v.id);
    const legs = [v.pos, ...v.path];
    const km = pySum(v.path.map((b, i) => dist(legs[i], b)));
    const eta = km / SPEED;
    const name = CFG.stations[v.station].name;
    say(s, "city_dispatch", `${name} sends ${v.id.replaceAll("_", " ")} to ${inc.scene}.`, inc, true, {
      vehicle: v.id,
      kind,
      station: v.station,
      eta_min: pyRound(eta, 1),
    });
  }
}

function work(s: S, inc: Json, t: number): void {
  for (const vid of inc.vehicles as string[]) {
    const v = s.vehicles[vid];
    const job = inc.jobs[vid];
    if (vid === ambulance(s, inc) && inc.care && !inc.care.choice) continue; // the call stays open
    if (v.state === "working" && job && t - job.start >= job.min - 1e-9) {
      job.done = true;
      if (vid === ambulance(s, inc) && (inc.care || {}).choice === "transport") {
        startTransport(s, inc, v, t);
        continue;
      }
      v.state = "returning";
      v.incident = null;
      v.path = ROADS.route(v.pos, v.home);
      const text = `${job.label} done. ${v.id.replaceAll("_", " ")} heads back.`;
      say(s, "city_work_done", text, inc, true, { vehicle: vid });
    }
  }
  const jobs = Object.values<Json>(inc.jobs);
  const allArrived = !inc.needs.length && jobs.length === inc.vehicles.length;
  const assessed = inc.injuries !== null;
  const moving = inc.escort && inc.escort.status !== "delivered";
  if (assessed && allArrived && jobs.every((j) => j.done) && !moving) {
    inc.stage = "watching";
    ask(s, inc, !inc.at_risk ? "Looks clear." : "Mostly clear, keep an eye.");
  } else if (jobs.length && inc.stage === "responding") inc.stage = "working";
}

function call(s: S, inc: Json, kind: string, reading: string, text: string): void {
  const deadline = s.eng.now + CFG.decision_timeout_min;
  inc.decision = { kind, reading, deadline };
  say(s, "city_decision", text, inc, true, { drone: inc.drone, at_risk: inc.at_risk, kind, role: ROLES[kind] });
}

function ask(s: S, inc: Json, reading: string): void {
  inc.stage = "watching";
  const text = `${reading} ${pyStr(inc.drone)} at ${inc.scene}: leave, or stay a little longer?`;
  call(s, inc, LEAVE_STAY, reading, text);
}

// ------------------------------------------------------------------ ambulance escort (L61)
function startTransport(s: S, inc: Json, v: Vehicle, t: number): void {
  v.state = "transporting";
  v.path = ROADS.route(v.pos, v.home);
  inc.stage = "transporting";
  const e: Json = {
    ambulance: v.id,
    drone: null,
    relief: null,
    status: "en_route",
    block: null,
    t_start: t,
    t_stop: null,
    t_end: null,
    delay_min: 0.0,
  };
  inc.escort = e;
  const rng = seedRng(`${s.eng.seed}:traffic:${inc.serial}`);
  const blocked = random(rng) < CFG.traffic_chance;
  const onRoute = v.path.slice(1, -1); // every stop between the two ends is a junction
  if (blocked && onRoute.length) {
    e.block = {
      at: [...choice(rng, onRoute)],
      status: "pending", // not served: nobody has seen it yet
      incident: inc.id,
      start: null,
      car: null,
      requested: false,
    };
    s.traffic.push(inc.id);
  }
  escortCover(s, inc, e); // the escort drone is named on the first line (L65)
  say(s, "transport_started", `Ambulance leaves ${inc.scene} for the Hospital.`, inc, true, { drone: e.drone });
}

/** The point escort_lead_km ahead of the vehicle along its road route. */
function ahead(v: Vehicle): number[] {
  let pos = [...v.pos];
  let left: number = CFG.escort_lead_km;
  for (const p of v.path) {
    const step = dist(pos, p);
    if (step >= left && step > 0) {
      const f = left / step;
      return [pos[0] + (p[0] - pos[0]) * f, pos[1] + (p[1] - pos[1]) * f];
    }
    pos = [...p];
    left = left - step;
  }
  return pos;
}

function escortMove(s: S, d: Drone): void {
  const inc = d.incident !== null ? s.active[d.incident] : undefined;
  const e = inc ? inc.escort : null;
  if (!e || e.status === "delivered") {
    toRoam(s, d);
    return;
  }
  const target = ahead(s.vehicles[e.ambulance]);
  fly(d, target, MODEL.cruise_km_per_min);
}

function escortCover(s: S, inc: Json, e: Json): void {
  const eng = s.eng;
  for (const key of ["drone", "relief"]) {
    const d = dr(s, e[key]);
    if (d !== undefined && d.mission !== "escort") e[key] = null;
  }
  if (e.drone === null && e.relief) {
    e.drone = e.relief;
    e.relief = null;
  }
  const aim = ahead(s.vehicles[e.ambulance]);
  if (e.drone === null) {
    e.drone = assignDrone(s, inc, "escort", aim);
    return;
  }
  const d = eng.drones[e.drone];
  if (e.relief === null && d.bat <= MODEL.relief_trigger_pct) e.relief = assignDrone(s, inc, "escort", aim);
  const relief = dr(s, e.relief);
  if (relief !== undefined && dist(relief.pos, d.pos) <= CFG.escort_handoff_km) {
    e.drone = relief.id;
    e.relief = null;
    rtb(eng, d, "relieved on the escort");
  } else if (relief === undefined && d.bat <= CFG.home_pct) {
    rtb(eng, d, "low battery, no relief ready");
    e.drone = null;
  }
}

function escortTick(s: S, inc: Json, t: number): void {
  const e = inc.escort;
  if (e.status === "delivered") return;
  escortCover(s, inc, e);
  const b = e.block;
  if (b === null || b.status === "cleared") return;
  const amb = s.vehicles[e.ambulance];
  const d = dr(s, e.drone);
  const close = dist(amb.pos, b.at) <= CFG.traffic_stop_km;
  if (b.status === "pending" && (close || (d !== undefined && dist(d.pos, b.at) <= CFG.traffic_sight_km))) {
    b.status = "blocked";
    const [x, y] = b.at;
    say(
      s,
      "traffic_blocked",
      `Traffic is blocking the junction at (${pyG(x)}, ${pyG(y)}) on the way to the Hospital.`,
      inc,
      true,
      { at: b.at, drone: e.drone },
    );
  }
  if ((b.status === "blocked" || b.status === "clearing") && close && amb.state === "transporting") {
    amb.state = "blocked";
    e.status = "blocked";
    e.t_stop = t;
    inc.stage = "blocked";
  }
  if (b.status === "blocked" && b.car === null) sendPolice(s, inc, b);
  if (b.status === "clearing" && t - b.start >= CFG.traffic_clear_min - 1e-9) cleared(s, inc, e, b, t);
}

function sendPolice(s: S, inc: Json, b: Json): void {
  if (!b.requested) {
    b.requested = true;
    say(s, "police_requested", "Police asked to clear the junction.", inc, true, {
      at: b.at,
      drone: inc.escort.drone,
    });
  }
  const free = Object.values(s.vehicles).filter((v) => v.kind === "police_car" && v.state === "parked");
  if (!free.length) return; // waits for a car to come home
  const car = minBy(free, (x) => [dist(x.pos, b.at), x.id])!;
  car.state = "en_route";
  car.incident = inc.id;
  car.block = b.incident;
  car.path = ROADS.route(car.pos, b.at);
  b.car = car.id;
  inc.traffic_cars.push(car.id);
}

function cleared(s: S, inc: Json, e: Json, b: Json, t: number): void {
  b.status = "cleared";
  const car = s.vehicles[b.car];
  car.state = "returning";
  car.incident = null;
  car.block = null;
  car.path = ROADS.route(car.pos, car.home);
  const amb = s.vehicles[e.ambulance];
  if (amb.state === "blocked") {
    amb.state = "transporting";
    e.delay_min += t - e.t_stop;
  }
  e.status = "en_route";
  e.t_stop = null;
  inc.stage = "transporting";
  say(s, "traffic_cleared", "Junction clear. The ambulance moves on.", inc, true, { at: b.at });
}

function delivered(s: S, inc: Json, v: Vehicle, t: number): void {
  const e = inc.escort;
  v.state = "parked";
  v.incident = null;
  e.status = "delivered";
  e.t_end = t;
  inc.stage = "working";
  for (const key of ["drone", "relief"]) {
    const d = dr(s, e[key]);
    if (d !== undefined && d.mission === "escort") toRoam(s, d);
  }
  say(s, "patient_delivered", "Patient handed over at the Hospital.", inc);
}

/** Vehicle.drive: along the path; true on arrival. */
function driveVehicle(v: Vehicle, km: number): boolean {
  while (v.path.length && km > 0) {
    const step = dist(v.pos, v.path[0]);
    if (step <= km) {
      v.pos = v.path.shift()!;
      km -= step;
      continue;
    }
    const f = km / step;
    v.pos = [v.pos[0] + (v.path[0][0] - v.pos[0]) * f, v.pos[1] + (v.path[0][1] - v.pos[1]) * f];
    return false;
  }
  return !v.path.length;
}

function drive(s: S, t: number): void {
  const km = SPEED * DT;
  for (const v of Object.values(s.vehicles)) {
    if (!["en_route", "returning", "transporting"].includes(v.state) || !driveVehicle(v, km)) continue;
    if (v.state === "returning") {
      v.state = "parked";
      continue;
    }
    const inc = s.active[v.incident!];
    if (inc === undefined) throw new Error(`KeyError: ${v.incident}`);
    if (v.state === "transporting") {
      delivered(s, inc, v, t);
      continue;
    }
    v.state = "working";
    if (v.block !== null) {
      // a police car at the blocked junction
      const b = blockOf(s, v.block);
      b.status = "clearing";
      b.start = t;
      continue;
    }
    const spec = CFG.work_min[v.kind];
    inc.jobs[v.id] = { label: spec.label, min: spec.min, start: t, done: false };
    const name = v.id.replaceAll("_", " ");
    say(s, "city_on_scene", `${name} is on scene: ${spec.label}.`, inc, true, { vehicle: v.id });
  }
}

// ------------------------------------------------------------------ the human decision
export function find(s: S, placeWord: string): Json {
  const frag = placeWord.trim().toLowerCase();
  const hits = Object.values(s.active).filter((i) => frag && i.name.toLowerCase().includes(frag));
  const waiting = hits.filter((i) => i.decision);
  for (const group of [waiting, hits]) if (group.length === 1) return group[0];
  return null;
}

function pyList(xs: string[]): string {
  return "[" + xs.map((x) => `'${x}'`).join(", ") + "]";
}

export function decide(s: S, iid: string | null, choiceWord: string, placeWord: string | null = null): Json {
  const inc = iid ? s.active[iid] ?? null : find(s, placeWord || "");
  if (inc === null) throw new CityError(notFound("open incident", iid || placeWord));
  const id = inc.id;
  if (inc.decision === null) throw new CityError(missionExpired(`the decision on ${id}`));
  const kind = inc.decision.kind;
  if (!(choiceWord in CHOICES[kind])) {
    throw new CityInvalid(`choice must be one of ${pyList(Object.keys(CHOICES[kind]).sort())}`);
  }
  const what = CHOICES[kind][choiceWord];
  if (kind === TREAT_TRANSPORT) {
    careChoice(s, inc, what);
    return { incident: id, stage: inc.stage };
  }
  if (what === "stay") {
    stay(s, inc);
    return { incident: id, stage: inc.stage };
  }
  return leave(s, inc);
}

function careChoice(s: S, inc: Json, what: string): void {
  inc.decision = null;
  inc.care.choice = what;
  inc.stage = "working";
  const job = inc.jobs[ambulance(s, inc)!];
  if (what === "transport") {
    job.label = "Stabilising patient";
    job.min = CFG.stabilise_min;
  }
}

function stay(s: S, inc: Json, timedOut = false): void {
  inc.decision = null;
  inc.stage = "holding";
  inc.hold_until = s.eng.now + CFG.stay_min;
  const why = timedOut ? "No answer, so the drone stays" : "The drone stays";
  say(s, "city_stay", `${why} at ${inc.scene} a little longer.`, inc);
}

function leave(s: S, inc: Json): Json {
  const eng = s.eng;
  const iid = inc.id;
  closeIncident(eng, iid);
  for (const key of ["drone", "relief"]) if (inc[key]) toRoam(s, eng.drones[inc[key]]);
  delete s.active[iid];
  s.traffic = s.traffic.filter((x) => x !== iid);
  s.handled += 1;
  const rep = report(s, inc);
  if (inc.at_risk && random(eng.rng) < CFG.flare_chance) {
    s.flares.push({ t: eng.now + CFG.flare_delay_min, kind: inc.kind, of: iid, scene: inc.scene_spec });
  }
  return { incident: iid, stage: "closed", report: rep };
}

function transportReport(inc: Json): Json {
  const e = inc.escort;
  if (e === null) return null;
  const blocked = e.block !== null && e.block.status === "cleared";
  const natural = CFG.traffic_natural_clear_min;
  return {
    transport_min: pyRound(e.t_end - e.t_start, 1),
    delay_min: pyRound(e.delay_min, 1),
    saved_min: blocked ? pyRound(Math.max(0.0, natural - e.delay_min), 1) : 0.0,
  };
}

function report(s: S, inc: Json): Json {
  const eng = s.eng;
  const on = eng.recFirst[inc.id] ?? null;
  delete eng.recFirst[inc.id];
  const rep: Json = {
    incident: inc.id,
    kind: inc.kind,
    name: inc.name,
    scene: inc.scene,
    injuries: inc.injuries,
    response_s: pyRound(inc.response_s ?? 0),
    who: [...inc.vehicles, ...inc.traffic_cars],
    care: (inc.care || {}).choice ?? null,
    transport: transportReport(inc),
    recording: { from: on, to: on ? fmt(eng.now) : null },
    timeline: inc.timeline.map((x: Json) => ({ ...x })),
  };
  const found = inc.found_by;
  let text: string;
  if (found) {
    rep.found_s = found.found_s;
    text = `${inc.scene} is closed. Found on patrol in ${found.found_s} s.`;
  } else text = `${inc.scene} is closed. First eyes on in ${rep.response_s} s.`;
  say(s, "city_report", text, inc, true, { report: rep });
  return rep;
}

// ------------------------------------------------------------------ views
function label(s: S, d: Drone): string {
  if (s.grounded.includes(d.id)) {
    return d.state === "docked" ? "Grounded by operator" : "Heading to dock, then grounded";
  }
  if (d.mission === "watch") {
    const w = Object.values(s.watches).find((x) => x.drone === d.id);
    return w ? `Watching ${w.place}` : "Watching";
  }
  if (d.state === "docked") return d.bat >= MODEL.ready_pct ? "Ready" : "Charging";
  if (d.mission === "roam") return "On patrol";
  if (d.mission === "escort") return "Escorting ambulance";
  if (d.mission === "investigate") return "Checking a heat reading";
  if (d.mission === "returning") return "Heading to dock";
  const inc = d.incident !== null ? s.active[d.incident] : undefined;
  if (inc === undefined) return "Flying";
  return d.onStation ? `Watching ${inc.scene}` : `Heading to ${inc.scene}`;
}

export function incidentView(s: S, inc: Json): Json {
  const jobs = Object.values<Json>(inc.jobs);
  let pct = 0;
  let lbl: string | null = null;
  if (jobs.length) {
    const now = s.eng.now;
    const rows: [number, string][] = jobs.map((j) => [Math.min(1.0, (now - j.start) / j.min), j.label]);
    for (const vid of inc.vehicles as string[]) {
      if (!(vid in inc.jobs)) rows.push([0.0, CFG.work_min[s.vehicles[vid].kind].label]);
    }
    const [share, name] = minBy(rows, (r) => r)!;
    pct = Math.trunc(share * 100);
    lbl = `${name} ${pct}%`;
  }
  const out: Json = {
    id: inc.id,
    kind: inc.kind,
    name: inc.name,
    scene: inc.scene,
    at: inc.at,
    stage: inc.stage,
    progress_pct: pct,
    progress_label: lbl,
    drone: inc.drone,
    vehicles: [...inc.vehicles, ...inc.traffic_cars],
  };
  if (inc.decision) {
    const kind = inc.decision.kind;
    const left = (inc.decision.deadline - s.eng.now) / CFG.sim_min_per_s;
    const askTxt = kind === LEAVE_STAY ? " Leave, or stay a little longer?" : "";
    out.decision = {
      kind,
      role: ROLES[kind],
      prompt: `${inc.decision.reading}${askTxt}`,
      options: OPTIONS[kind],
      remaining_s: pyRound(Math.max(0.0, left), 1),
    };
  }
  if (inc.escort) out.escort = escortView(s, inc.escort);
  if (inc.found_by) out.found_by = { ...inc.found_by };
  return out;
}

function escortView(s: S, e: Json): Json {
  const b = e.block;
  const seen = b !== null && b.status !== "pending";
  let delay = e.delay_min;
  if (e.t_stop !== null) delay += s.eng.now - e.t_stop;
  return {
    ambulance: e.ambulance,
    drone: e.drone,
    status: e.status,
    blocked_at: seen ? b.at : null,
    delay_s: pyRound(delay * 60),
  };
}

function trafficView(s: S, b: Json): Json {
  let pct = b.status === "cleared" ? 100 : 0;
  if (b.status === "clearing") pct = Math.trunc(Math.min(1.0, (s.eng.now - b.start) / CFG.traffic_clear_min) * 100);
  return { at: b.at, status: b.status, progress_pct: pct };
}

/** Fires burning that no drone has confirmed yet. Operator screen only (L63). */
function unfound(s: S): Json[] {
  return s.hidden.map((h) => ({ id: `unfound-${h.n}`, at: [...h.at], since_s: pyRound((s.eng.now - h.t) * 60) }));
}

export function stationsView(): Json[] {
  return Object.entries<Json>(CFG.stations).map(([k, x]) => ({ id: k, name: x.name, kind: k, at: x.at, road: x.road }));
}

export function cityView(s: S, since = 0, operator = false): Json {
  const eng = s.eng;
  const minute = eng.now % 1440;
  const n = s.responses.length;
  const out: Json = {
    started: true,
    clock_label: `${CFG.day} ${fmt(minute).slice(0, 5)}`,
    counters: {
      handled: s.handled,
      avg_response_s: n ? pyRound(pySum(s.responses) / n) : null,
      drones_up: dronesList(eng).filter((d) => d.state === "airborne").length,
    },
    drones: dronesList(eng).map((d) => ({
      id: d.id,
      pos: d.pos.map((v) => pyRound(v, 3)),
      battery: pyRound(d.bat, 1),
      state: d.state,
      label: label(s, d),
      recording: d.recording,
    })),
    vehicles: Object.values(s.vehicles).map((v) => ({
      id: v.id,
      kind: v.kind,
      pos: v.pos.map((x) => pyRound(x, 3)),
      state: v.state,
      incident: v.incident,
    })),
    stations: stationsView(),
    incidents: Object.values(s.active).map((i) => incidentView(s, i)),
    traffic: s.traffic
      .map((iid) => blockOf(s, iid))
      .filter((b) => b !== null && b.status !== "pending")
      .map((b) => trafficView(s, b)),
    detections: detections(s),
    watches: watchesView(s),
    grounded: [...s.grounded].sort(),
    feed: [...s.feed],
    events: s.events.filter((e) => e.seq > since),
  };
  if (operator) out.unfound = unfound(s);
  return out;
}

export function idleView(): Json {
  return {
    started: false,
    clock_label: `${CFG.day} ${CFG.start}`,
    counters: { handled: 0, avg_response_s: null, drones_up: 0 },
    drones: [],
    vehicles: [],
    stations: stationsView(),
    incidents: [],
    traffic: [],
    detections: [],
    watches: [],
    grounded: [],
    feed: [],
    events: [],
  };
}
