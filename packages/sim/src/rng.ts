/**
 * mulberry32. Small, fast, and seedable, which is the only property that
 * matters here: every reported number must be reproducible from its seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  #next: () => number;

  constructor(seed: number) {
    this.#next = mulberry32(seed);
  }

  /** Uniform [0,1). */
  float(): number {
    return this.#next();
  }

  bool(p: number): boolean {
    return this.#next() < p;
  }

  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.#next() * (maxExclusive - minInclusive));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty array");
    return items[this.int(0, items.length)]!;
  }

  /** Weighted pick over [key, weight] pairs. */
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.#next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r <= 0) return k;
    }
    return entries[entries.length - 1]![0];
  }

  /** Box-Muller, clamped by the caller where a negative draw is meaningless. */
  normal(mean: number, sd: number): number {
    const u = Math.max(this.#next(), 1e-12);
    const v = this.#next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/**
 * Per-buyer streams. A single global RNG makes the experiment unpaired: a
 * policy change alters how many draws are consumed, which reshuffles who is
 * which persona and which arm they landed in, so a 1pp delta could be the
 * policy or could be a different set of buyers. Splitting the streams keeps
 * setup identical across policy variants and keeps each buyer's payment draws
 * aligned regardless of how many messages the policy chose to send.
 */
export interface BuyerStreams {
  hazard: Rng;
  reply: Rng;
  text: Rng;
}

/** FNV-1a, so a (seed, index, label) triple maps to a stable stream. */
export function streamSeed(seed: number, index: number, label: string): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  const s = `${index}:${label}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function buyerStreams(seed: number, index: number): BuyerStreams {
  return {
    hazard: new Rng(streamSeed(seed, index, "hazard")),
    reply: new Rng(streamSeed(seed, index, "reply")),
    text: new Rng(streamSeed(seed, index, "text")),
  };
}
