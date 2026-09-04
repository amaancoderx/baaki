/** Indian grouping: 1,80,000. Mirrors packages/core money.ts. */
export function formatINR(paise: number): string {
  const neg = paise < 0;
  const whole = Math.floor(Math.abs(paise) / 100);
  const s = String(whole);
  let grouped: string;
  if (s.length <= 3) grouped = s;
  else grouped = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3);
  return (neg ? "-" : "") + "₹" + grouped;
}

/** Compact: ₹1.8L, ₹2.4Cr. For stat tiles where space wins. */
export function formatINRCompact(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(2).replace(/\.?0+$/, "")}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(2).replace(/\.?0+$/, "")}L`;
  return formatINR(paise);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(civil: string): string {
  const [y, m, d] = civil.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export function formatDateShort(civil: string): string {
  const [, m, d] = civil.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

export function formatTs(ts: number): string {
  const d = new Date(ts + 5.5 * 3600_000);
  const day = d.getUTCDate();
  const mon = MONTHS[d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon}, ${hh}:${mm} IST`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

export function overdueSeverity(days: number): "neutral" | "mild" | "warning" | "alert" {
  if (days <= 0) return "neutral";
  if (days <= 15) return "mild";
  if (days <= 45) return "warning";
  return "alert";
}
