import type { CivilDate } from "../time.js";

/**
 * National holidays plus Karnataka state holidays. Hand-entered for the
 * campaign window rather than pulled from a package, because a wrong holiday
 * list is a silent compliance failure and this one is auditable by eye.
 */
const IN_KA_2025: CivilDate[] = [
  "2025-01-01", "2025-01-14", "2025-01-26", "2025-02-26", "2025-03-14",
  "2025-03-31", "2025-04-10", "2025-04-14", "2025-04-18", "2025-05-01",
  "2025-08-15", "2025-08-27", "2025-09-05", "2025-10-01", "2025-10-02",
  "2025-10-20", "2025-10-22", "2025-11-01", "2025-12-25",
];

const IN_KA_2026: CivilDate[] = [
  "2026-01-01", "2026-01-14", "2026-01-26", "2026-03-04", "2026-03-19",
  "2026-03-21", "2026-03-26", "2026-04-01", "2026-04-14", "2026-05-01",
  "2026-08-15", "2026-08-26", "2026-09-14", "2026-10-02", "2026-10-20",
  "2026-11-01", "2026-11-08", "2026-12-25",
];

const CALENDARS: Record<string, ReadonlySet<CivilDate>> = {
  "IN-KA": new Set([...IN_KA_2025, ...IN_KA_2026]),
  "IN": new Set([...IN_KA_2025, ...IN_KA_2026].filter((d) =>
    // national subset: Republic Day, Independence Day, Gandhi Jayanti, Christmas, New Year
    /-01-01|-01-26|-08-15|-10-02|-12-25/.test(d))),
};

export function isHoliday(date: CivilDate, calendar: string): boolean {
  return CALENDARS[calendar]?.has(date) ?? false;
}

/** Sunday is not a business day. Saturday is, for Indian SMEs. */
export function isNonBusinessDay(date: CivilDate, calendar: string, weekday: number): boolean {
  return weekday === 0 || isHoliday(date, calendar);
}

export function holidayCalendars(): string[] {
  return Object.keys(CALENDARS);
}
