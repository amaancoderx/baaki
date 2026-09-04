/**
 * All policy time is Asia/Kolkata. IST has no DST and sits at a fixed +05:30,
 * so civil-time maths is an offset rather than a tz database lookup.
 */
export const IST_OFFSET_MIN = 5 * 60 + 30;

/** Civil date in IST, 'YYYY-MM-DD'. */
export type CivilDate = string;

export function istParts(tsMs: number): {
  date: CivilDate;
  hour: number;
  minute: number;
  weekday: number; // 0 Sun .. 6 Sat
} {
  const shifted = new Date(tsMs + IST_OFFSET_MIN * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  return {
    date,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Midnight IST of a civil date, as epoch ms. */
export function istMidnight(date: CivilDate): number {
  return Date.parse(date + "T00:00:00Z") - IST_OFFSET_MIN * 60_000;
}

/** A specific IST wall-clock time on a civil date, as epoch ms. */
export function istAt(date: CivilDate, hour: number, minute = 0): number {
  return istMidnight(date) + (hour * 60 + minute) * 60_000;
}

export function addDays(date: CivilDate, n: number): CivilDate {
  const d = new Date(Date.parse(date + "T00:00:00Z"));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole civil days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: CivilDate, to: CivilDate): number {
  const ms = Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

export function parseHHMM(s: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad HH:MM: ${s}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export interface Clock {
  now(): number;
}

export const systemClock = (): Clock => ({ now: () => Date.now() });

/** Test/sim clock. The sim advances this one tick per simulated day. */
export function fixedClock(startMs: number): Clock & { set(ms: number): void; advanceDays(n: number): void } {
  let t = startMs;
  return {
    now: () => t,
    set: (ms: number) => { t = ms; },
    advanceDays: (n: number) => { t += n * 86_400_000; },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "22 Oct" — how a date reads inside a message to a buyer. */
export function formatCivilShort(date: CivilDate): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** "22 Oct 2025" — for anywhere the year is load-bearing. */
export function formatCivil(date: CivilDate): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}
