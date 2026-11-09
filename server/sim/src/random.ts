// Python's random.Random (MT19937), ported exactly: string seeding (version 2, SHA-512), random(),
// getrandbits(k <= 32), choice() and randint(). The state is plain JSON so it can be stored.

import { sha512, utf8 } from "./sha512";

const N = 624;
const M = 397;

export interface RngState {
  mt: number[];
  i: number;
}

function initGenrand(s: number): number[] {
  const mt = new Array<number>(N);
  mt[0] = s >>> 0;
  for (let i = 1; i < N; i++) {
    const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
    mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
  }
  return mt;
}

function initByArray(key: number[]): number[] {
  const mt = initGenrand(19650218);
  let i = 1;
  let j = 0;
  const klen = key.length;
  for (let k = N > klen ? N : klen; k; k--) {
    const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
    mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
    i++;
    j++;
    if (i >= N) {
      mt[0] = mt[N - 1];
      i = 1;
    }
    if (j >= klen) j = 0;
  }
  for (let k = N - 1; k; k--) {
    const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
    mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
    i++;
    if (i >= N) {
      mt[0] = mt[N - 1];
      i = 1;
    }
  }
  mt[0] = 0x80000000;
  return mt;
}

/** random.Random(seed) for a str seed. */
export function seedRng(seed: string): RngState {
  const raw = utf8(seed);
  const digest = sha512(raw);
  const all = new Uint8Array(raw.length + digest.length);
  all.set(raw);
  all.set(digest, raw.length);
  // int.from_bytes(big-endian) -> 32-bit words, least significant first
  let n = 0n;
  for (const b of all) n = (n << 8n) | BigInt(b);
  const key: number[] = [];
  if (n === 0n) key.push(0);
  while (n > 0n) {
    key.push(Number(n & 0xffffffffn));
    n >>= 32n;
  }
  return { mt: initByArray(key), i: N };
}

export function genrandUint32(st: RngState): number {
  const mt = st.mt;
  if (st.i >= N) {
    let kk = 0;
    for (; kk < N - M; kk++) {
      const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
    }
    for (; kk < N - 1; kk++) {
      const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
    }
    const y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
    mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
    st.i = 0;
  }
  let y = mt[st.i++];
  y ^= y >>> 11;
  y ^= (y << 7) & 0x9d2c5680;
  y ^= (y << 15) & 0xefc60000;
  y ^= y >>> 18;
  return y >>> 0;
}

/** random.random(): 53-bit float in [0, 1). */
export function random(st: RngState): number {
  const a = genrandUint32(st) >>> 5;
  const b = genrandUint32(st) >>> 6;
  return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
}

/** random.getrandbits(k) for 0 <= k <= 32. */
export function getrandbits(st: RngState, k: number): number {
  if (k === 0) return 0;
  if (k > 32) throw new Error("getrandbits: k > 32 not needed here");
  return genrandUint32(st) >>> (32 - k);
}

function bitLength(n: number): number {
  return 32 - Math.clz32(n);
}

/** Random._randbelow_with_getrandbits(n). */
export function randbelow(st: RngState, n: number): number {
  const k = bitLength(n);
  let r = getrandbits(st, k);
  while (r >= n) r = getrandbits(st, k);
  return r;
}

export function choice<T>(st: RngState, seq: readonly T[]): T {
  if (!seq.length) throw new Error("Cannot choose from an empty sequence");
  return seq[randbelow(st, seq.length)];
}

export function randint(st: RngState, a: number, b: number): number {
  return a + randbelow(st, b - a + 1);
}
