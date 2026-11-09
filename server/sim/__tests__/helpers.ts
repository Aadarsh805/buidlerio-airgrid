import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CityError, CityInvalid, CityState, createCity, decide, order, step, ticks, trigger, view } from "../src/index";

export const FIXTURES = join(__dirname, "..", "parity", "fixtures");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export function load(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf-8"));
}

/** Differences between two JSON values; numbers within `tol`. Returns paths, at most `max`. */
export function diff(a: Json, b: Json, tol = 1e-6, path = "$", out: string[] = [], max = 20): string[] {
  if (out.length >= max) return out;
  if (typeof a === "number" && typeof b === "number") {
    if (!(Math.abs(a - b) <= tol)) out.push(`${path}: ${a} != ${b}`);
    return out;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: array vs object`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], tol, `${path}[${i}]`, out, max);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) out.push(`${path}.${k}: missing in TS`);
    else if (!(k in b)) out.push(`${path}.${k}: extra in TS`);
    else diff(a[k], b[k], tol, `${path}.${k}`, out, max);
  }
  return out;
}

/** Run one recorded op in TS; returns what the Python op recorded (result/error/invalid/view). */
export function run(state: CityState | null, op: Json): { state: CityState; got: Json } {
  if (op.op === "create") return { state: createCity(op.seed), got: null };
  const s = state!;
  const write = (fn: () => Json) => {
    try {
      return { result: fn() };
    } catch (e) {
      if (e instanceof CityError) return { error: e.body() };
      if (e instanceof CityInvalid) return { invalid: e.message };
      throw e;
    }
  };
  switch (op.op) {
    case "step":
      step(s, op.min);
      return { state: s, got: null };
    case "ticks":
      ticks(s, op.n);
      return { state: s, got: null };
    case "trigger":
      return { state: s, got: write(() => trigger(s, op.kind)) };
    case "decide":
      return {
        state: s,
        got: write(() => decide(s, { incident: op.incident, place: op.place, choice: op.choice })),
      };
    case "order":
      return {
        state: s,
        got: write(() => order(s, { order: op.order, place: op.place, drone: op.drone, minutes: op.minutes })),
      };
    case "snap":
      return { state: s, got: { view: view(s, { operator: true }) } };
  }
  throw new Error(`unknown op ${op.op}`);
}

export function expected(op: Json): Json {
  if (op.op === "snap") return { view: op.view };
  for (const k of ["result", "error", "invalid"]) if (k in op) return { [k]: op[k] };
  return null;
}
