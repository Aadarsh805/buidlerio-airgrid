// Python numerics and Mersenne Twister, compared with values recorded from CPython 3.12.
import { describe, expect, it } from "vitest";
import { choice, randint, random, seedRng } from "../src/random";
import { fmt, hypot, pyFixed, pyG, pyRound } from "../src/pymath";
import { load } from "./helpers";

const P = load("primitives");
const range = (n: number) => [...Array(n).keys()];

describe("random.Random port", () => {
  for (const r of P.rng) {
    it(`seed ${JSON.stringify(r.seed).slice(0, 20)}`, () => {
      const g = seedRng(r.seed);
      expect(range(700).map(() => random(g))).toEqual(r.random);
      expect(range(50).map(() => choice(g, range(7)))).toEqual(r.choice7);
      expect(range(50).map(() => randint(g, 1, 3))).toEqual(r.randint13);
      expect(range(50).map(() => choice(g, range(100)))).toEqual(r.choice100);
    });
  }
});

describe("python numerics", () => {
  it("math.hypot bit for bit", () => {
    const bad = P.hypot.filter(([x, y, h]: number[]) => hypot(x, y) !== h);
    expect(bad).toEqual([]);
  });
  it("round(x, n) and f'{x:.nf}'", () => {
    const bad = P.round.filter(
      ([x, n, r, s]: [number, number, number, string | null]) => pyRound(x, n) !== r || (s !== null && pyFixed(x, n) !== s),
    );
    expect(bad).toEqual([]);
  });
  it("fmt and :g", () => {
    expect(P.fmt.filter(([t, s]: [number, string]) => fmt(t) !== s)).toEqual([]);
    expect(P.g.filter(([x, s]: [number, string]) => pyG(x) !== s)).toEqual([]);
  });
});
