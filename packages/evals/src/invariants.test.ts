import { describe, expect, it, beforeAll } from "vitest";
import {
  daysBetween, isHoliday, istParts, parseHHMM, type Invoice, type Touch,
} from "@baaki/core";
import { runSim, type SimResult } from "@baaki/sim";

/**
 * Invariants over full simulated runs. Unit tests prove a guard rejects a bad
 * action; these prove no bad action ever reached a buyer across tens of
 * thousands of decisions. The test names are the stopping rules.
 */
const SEEDS = [7919, 15838, 23757];
const runs: SimResult[] = [];

beforeAll(async () => {
  for (const seed of SEEDS) {
    runs.push(await runSim({ seed, invoices: 250, horizonDays: 180, holdout: 0.2 }));
  }
}, 120_000);

const allTouches = (r: SimResult): Touch[] => [...r.ledger.allTouches()];

describe("contact window", () => {
  it("sends no touch outside 09:00-18:00 IST", () => {
    for (const r of runs) {
      const policy = r.ledger.policy;
      const start = parseHHMM(policy.contactWindow.start);
      const end = parseHHMM(policy.contactWindow.end);
      for (const t of allTouches(r)) {
        const { hour, minute } = istParts(t.ts);
        const mins = hour * 60 + minute;
        expect(mins, `touch ${t.id}`).toBeGreaterThanOrEqual(start.hour * 60 + start.minute);
        expect(mins, `touch ${t.id}`).toBeLessThan(end.hour * 60 + end.minute);
      }
    }
  });

  it("sends no touch on a holiday or a Sunday", () => {
    for (const r of runs) {
      const cal = r.ledger.policy.contactWindow.holidays;
      for (const t of allTouches(r)) {
        const { date, weekday } = istParts(t.ts);
        expect(weekday, `touch ${t.id} on ${date}`).not.toBe(0);
        expect(isHoliday(date, cal), `touch ${t.id} on ${date}`).toBe(false);
      }
    }
  });
});

describe("touch budget", () => {
  it("never exceeds maxTouches on any invoice", () => {
    for (const r of runs) {
      const max = r.ledger.policy.maxTouches;
      for (const inv of r.ledger.invoices()) {
        expect(r.ledger.touchesFor(inv.id).length, `invoice ${inv.id}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("never sends two touches closer than minGapDays", () => {
    for (const r of runs) {
      const min = r.ledger.policy.minGapDays;
      for (const inv of r.ledger.invoices()) {
        const ts = r.ledger.touchesFor(inv.id).map((t) => istParts(t.ts).date);
        for (let i = 1; i < ts.length; i++) {
          expect(daysBetween(ts[i - 1]!, ts[i]!), `invoice ${inv.id} touch ${i}`).toBeGreaterThanOrEqual(min);
        }
      }
    }
  });
});

describe("holds", () => {
  it("sends zero touches while a promise is in flight", () => {
    for (const r of runs) {
      for (const inv of r.ledger.invoices()) {
        const touches = r.ledger.touchesFor(inv.id);
        const promises = r.ledger.repliesFor(inv.id).filter((x) => x.intent === "promise" && x.promiseDate);
        for (const p of promises) {
          for (const t of touches) {
            if (t.ts <= p.ts) continue;
            const touchDate = istParts(t.ts).date;
            // A later promise supersedes this one; only test the window it owned.
            const superseded = promises.some((q) => q.ts > p.ts && q.ts < t.ts);
            if (superseded) continue;
            const insideWindow = daysBetween(touchDate, p.promiseDate!) >= 0;
            expect(insideWindow, `touch ${t.id} on ${touchDate} inside promise to ${p.promiseDate}`).toBe(false);
          }
        }
      }
    }
  });

  it("sends zero touches while a dispute is open", () => {
    for (const r of runs) {
      for (const inv of r.ledger.invoices()) {
        const entries = r.ledger.audit.forInvoice(inv.id);
        const opened = entries.filter((e) => e.action === "open_dispute");
        for (const o of opened) {
          // The merchant resolution is logged as a substate change back to the ladder.
          const resolved = entries.find((e) => e.ts > o.ts && e.actor === "human");
          const until = resolved?.ts ?? Number.MAX_SAFE_INTEGER;
          for (const t of r.ledger.touchesFor(inv.id)) {
            const inWindow = t.ts > o.ts && t.ts < until;
            expect(inWindow, `touch ${t.id} during dispute on ${inv.id}`).toBe(false);
          }
        }
      }
    }
  });

  it("sends zero touches after escalation to a human", () => {
    for (const r of runs) {
      for (const inv of r.ledger.invoices()) {
        const esc = r.ledger.audit.forInvoice(inv.id).find((e) => e.action === "escalate_to_human");
        if (!esc) continue;
        const after = r.ledger.touchesFor(inv.id).filter((t) => t.ts > esc.ts);
        expect(after.map((t) => t.id), `invoice ${inv.id}`).toEqual([]);
      }
    }
  });
});

describe("terminal rules", () => {
  it("sends zero touches after do_not_contact is set", () => {
    for (const r of runs) {
      for (const inv of r.ledger.invoices()) {
        const stop = r.ledger.repliesFor(inv.id).find((x) => x.intent === "stop");
        if (!stop) continue;
        const after = r.ledger.touchesFor(inv.id).filter((t) => t.ts > stop.ts);
        expect(after.map((t) => t.id), `invoice ${inv.id} after opt-out`).toEqual([]);
      }
    }
  });

  it("sends zero touches after the invoice is paid in full", () => {
    for (const r of runs) {
      for (const inv of r.ledger.invoices()) {
        const pays = r.ledger.paymentsFor(inv.id);
        let running = 0;
        let settledAt: number | null = null;
        for (const p of pays) {
          running += p.amount;
          if (running >= inv.amount) { settledAt = p.ts; break; }
        }
        if (settledAt === null) continue;
        const after = r.ledger.touchesFor(inv.id).filter((t) => t.ts > settledAt!);
        expect(after.map((t) => t.id), `invoice ${inv.id} after settlement`).toEqual([]);
      }
    }
  });

  it("sends no free-form WhatsApp outside the 24-hour session window", () => {
    for (const r of runs) {
      for (const inv of r.ledger.invoices()) {
        const replies = r.ledger.repliesFor(inv.id);
        for (const t of r.ledger.touchesFor(inv.id)) {
          if (!t.body.startsWith("[free_form]")) continue;
          const lastInbound = replies.filter((x) => x.ts <= t.ts).pop();
          expect(lastInbound, `free-form touch ${t.id} with no inbound`).toBeDefined();
          expect(t.ts - lastInbound!.ts, `free-form touch ${t.id}`).toBeLessThanOrEqual(24 * 3600_000);
        }
      }
    }
  });

  it("reaches a terminal state on every campaign by its end date", () => {
    for (const r of runs) {
      for (const inv of r.ledger.invoices()) {
        if (inv.arm !== "baaki") continue;
        const terminal: Invoice["substate"][] = ["paid", "closed", "human_hold", "disputed"];
        expect(terminal, `invoice ${inv.id} left in ${inv.substate}`).toContain(inv.substate);
      }
    }
  });
});

describe("audit trail", () => {
  it("gives every entry a rationale and at least one evidence link", () => {
    for (const r of runs) {
      const entries = r.ledger.audit.all();
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.rationale.trim().length, `entry ${e.id}`).toBeGreaterThan(0);
        expect(e.evidence.length, `entry ${e.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("records a guard verdict on every touch it logged", () => {
    for (const r of runs) {
      for (const e of r.ledger.audit.all()) {
        if (e.action !== "send_nudge") continue;
        expect(e.guards.length, `entry ${e.id}`).toBeGreaterThan(0);
        expect(e.guards.every((g) => g.pass), `entry ${e.id} sent despite a failing guard`).toBe(true);
      }
    }
  });

  it("exports to CSV with one row per entry", () => {
    const r = runs[0]!;
    const csv = r.ledger.audit.export("csv");
    expect(csv.split("\n").length).toBe(r.ledger.audit.all().length + 1);
  });
});
