import { DEMO_POLICY, LIVE_POLICY, addDays, isNonBusinessDay, istAt, istParts, type CivilDate } from "@baaki/core";
import { baaki, demoOffset, json, policy, setDemoOffset, store } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Time control for the demo.
 *
 * An invoice takes weeks to play out and a demo has minutes, so the clock can
 * be moved forward. That is the only thing being simulated. Each jump runs a
 * real tick: the guards see the moved time rather than being switched off, the
 * WhatsApp is really sent, the call is really placed, and the payment at the
 * end is a real one on a real Razorpay link.
 *
 * The clock only ever moves forward. Rewinding it would put audit entries out
 * of order in an append-only log, which is the one thing that log promises.
 */

/** Inside both the message window and the tighter calling window. */
const CALLABLE_HOURS = { from: 10, to: 17 };

function jumpTo(target: CivilDate, after: number, holidays: string): number {
  let date = target;
  for (let i = 0; i < 400; i++) {
    const at11 = istAt(date, 11);
    const p = istParts(at11);
    if (at11 > after && !isNonBusinessDay(p.date, holidays, p.weekday)) return at11;
    date = addDays(date, 1);
  }
  return istAt(addDays(target, 1), 11);
}

export async function GET() {
  const off = await demoOffset();
  const p = await policy();
  const simNow = Date.now() + off;
  const ledger = await store().load(p);
  const today = istParts(simNow).date;
  ledger.refreshAll(today);

  const waiting = ledger.openInvoices().map((inv) => {
    const c = ledger.caseFile(inv.id, simNow);
    return { invoiceId: inv.id, buyer: c.buyer.name, nextReviewOn: c.nextReviewOn, substate: inv.substate };
  });

  return json({
    offsetMs: off,
    daysAhead: Math.round(off / 86_400_000),
    realDate: istParts(Date.now()).date,
    simulatedDate: today,
    waiting,
  });
}

export async function POST(req: Request) {
  const { action, days, which } = (await req.json().catch(() => ({}))) as { action?: string; days?: number; which?: string };

  if (action === "reset") {
    await setDemoOffset(0);
    return json({ ok: true, offsetMs: 0, simulatedDate: istParts(Date.now()).date });
  }

  if (action === "policy") {
    // Swap the whole book onto the compressed calendar, or back. Same code,
    // same guards, same ladder; only the gaps differ, and the screen says so.
    const next = which === "demo" ? DEMO_POLICY : LIVE_POLICY;
    const saved = await store().savePolicy(next);
    return json({ policy: saved, compressed: saved.policyVersion.endsWith("demo") });
  }

  if (action !== "advance") return json({ error: "action must be advance, skip, reset or policy" }, 400);

  // An explicit number of days, for driving a demo at a chosen pace rather
  // than letting it jump to wherever the next thing happens to be.
  if (typeof days === "number" && days > 0) {
    const p0 = await policy();
    const off0 = await demoOffset();
    const from = istParts(Date.now() + off0).date;
    const target = addDays(from, Math.min(days, 90));
    const at = jumpTo(target, Date.now() + off0, p0.contactWindow.holidays);
    const offset = at - Date.now();
    await setDemoOffset(offset);
    const b0 = await baaki({ origin: new URL(req.url).origin });
    const rep = await b0.tick();
    if (rep.lockHeld) return json({ error: "another pass is holding the ledger, try again shortly" }, 409);
    return json({
      ok: true, jumped: true, offsetMs: offset,
      daysAhead: Math.round(offset / 86_400_000),
      simulatedDate: rep.today, looked: 1, quiet: rep.sentCount === 0, nextDue: null,
      report: {
        sent: rep.sentCount, blocked: rep.blockedCount,
        actions: rep.actions.map((a) => ({
          on: rep.today, invoiceId: a.invoiceId, buyer: a.buyer, route: a.route,
          kind: a.action.kind, rung: a.action.kind === "send_nudge" ? a.action.rung : null,
          rationale: a.rationale, sent: a.sent ?? null, blocked: a.blocked ?? null,
          error: a.error ?? null,
          guardsFailed: a.guards.filter((g) => !g.pass).map((g) => g.name),
        })),
      },
    });
  }

  const p = await policy();
  const holidays = p.contactWindow.holidays;
  const origin = new URL(req.url).origin;

  // One click should produce one thing worth watching. Most days the agent
  // looks at the book and decides to wait, which is the honest behaviour but
  // makes for a demo of clicking a button and seeing nothing. So this keeps
  // moving the clock and ticking until something actually happens, and reports
  // every pass it made on the way so the waiting is still visible.
  const passes: { date: string; jumped: boolean; actions: unknown[] }[] = [];
  let offsetMs = await demoOffset();
  let happened = false;

  let nextDue: CivilDate | null = null;
  let lastTarget: CivilDate | null = null;

  for (let i = 0; i < 8 && !happened; i++) {
    const simNow = Date.now() + offsetMs;
    const today = istParts(simNow).date;

    const ledger = await store().load(p);
    ledger.refreshAll(today);
    const open = ledger.openInvoices();
    if (open.length === 0) {
      if (i === 0) return json({ error: "no open invoices to advance" }, 400);
      break;
    }

    // The earliest moment any case wants attention. Cases the automation will
    // never act on again are excluded: a case on human_hold or in dispute is
    // waiting on a person, not on the calendar, and letting one drive the clock
    // pins it to today forever. That is exactly what happened, because invoices
    // held before decisions were recorded carry no review date at all.
    const live = open.filter((inv) => !["human_hold", "disputed"].includes(inv.substate));
    let target: CivilDate | null = null;
    for (const inv of live) {
      const c = ledger.caseFile(inv.id, simNow);
      const want = c.nextReviewOn ?? today;
      if (!target || want < target) target = want;
    }
    if (live.length === 0) {
      if (i === 0) return json({ error: "every open invoice is waiting on a person, so there is nothing for the clock to advance to" }, 400);
      break;
    }
    if (!target || target < today) target = today;


    // The earliest date anything is actually scheduled for, so a quiet stretch
    // can say what it is waiting on rather than just reporting nothing.
    nextDue = live.reduce<CivilDate | null>((acc, inv) => {
      const on = ledger.caseFile(inv.id, simNow).nextReviewOn;
      return on && (!acc || on < acc) ? on : acc;
    }, null);

    const nowParts = istParts(simNow);
    const actionableNow =
      target <= today
      && !isNonBusinessDay(nowParts.date, holidays, nowParts.weekday)
      && nowParts.hour >= CALLABLE_HOURS.from
      && nowParts.hour < CALLABLE_HOURS.to;

    let jumped = false;
    if (!actionableNow) {
      offsetMs = jumpTo(target, simNow, holidays) - Date.now();
      await setDemoOffset(offsetMs);
      jumped = true;
    }

    // Rebuilt each pass. Baaki reads the offset once when it is constructed, so
    // reusing one instance across a jump would run every tick on the date the
    // loop started and nothing would ever happen.
    const b = await baaki({ origin });
    const report = await b.tick();
    if (report.lockHeld) {
      return json({
        error: "another pass is holding the ledger. A tick that was interrupted keeps the lock until it expires, up to five minutes. Try again shortly.",
      }, 409);
    }
    const actions = report.actions.map((a) => ({
      invoiceId: a.invoiceId,
      buyer: a.buyer,
      route: a.route,
      kind: a.action.kind,
      rung: a.action.kind === "send_nudge" ? a.action.rung : null,
      rationale: a.rationale,
      sent: a.sent ?? null,
      blocked: a.blocked ?? null,
      error: a.error ?? null,
      guardsFailed: a.guards.filter((g) => !g.pass).map((g) => g.name),
    }));
    passes.push({ date: report.today, jumped, actions });

    // Two passes over the same simulated day with nothing to show for either:
    // the clock is not moving and looping again would only repeat this pass.
    if (!jumped && report.today === lastTarget && report.sentCount === 0) break;
    lastTarget = report.today;

    // Something worth stopping on: a message went out, a call was placed, a
    // case changed hands, or a guard refused an action. Waiting does not count.
    happened = report.sentCount > 0
      || report.blockedCount > 0
      || report.actions.some((a) => !["none", "schedule_wait"].includes(a.action.kind));
  }

  const last = passes[passes.length - 1];
  return json({
    ok: true,
    jumped: passes.some((x) => x.jumped),
    offsetMs,
    daysAhead: Math.round(offsetMs / 86_400_000),
    simulatedDate: last?.date ?? istParts(Date.now() + offsetMs).date,
    looked: passes.length,
    quiet: !happened,
    nextDue,
    report: {
      // Every pass, flattened, so the days the agent chose to do nothing are
      // still on screen rather than silently skipped.
      actions: passes.flatMap((x) => x.actions.map((a) => ({ ...(a as object), on: x.date }))),
      sent: passes.reduce((n, x) => n + x.actions.filter((a) => (a as { sent: unknown }).sent).length, 0),
      blocked: passes.reduce((n, x) => n + x.actions.filter((a) => (a as { blocked: unknown }).blocked).length, 0),
    },
  });
}
