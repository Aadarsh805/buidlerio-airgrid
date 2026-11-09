// The parts of sim/engine.py, fleet.py, docks.py, pilots.py, airspace.py, privacy.py, policies.py
// (safety RTB), rules.py and actions.py (divert, launch, close_incident) that city mode runs.
// Same arithmetic, op order and tie-breaks as the Python, so the runs match.
//
// Not ported, because city mode never reaches them: weather grounding, VIP activation and zone
// exits, SEPARATION holds, approvals, ground units, feed facts, golden actions, KPIs and the
// decisions log (no city view reads them). Engine events that city mode does not serve are only
// counted, so event `seq` numbers match the Python log.

import worldJson from "../world.json";
import { DT, dist, fmt, sortBy, minBy } from "./pymath";
import { RngState, seedRng } from "./random";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const W: any = worldJson;
const MODEL = W.drone_model;
const POL = W.policies;

export interface Rect {
  x: [number, number];
  y: [number, number];
}
export interface Zone {
  id: string;
  kind: string;
  rect: Rect;
  active?: boolean;
}
export const ZONES: Zone[] = W.zones;

export interface Drone {
  id: string;
  home: string;
  thermal: boolean;
  state: "docked" | "airborne";
  slot: string | null;
  pos: number[];
  bat: number;
  mission: string | null;
  target: string | number[] | null;
  incident: string | null;
  pilot: string | null;
  launchWait: number;
  onStation: boolean;
  flights: number;
  recording: boolean;
  outOfService: boolean;
}

export interface Dock {
  id: string;
  at: number[];
  slots: number;
  occupants: string[];
  reserved: string[];
  online: boolean;
}

export interface EngIncident {
  kind: string;
  at: number[];
  note: string;
  t: number;
  status: "open" | "closed";
}

export interface EngineState {
  seed: string;
  rng: RngState; // the engine's random.Random(seed): scene pick, risk flag, flare-up
  now: number; // time of the last processed tick
  t: number; // time of the next tick to process
  ticks: number;
  seq: number; // last event seq in the engine log (all events, served or not)
  drones: Record<string, Drone>;
  docks: Record<string, Dock>;
  pilots: Record<string, string[]>; // pilot -> drones supervised
  incidents: Record<string, EngIncident>;
  eyesOn: Record<string, number>;
  recFirst: Record<string, string>; // incident -> clock of its first recording_on privacy row
  violations: number;
}

// ------------------------------------------------------------------ geometry / rules (pure)
export function inRect(p: readonly number[], r: Rect): boolean {
  return r.x[0] <= p[0] && p[0] <= r.x[1] && r.y[0] <= p[1] && p[1] <= r.y[1];
}

export function sectorOf(p: readonly number[]): string {
  return (p[1] > 3.0 ? "N" : "S") + (p[0] >= 3.0 ? "E" : "W");
}

/** Liang-Barsky: does the segment a->b touch the closed rectangle? (rules.segment_hits_rect) */
export function segmentHitsRect(a: readonly number[], b: readonly number[], rect: Rect): boolean {
  const [x0, x1] = rect.x;
  const [y0, y1] = rect.y;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0.0;
  let t1 = 1.0;
  const pq: [number, number][] = [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ];
  for (const [p, q] of pq) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** rules.no_fly_zone(...).ok */
export function noFlyOk(start: readonly number[], target: readonly number[], zones: Zone[]): boolean {
  return !zones.some((z) => segmentHitsRect(start, target, z.rect));
}

const activeVip = (z: Zone) => z.kind === "vip" && Boolean(z.active);

/** RED always, VIP only while active (Airspace.no_entry). */
export function noEntry(): Zone[] {
  return ZONES.filter((z) => z.kind === "red" || activeVip(z));
}

export function inZone(p: readonly number[], kind: string): string | null {
  for (const z of ZONES) {
    if (z.kind === kind && (kind !== "vip" || z.active) && inRect(p, z.rect)) return z.id;
  }
  return null;
}

/** Airspace.detour: `target` itself when no active VIP zone is in the way (always, in city). */
function detour(pos: number[], target: number[]): number[] {
  const m = 0.05;
  for (const z of ZONES.filter(activeVip)) {
    const r = z.rect;
    if (!segmentHitsRect(pos, target, r)) continue;
    if (inRect(target, r)) return pos;
    const corners: number[][] = [];
    for (const x of [r.x[0] - m, r.x[1] + m]) for (const y of [r.y[0] - m, r.y[1] + m]) corners.push([x, y]);
    const inside = corners.filter((c) => c[0] >= 0 && c[0] <= 6 && c[1] >= 0 && c[1] <= 6);
    const clear = inside.filter((c) => !segmentHitsRect(pos, c, r));
    return minBy(clear.length ? clear : [pos], (c) => [dist(pos, c) + dist(c, target)])!;
  }
  return target;
}

// ------------------------------------------------------------------ construction
export function newEngine(seed: string, start: number, docked: Record<string, number>): EngineState {
  const docks: Record<string, Dock> = {};
  for (const [k, v] of Object.entries<{ at: number[]; slots: number }>(W.docks)) {
    docks[k] = { id: k, at: [...v.at], slots: v.slots, occupants: [], reserved: [], online: true };
  }
  const drones: Record<string, Drone> = {};
  for (const [k, v] of Object.entries<{ home: string; thermal?: boolean }>(W.fleet)) {
    drones[k] = {
      id: k,
      home: v.home,
      thermal: Boolean(v.thermal),
      state: "docked",
      slot: null,
      pos: [0, 0],
      bat: 100.0,
      mission: null,
      target: null,
      incident: null,
      pilot: null,
      launchWait: 0.0,
      onStation: false,
      flights: 0,
      recording: false,
      outOfService: false,
    };
  }
  for (const [did, bat] of Object.entries(docked)) {
    const d = drones[did];
    d.bat = bat;
    d.slot = d.home;
    d.pos = [...docks[d.home].at];
    docks[d.home].occupants.push(did);
  }
  const pilots: Record<string, string[]> = {};
  for (const k of Object.keys(W.pilots)) pilots[k] = [];
  return {
    seed,
    rng: seedRng(seed),
    now: start,
    t: start,
    ticks: 0,
    seq: 0,
    drones,
    docks,
    pilots,
    incidents: {},
    eyesOn: {},
    recFirst: {},
    violations: 0,
  };
}

/** One event in the engine log. Returns its seq. */
export function emit(e: EngineState): number {
  e.seq += 1;
  return e.seq;
}

// ------------------------------------------------------------------ fleet primitives
export function dronesList(e: EngineState): Drone[] {
  return Object.values(e.drones);
}

const freeSlots = (k: Dock) => (k.online ? k.slots - k.occupants.length - k.reserved.length : 0);

export function readyCount(e: EngineState): number {
  const rp = MODEL.ready_pct;
  return dronesList(e).filter(
    (d) => d.state === "docked" && e.docks[d.slot!].online && d.bat >= rp && !d.outOfService,
  ).length;
}

/** L12 ready floor. */
export function floorAllows(e: EngineState, d: Drone): boolean {
  if (d.bat < MODEL.ready_pct) return true;
  return readyCount(e) - 1 >= POL.ready_floor;
}

export function readyCandidates(e: EngineState, near: number[], gate: number, avoidThermal = true): Drone[] {
  const penalty = POL.thermal_penalty_km;
  const c: [number, Drone][] = [];
  for (const d of dronesList(e)) {
    if (d.state === "docked" && !d.outOfService && e.docks[d.slot!].online && d.bat >= gate) {
      c.push([dist(d.pos, near) + (avoidThermal && d.thermal ? penalty : 0), d]);
    }
  }
  return sortBy(c, (x) => [x[0], x[1].id]).map((x) => x[1]);
}

function hasCapacity(e: EngineState, p: string): boolean {
  return e.pilots[p].length < W.pilots[p].max_drones;
}

/** Pilots.pilot_for([]): any simulated duty pilot with capacity, world order. */
export function pilotFor(e: EngineState): string | null {
  for (const p of Object.keys(W.pilots)) if (W.pilots[p].kind === "simulated" && hasCapacity(e, p)) return p;
  return null;
}

export function firstHumanRemotePilot(e: EngineState): string | null {
  for (const p of Object.keys(W.pilots)) {
    const spec = W.pilots[p];
    if (spec.kind === "human" && (spec.roles || []).includes("remote_pilot") && hasCapacity(e, p)) return p;
  }
  return null;
}

export function assignPilot(e: EngineState, d: Drone, pid: string | null): void {
  if (d.pilot) e.pilots[d.pilot] = e.pilots[d.pilot].filter((x) => x !== d.id);
  d.pilot = pid;
  if (pid && !e.pilots[pid].includes(d.id)) e.pilots[pid].push(d.id);
}

export function launch(
  e: EngineState,
  d: Drone,
  mission: string,
  target: number[] | null = null,
  incident: string | null = null,
  pilot: string | null = null,
): void {
  const dk = e.docks[d.slot!];
  dk.occupants.splice(dk.occupants.indexOf(d.id), 1);
  d.slot = null;
  d.state = "airborne";
  d.mission = mission;
  d.incident = incident;
  d.target = target;
  d.launchWait = MODEL.launch_delay_min;
  d.onStation = false;
  d.flights += 1;
  assignPilot(e, d, pilot);
}

function bookSlot(e: EngineState, d: Drone): string | null {
  const order = sortBy(Object.keys(e.docks), (k) => [dist(d.pos, e.docks[k].at), k === d.home ? 0 : 1]);
  for (const k of order) {
    const dk = e.docks[k];
    if (freeSlots(dk) > 0) {
      dk.reserved.push(d.id);
      return k;
    }
    if (dist(d.pos, dk.at) < POL.slot_log_radius_km) emit(e); // slot_reroute
  }
  e.violations += 1; // "no free slot anywhere"
  return null;
}

export function rtb(e: EngineState, d: Drone, why = ""): void {
  if (d.state !== "airborne" || d.mission === "returning") return;
  const slot = bookSlot(e, d);
  d.mission = "returning";
  d.target = slot;
  d.onStation = false;
  if (why) emit(e); // rtb
}

function projectedLanding(e: EngineState, d: Drone): number {
  let best = 99;
  let any = false;
  for (const k of Object.values(e.docks)) {
    if (freeSlots(k) > 0 || k.reserved.includes(d.id)) {
      const km = dist(d.pos, k.at);
      if (!any || km < best) best = km;
      any = true;
    }
  }
  return d.bat - (best / MODEL.cruise_km_per_min) * MODEL.drain_pct_per_min.cruise;
}

function safetyRtb(e: EngineState, d: Drone): void {
  if (d.mission === "returning") return;
  const proj = projectedLanding(e, d);
  if (proj <= MODEL.reserve_pct + POL.safety_rtb_margin_pct) {
    emit(e); // safety_rtb
    rtb(e, d, "safety");
  }
}

export function move(d: Drone, target: readonly number[], speed: number): boolean {
  const dd = dist(d.pos, target);
  const step = speed * DT;
  if (dd <= step) {
    d.pos = [target[0], target[1]];
    return true;
  }
  d.pos = [d.pos[0] + ((target[0] - d.pos[0]) * step) / dd, d.pos[1] + ((target[1] - d.pos[1]) * step) / dd];
  return false;
}

/** Engine._fly: True only on reaching the target itself. */
export function fly(d: Drone, target: number[], speed: number): boolean {
  const aim = detour(d.pos, target);
  return move(d, aim, speed) && aim === target;
}

const drain = (d: Drone, rate: number) => {
  d.bat -= rate * DT;
};

export interface MoveHooks {
  roam(d: Drone): void;
  investigate(d: Drone): void;
  escort(d: Drone): void;
  watch(d: Drone): void;
}

/** Engine._movement for the missions city mode uses. */
export function movement(e: EngineState, t: number, hooks: MoveHooks): void {
  const rates = MODEL.drain_pct_per_min;
  const cruise = MODEL.cruise_km_per_min;
  for (const d of dronesList(e)) {
    if (d.state === "docked") {
      d.bat = Math.min(MODEL.charge_cap_pct, d.bat + MODEL.charge_pct_per_min * DT);
      continue;
    }
    if (d.launchWait > 0) {
      d.launchWait -= DT;
      drain(d, rates.hover);
      continue;
    }
    if (d.mission === "roam") {
      drain(d, rates.cruise);
      hooks.roam(d);
    } else if (d.mission === "investigate") {
      drain(d, rates.cruise);
      hooks.investigate(d);
    } else if (d.mission === "escort") {
      drain(d, rates.cruise);
      hooks.escort(d);
    } else if (d.mission === "watch") {
      drain(d, rates.cruise);
      hooks.watch(d);
    } else if (d.mission === "incident" || d.mission === "search") {
      if (d.onStation) drain(d, rates.hover);
      else {
        drain(d, rates.cruise);
        if (fly(d, d.target as number[], cruise)) {
          d.onStation = true;
          if (!(d.incident! in e.eyesOn)) {
            e.eyesOn[d.incident!] = t;
            emit(e); // eyes_on
          }
        }
      }
    } else if (d.mission === "returning") {
      drain(d, rates.cruise);
      const k = d.target as string;
      if (fly(d, e.docks[k].at, cruise)) {
        const dk = e.docks[k];
        dk.reserved.splice(dk.reserved.indexOf(d.id), 1);
        dk.occupants.push(d.id);
        d.state = "docked";
        d.slot = k;
        d.mission = null;
        d.incident = null;
        assignPilot(e, d, null);
        emit(e); // landing
        if (d.bat < MODEL.reserve_pct) e.violations += 1;
      }
    }
    if (d.state === "airborne") {
      if (inZone(d.pos, "red")) e.violations += 1;
      safetyRtb(e, d);
      if (d.bat < MODEL.reserve_pct) e.violations += 1;
    }
  }
}

// ------------------------------------------------------------------ recording (derived, privacy.py)
const INCIDENT_MISSIONS = new Set(["incident", "perimeter", "corridor", "search", "track", "relay", "hold"]);

function deriveRecording(e: EngineState, d: Drone): boolean {
  if (d.state !== "airborne" || !INCIDENT_MISSIONS.has(d.mission ?? "") || !d.incident) return false;
  const inc = e.incidents[d.incident];
  if (!inc || inc.status !== "open") return false;
  if (inZone(d.pos, "no_record")) return false;
  return dist(d.pos, inc.at) <= POL.geofence_km;
}

export function privacyUpdate(e: EngineState, t: number): void {
  for (const d of dronesList(e)) {
    const on = deriveRecording(e, d);
    if (on !== d.recording) {
      d.recording = on;
      if (on && d.incident && !(d.incident in e.recFirst)) e.recFirst[d.incident] = fmt(t);
    }
  }
}

// ------------------------------------------------------------------ incidents
/** Engine.inject_alert: a CAD alert happening now. Own series INC-T1, INC-T2... */
export function injectAlert(e: EngineState, spec: { kind: string; at: number[]; note: string }): string {
  const n = Object.keys(e.incidents).filter((k) => k.startsWith("INC-T")).length + 1;
  const iid = `INC-T${n}`;
  e.incidents[iid] = { kind: spec.kind, at: [...spec.at], note: spec.note, t: e.now, status: "open" };
  emit(e); // cad_alert (on_cad_alert returns at once for city incidents)
  return iid;
}

// ------------------------------------------------------------------ validated actions (actions.py)
/** actions.execute(eng, dispatch, "divert", ...).ok */
export function divert(e: EngineState, did: string, mission: string, iid: string, to: number[]): boolean {
  const d = e.drones[did];
  const inc = e.incidents[iid];
  if (!d || !inc) return false; // NOT_FOUND
  if (d.state !== "airborne") return false; // DRONE_NOT_READY
  const cur = d.incident ? e.incidents[d.incident] : undefined;
  if (cur && cur.status === "open" && d.incident !== iid) return false; // AUTH_REQUIRED (no approvals in city)
  if (inc.status === "closed") return false; // MISSION_EXPIRED
  const target = [Number(to[0]), Number(to[1])];
  if (!noFlyOk(d.pos, target, noEntry())) return false; // NO_FLY_ZONE
  d.mission = mission;
  d.incident = iid;
  d.onStation = false;
  d.target = target;
  emit(e); // divert
  return true;
}

/** actions.execute(eng, dispatch, "launch", {mission: incident, ...}).ok */
export function launchIncident(e: EngineState, did: string, pilot: string, iid: string, to: number[]): boolean {
  const d = e.drones[did];
  const inc = e.incidents[iid];
  if (!d || !inc) return false;
  if (inc.status === "closed") return false;
  const target = [Number(to[0]), Number(to[1])];
  const gate = MODEL.launch_gate_pct.incident;
  const dockOnline = d.slot ? e.docks[d.slot].online : false;
  if (d.outOfService || d.state !== "docked" || !dockOnline || d.bat < gate) return false;
  if (!noFlyOk(d.pos, target, noEntry())) return false;
  if (dist(e.docks[d.slot!].at, target) > MODEL.radius_km) return false;
  // projected battery after the flight and the way home (actions._projected_after)
  const cruise = MODEL.cruise_km_per_min;
  const c = MODEL.drain_pct_per_min.cruise;
  let p = d.bat;
  p -= MODEL.launch_delay_min * MODEL.drain_pct_per_min.hover;
  p -= (dist(d.pos, target) / cruise) * c;
  p -= 0.0 * MODEL.drain_pct_per_min.hover;
  let back = 99;
  let any = false;
  for (const k of Object.values(e.docks)) {
    if (k.online && (freeSlots(k) > 0 || k.id === d.slot)) {
      const km = dist(target, k.at);
      if (!any || km < back) back = km;
      any = true;
    }
  }
  if (p - (back / cruise) * c < MODEL.reserve_pct) return false; // BATTERY_RESERVE
  if (!(pilot in e.pilots)) return false;
  if (!e.pilots[pilot].includes(d.id) && e.pilots[pilot].length >= W.pilots[pilot].max_drones) return false;
  launch(e, d, "incident", target, iid, pilot);
  emit(e); // launch
  return true;
}

export function closeIncident(e: EngineState, iid: string): boolean {
  const inc = e.incidents[iid];
  if (!inc || inc.status !== "open") return false;
  inc.status = "closed";
  emit(e); // incident_closed
  return true;
}
