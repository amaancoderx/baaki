export interface Summary { mean: number; sd: number; min: number; max: number; n: number }

export function summarise(xs: number[]): Summary {
  const n = xs.length;
  if (n === 0) return { mean: 0, sd: 0, min: 0, max: 0, n: 0 };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  // Sample sd: seeds are a sample of the seed space, not the whole of it.
  const varc = n < 2 ? 0 : xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { mean, sd: Math.sqrt(varc), min: Math.min(...xs), max: Math.max(...xs), n };
}

export const pm = (s: Summary, digits = 1): string =>
  `${s.mean.toFixed(digits)} ± ${s.sd.toFixed(digits)}`;

export const range = (s: Summary, digits = 1): string =>
  `${s.min.toFixed(digits)}-${s.max.toFixed(digits)}`;

/** Crore/lakh for readability; the panel reads Indian figures faster this way. */
export function croreLakh(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2)} Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2)} L`;
  return `₹${Math.round(r).toLocaleString("en-IN")}`;
}
