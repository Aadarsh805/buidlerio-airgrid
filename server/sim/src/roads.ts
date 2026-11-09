// city.Roads: straight roads between neighbouring junctions; shortest paths turn only at junctions.

import { cmpKey, dist, sortBy } from "./pymath";

export const ON_ROAD_EPS = 1e-6;
type P = number[];
type Edge = [P, P];

const key = (p: P) => `${p[0]},${p[1]}`;

/** Min-heap of (km, x, y), the same total order as Python's heapq on (km, (x, y)). */
class Heap {
  private a: [number, P][] = [];
  private less(i: number, j: number): boolean {
    const x = this.a[i];
    const y = this.a[j];
    return cmpKey([x[0], x[1][0], x[1][1]], [y[0], y[1][0], y[1][1]]) < 0;
  }
  get size() {
    return this.a.length;
  }
  push(v: [number, P]) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): [number, P] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class Roads {
  edges: Edge[] = [];

  constructor(junctions: Record<string, number[]>) {
    const uniq = new Map<string, P>();
    for (const p of Object.values(junctions)) uniq.set(key(p), [p[0], p[1]]);
    const pts = sortBy([...uniq.values()], (p) => [p[0], p[1]]);
    const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b);
    const ys = [...new Set(pts.map((p) => p[1]))].sort((a, b) => a - b);
    for (const y of ys) for (let i = 0; i + 1 < xs.length; i++) this.edges.push([[xs[i], y], [xs[i + 1], y]]);
    for (const x of xs) for (let i = 0; i + 1 < ys.length; i++) this.edges.push([[x, ys[i]], [x, ys[i + 1]]]);
  }

  static onEdge(p: P, e: Edge): boolean {
    const [[x0, y0], [x1, y1]] = e;
    if (y0 === y1) return Math.abs(p[1] - y0) <= ON_ROAD_EPS && x0 - ON_ROAD_EPS <= p[0] && p[0] <= x1 + ON_ROAD_EPS;
    return Math.abs(p[0] - x0) <= ON_ROAD_EPS && y0 - ON_ROAD_EPS <= p[1] && p[1] <= y1 + ON_ROAD_EPS;
  }

  onRoad(p: P): boolean {
    return this.edges.some((e) => Roads.onEdge(p, e));
  }

  /** Shortest road path a->b, turning only at junctions. */
  route(a0: P, b0: P): P[] {
    const a: P = [a0[0], a0[1]];
    const b: P = [b0[0], b0[1]];
    const graph = new Map<string, P[]>();
    const add = (u: P, v: P) => {
      const k = key(u);
      if (!graph.has(k)) graph.set(k, []);
      graph.get(k)!.push(v);
    };
    for (const e of this.edges) {
      const stops = new Map<string, P>();
      for (const p of [e[0], e[1]]) stops.set(key(p), p);
      for (const p of [a, b]) if (Roads.onEdge(p, e) && !stops.has(key(p))) stops.set(key(p), p);
      const chain = sortBy([...stops.values()], (p) => [p[0], p[1]]);
      for (let i = 0; i + 1 < chain.length; i++) {
        add(chain[i], chain[i + 1]);
        add(chain[i + 1], chain[i]);
      }
    }
    const best = new Map<string, number>([[key(a), 0.0]]);
    const prev = new Map<string, P>();
    const heap = new Heap();
    heap.push([0.0, a]);
    const kb = key(b);
    while (heap.size) {
      const [km, u] = heap.pop();
      if (key(u) === kb) break;
      const nbrs = graph.get(key(u));
      if (!nbrs) throw new Error(`KeyError: ${key(u)} is not on a road`);
      for (const v of nbrs) {
        const alt = km + dist(u, v);
        const bv = best.get(key(v)) ?? Infinity;
        if (alt < bv - 1e-9) {
          best.set(key(v), alt);
          prev.set(key(v), u);
          heap.push([alt, v]);
        }
      }
    }
    const path: P[] = [b];
    const ka = key(a);
    while (key(path[path.length - 1]) !== ka) {
      const p = prev.get(key(path[path.length - 1]));
      if (!p) throw new Error("KeyError: no road path");
      path.push(p);
    }
    return path.reverse().map((p) => [p[0], p[1]]);
  }
}
