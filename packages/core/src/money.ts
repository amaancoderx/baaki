/**
 * Money is paise (integer). Rupee floats do not survive arithmetic and this
 * system compares collected amounts across seeds, so nothing here is a float.
 */
export type Paise = number;

export const rupees = (r: number): Paise => Math.round(r * 100);
export const toRupees = (p: Paise): number => p / 100;

/** Indian grouping: 1,80,000 not 180,000. */
export function formatINR(p: Paise, opts: { paise?: boolean } = {}): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;

  const s = String(whole);
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }

  const tail = opts.paise ? "." + String(frac).padStart(2, "0") : "";
  return (neg ? "-" : "") + "₹" + grouped + tail;
}
