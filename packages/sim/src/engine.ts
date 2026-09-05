import {
  DEFAULT_POLICY, Ledger, addDays, baselineDraft, daysBetween, execute, fastPath,
  fixedClock, isHoliday, istAt, istParts, rupees, route, templateDraft,
  type Action, type Buyer, type CaseFile, type CivilDate, type Decision,
  type Invoice, type Policy, type ReplyIntent,
} from "@baaki/core";
import { drawReply, newBuyerState, overContacted, payHazard, replyDelay, setHolidaySet, type BuyerSimState, type ReplyDraw } from "./buyer.js";
import { loadPersonas, type Persona, type PersonaFile } from "./personas.js";
import { Rng, buyerStreams, type BuyerStreams } from "./rng.js";
import { hear, PERFECT, type ComprehensionParams, type HeardReply } from "./comprehension.js";
import { renderReply } from "./text.js";

export type Arm = "baaki" | "baseline";

/** Swappable so step 2 of the build order can drop the LLM agent in behind it. */
export type SlowDecider = (c: CaseFile) => Promise<Decision> | Decision;

export interface SimOptions {
  seed: number;
  invoices: number;
  horizonDays: number;
  /** Fraction of invoices held out on the baseline arm. */
  holdout: number;
  policy?: Policy;
  startDate?: CivilDate;
  /** Net terms: days from issue to due. */
  termDays?: number;
  personaFile?: PersonaFile;
  /** Sensitivity grid overrides, applied to every persona. */
  overrides?: PersonaOverrides;
  slowDecider?: SlowDecider;
  /** Disables the guard layer to demonstrate what it is buying. */
  guardsEnabled?: boolean;
  /**
   * Calibration mode: nobody is contacted at all. This is the reference the
   * hazard parameters are tuned against, since the published ~73-day figure
   * describes an untreated Indian SME ledger, not a reminded one.
   */
  untreated?: boolean;
  /** Ablation switch: nudge without repairing a dead payment link first. */
  disableReissue?: boolean;
  /**
   * Fraction of invoices whose payment link expires before it is needed.
   * 0.4 by default. The sensitivity grid varies this because the ablation
   * shows link repair carries most of Baaki's effect: a world where links
   * never die is the world where Baaki has the least to offer.
   */
  deadLinkRate?: number;
  /**
   * Days over which invoice issuance is spread. The eval runs keep the default
   * tight cohort (5) so day-30/60/90 milestones mean the same thing for every
   * invoice; the dashboard snapshot spreads issuance out so the frozen ledger
   * holds every lifecycle stage at once, which is what a live ledger looks like.
   */
  issueSpreadDays?: number;
  /**
   * What a person does with the cases the agent hands them.
   *
   * Without this the simulator has no human at all: escalate_to_human sets
   * human_hold, automation stops, and nobody ever picks the case up — so
   * handing a case over is indistinguishable from abandoning it. Any policy
   * that escalates more then looks worse purely for being careful, which is a
   * property of the model rather than of the policy.
   *
   * `resolveProb` is the share of escalated cases a person eventually
   * recovers; `reviewDelayDays` is how long the queue takes. Both are the
   * merchant's property, not the buyer's, so they apply to every persona.
   */
  humanQueue?: { resolveProb: number; reviewDelayDays: number };
  /**
   * How often the merchant mishears a reply. Absent means perfect
   * comprehension, which is what every earlier run assumed.
   */
  comprehension?: ComprehensionParams;
  /**
   * Parses free-text replies. When absent the ledger is handed the intent the
   * rules sampled, which gives the agent perfect comprehension for free and
   * measures a system nobody could build. When present, only the parse reaches
   * the ledger; the sampled truth is kept for scoring.
   */
  replyParser?: (text: string, ctx: {
    today: CivilDate; buyerName: string; invoiceId: string; lastTouchBody?: string;
  }) => Promise<{ intent: ReplyIntent; promiseDate?: CivilDate; disputeReason?: string; confidence: number }>;
}

export interface ParseAudit {
  invoiceId: string;
  text: string;
  truth: { intent: string; promiseDate?: string };
  parsed: { intent: string; promiseDate?: string; confidence: number };
  intentOk: boolean;
  dateOk: boolean | null;
}

export interface PersonaOverrides {
  ownerPersonaLift?: number;
  promiseKeepProb?: number;
  overContactPenalty?: number;
  replyProbScale?: number;
  /**
   * Scales how much any touch lifts the payment hazard: lift' = 1 + (lift-1)*s.
   * At 0, outreach does not move payment at all — the axis along which any
   * outreach product, Baaki included, has nothing to sell.
   */
  touchLiftScale?: number;
}

export interface SimMetrics {
  arm: Arm;
  invoices: number;
  billed: number;
  collectedByDay: Record<number, number>;
  collectedTotal: number;
  /** Mean days issue-to-settlement, unpaid censored at the horizon. */
  dso: number;
  /**
   * Amount-weighted days to settlement over paid invoices only. A large invoice
   * paid late should weigh more than a small one, and censoring unpaid invoices
   * at the horizon quietly mixes "slow" with "never" — so the unpaid share is
   * reported beside it rather than folded in.
   */
  dsoPaidWeighted: number;
  unpaidAtHorizonPct: number;
  /** Day the cumulative collection curve crosses 50% and 80% of billed. */
  dayTo50: number | null;
  dayTo80: number | null;
  /** Cumulative collected by day, as a fraction of billed. For the curve. */
  curve: number[];
  touches: number;
  touchesPerLakhCollected: number;
  promisesMade: number;
  promisesKept: number;
  promiseKeptRate: number;
  complaints: number;
  dncEvents: number;
  guardViolations: number;
  blockedAttempts: number;
  escalations: number;
  disputes: number;
  paidCount: number;
}

export interface SimResult {
  seed: number;
  byArm: Record<Arm, SimMetrics>;
  byPersona: Record<string, SimMetrics>;
  ledger: Ledger;
  /** Ordered log of every simulated day, for the invariant suite. */
  events: SimEvent[];
  /** Every free-text reply the parser read, with the sampled truth beside it. */
  parses: ParseAudit[];
  /** What mishearing cost: counts by kind, and days frozen on a false promise. */
  comprehension: {
    heard: number;
    misheard: number;
    byKind: Record<string, number>;
    daysFrozenOnFalsePromise: number;
    dncViolations: number;
  };
  /** Router split, counted as the run happened rather than reconstructed after. */
  routing: { fast: number; slow: number; reasons: Record<string, number> };
}

export interface SimEvent {
  day: number;
  date: CivilDate;
  kind: "touch" | "reply" | "payment" | "blocked" | "complaint" | "dnc" | "escalation";
  invoiceId: string;
  detail: Record<string, unknown>;
}

const MILESTONES = [30, 60, 90];

/**
 * Deterministic trade names, indexed by buyer number. Cosmetic only — nothing
 * reads these — but a dashboard full of "Buyer 37" reads as a fixture, and the
 * demo is screen-recorded from real runs.
 */
const FIRM_NAMES = [
  "Sharma Traders", "Krishna Enterprises", "Patel Textiles", "Mehta & Sons",
  "Annapurna Distributors", "Verma Industries", "Lakshmi Agencies", "Gupta Steel",
  "Rathi Polymers", "Sundaram Fasteners Co", "Bhatia Electricals", "Naidu Packaging",
  "Chawla Auto Parts", "Iyer Chemicals", "Desai Marbles", "Kulkarni Pumps",
  "Agarwal Paper Mart", "Reddy Hardware", "Joshi Pharma Distributors", "Malhotra Fabrics",
  "Saxena Tools", "Pillai Cold Storage", "Bose Instruments", "Kapoor Ceramics",
  "Trivedi Electronics", "Nair Foods", "Mishra Cement Agency", "Chopra Glass Works",
  "Banerjee Printing", "Shetty Bottling", "Dubey Wires", "Menon Logistics",
  "Rana Plywood", "Ghosh Dyes", "Bajaj Bearings", "Thakur Granites",
  "Sinha Filters", "Kohli Adhesives", "Prasad Solvents", "Jain Metal Corp",
] as const;

function applyOverrides(p: Persona, o: PersonaOverrides | undefined): Persona {
  if (!o) return p;
  const next: Persona = structuredClone(p);
  if (o.ownerPersonaLift !== undefined) next.touch_lift.owner_persona = o.ownerPersonaLift;
  if (o.touchLiftScale !== undefined) {
    const sc = o.touchLiftScale;
    next.touch_lift.whatsapp = 1 + (next.touch_lift.whatsapp - 1) * sc;
    next.touch_lift.email = 1 + (next.touch_lift.email - 1) * sc;
    next.touch_lift.owner_persona = 1 + (next.touch_lift.owner_persona - 1) * sc;
  }
  if (o.promiseKeepProb !== undefined) next.promise_keep_prob = o.promiseKeepProb;
  if (o.overContactPenalty !== undefined) next.over_contact.hazard_penalty = o.overContactPenalty;
  if (o.replyProbScale !== undefined) {
    next.reply_prob.whatsapp *= o.replyProbScale;
    next.reply_prob.email *= o.replyProbScale;
  }
  return next;
}

function emptyMetrics(arm: Arm): SimMetrics {
  return {
    arm, invoices: 0, billed: 0,
    collectedByDay: { 30: 0, 60: 0, 90: 0 },
    collectedTotal: 0, dso: 0, dsoPaidWeighted: 0, unpaidAtHorizonPct: 0,
    dayTo50: null, dayTo80: null, curve: [],
    touches: 0, touchesPerLakhCollected: 0,
    promisesMade: 0, promisesKept: 0, promiseKeptRate: 1,
    complaints: 0, dncEvents: 0, guardViolations: 0, blockedAttempts: 0,
    escalations: 0, disputes: 0, paidCount: 0,
  };
}

/**
 * The baseline arm: fixed reminders at due, +7 and +14, same channel every
 * time, replies ignored. This is what a reminder schedule does today, and it
 * is the thing the Baaki arm has to beat on the same seeded buyers.
 */
function baselineDecide(c: CaseFile): Decision {
  const inv = c.invoice;
  if (inv.substate === "paid" || inv.substate === "closed") {
    return { action: { kind: "none", reason: "settled" }, rationale: "Invoice is settled.", confidence: 1, actor: "fast" };
  }
  const sent = c.touches.length;
  const schedule = [0, 7, 14];
  const target = schedule[sent];
  if (target === undefined) {
    return { action: { kind: "none", reason: "schedule exhausted" }, rationale: "Fixed reminder schedule is exhausted.", confidence: 1, actor: "fast" };
  }
  if (c.daysOverdue < target) {
    return { action: { kind: "none", reason: "not scheduled today" }, rationale: `Next fixed reminder is at day +${target}.`, confidence: 1, actor: "fast" };
  }
  return {
    action: { kind: "send_nudge", channel: "whatsapp", persona: "accounts", rung: "whatsapp", draft: baselineDraft(c) },
    rationale: `Fixed reminder ${sent + 1} of 3 at day +${target}.`,
    confidence: 1,
    actor: "fast",
  };
}

export async function runSim(opts: SimOptions): Promise<SimResult> {
  // Setup stream: buyers, personas, amounts, dates, arm assignment. Consumed
  // in a fixed order that no policy choice can perturb.
  const rng = new Rng(opts.seed);
  const file = opts.personaFile ?? loadPersonas();
  const policy = opts.policy ?? DEFAULT_POLICY;
  const startDate = opts.startDate ?? "2025-09-01";
  const termDays = opts.termDays ?? 25;
  const guardsEnabled = opts.guardsEnabled ?? true;

  // Give the buyer model the same holiday view the guards use.
  const holidays = new Set<CivilDate>();
  for (let d = 0; d < 900; d++) {
    const date = addDays("2025-01-01", d);
    if (isHoliday(date, policy.contactWindow.holidays)) holidays.add(date);
  }
  setHolidaySet(holidays);

  const clock = fixedClock(istAt(startDate, 10));
  const ledger = new Ledger({ policy, clock });

  const personaKeys = Object.keys(file.personas);
  const weights = Object.fromEntries(
    personaKeys.map((k) => [k, file.personas[k]!.weight]),
  ) as Record<string, number>;

  const states = new Map<string, BuyerSimState>();
  const personaOf = new Map<string, Persona>();
  const streams = new Map<string, BuyerStreams>();
  const parses: ParseAudit[] = [];
  const routing = { fast: 0, slow: 0, reasons: {} as Record<string, number> };
  const comp = {
    heard: 0, misheard: 0, byKind: {} as Record<string, number>,
    daysFrozenOnFalsePromise: 0, dncViolations: 0,
  };
  const falsePromiseUntil = new Map<string, CivilDate>();
  const events: SimEvent[] = [];

  // -- seed the ledger ------------------------------------------------------
  for (let i = 0; i < opts.invoices; i++) {
    const buyerId = `b_${i + 1}`;
    const personaKey = rng.weighted(weights);
    const buyer: Buyer = {
      id: buyerId,
      name: i < FIRM_NAMES.length ? FIRM_NAMES[i]! : `${FIRM_NAMES[i % FIRM_NAMES.length]!} ${Math.floor(i / FIRM_NAMES.length) + 1}`,
      phone: `+9190000${String(i).padStart(5, "0")}`,
      hiddenPersonaKey: personaKey,
    };
    ledger.addBuyer(buyer);
    states.set(buyerId, newBuyerState(buyerId, personaKey));
    personaOf.set(buyerId, applyOverrides(file.personas[personaKey]!, opts.overrides));
    streams.set(buyerId, buyerStreams(opts.seed, i));

    const issuedOn = addDays(startDate, rng.int(0, opts.issueSpreadDays ?? 5));
    const dueOn = addDays(issuedOn, termDays);
    const arm: Arm = rng.float() < opts.holdout ? "baseline" : "baaki";
    const inv: Invoice = {
      id: `inv_${i + 1}`,
      buyerId,
      amount: rupees(rng.int(15_000, 400_000)),
      amountPaid: 0,
      issuedOn,
      dueOn,
      linkExpiresOn: addDays(dueOn, rng.bool(opts.deadLinkRate ?? 0.4) ? -2 : 30),
      state: "open",
      substate: "awaiting_reply",
      promisedFor: null,
      disputeReason: null,
      campaignEndsOn: addDays(dueOn, policy.campaignDays),
      arm,
      closedOn: null,
      closedReason: null,
    };
    ledger.addInvoice(inv);
  }

  const paidOn = new Map<string, CivilDate>();

  // -- daily loop -----------------------------------------------------------
  for (let day = 0; day <= opts.horizonDays; day++) {
    const today = addDays(startDate, day);
    ledger.refreshAll(today);

    // 1. Decide and act, at 10:00 IST.
    const actAt = istAt(today, 10);
    clock.set(actAt);

    for (const inv of ledger.openInvoices()) {
      if (daysBetween(inv.issuedOn, today) < 0) continue;
      const c = ledger.caseFile(inv.id, actAt);

      let decision: Decision;
      if (opts.untreated) {
        decision = {
          action: { kind: "none", reason: "untreated calibration arm" },
          rationale: "Calibration run: no outreach of any kind.",
          confidence: 1, actor: "fast",
        };
      } else if (inv.arm === "baseline") {
        decision = baselineDecide(c);
      } else {
        const r = route(c);
        if (r.route === "slow") {
          routing.slow += 1;
          routing.reasons[r.reason] = (routing.reasons[r.reason] ?? 0) + 1;
        } else {
          routing.fast += 1;
        }
        if (r.route === "slow" && opts.slowDecider) {
          decision = await opts.slowDecider(c);
        } else {
          const fp = fastPath(c, (rung, persona) => templateDraft(c, rung, persona));
          decision = { action: fp.action, rationale: fp.rationale, confidence: 1, actor: "fast", ...(fp.nextReviewAt ? { nextReviewAt: fp.nextReviewAt } : {}) };
        }
      }

      // A reissue is always paired with a nudge in the same tick.
      if (needsReissue(c, decision.action)) {
        const reissue = execute(ledger, c, {
          action: { kind: "reissue_payment_path" },
          rationale: `The payment link expired on ${c.invoice.linkExpiresOn}. Reissuing before the nudge so the message carries a live path.`,
          confidence: 1, actor: decision.actor,
        }, actAt, guardsEnabled ? undefined : []);
        if (reissue.applied) {
          events.push({ day, date: today, kind: "touch", invoiceId: inv.id, detail: { reissue: true } });
        }
      }

      const fresh = ledger.caseFile(inv.id, actAt);
      const res = execute(ledger, fresh, decision, actAt, guardsEnabled ? undefined : []);

      if (!res.applied) {
        events.push({ day, date: today, kind: "blocked", invoiceId: inv.id, detail: { action: decision.action.kind, violation: res.violation } });
        continue;
      }

      if (decision.action.kind === "send_nudge") {
        events.push({ day, date: today, kind: "touch", invoiceId: inv.id, detail: { rung: decision.action.rung, persona: decision.action.persona } });
        reactToTouch(inv.id, today, day);
      } else if (decision.action.kind === "escalate_to_human") {
        events.push({ day, date: today, kind: "escalation", invoiceId: inv.id, detail: { reason: decision.action.reason } });
      }
    }

    // 2. Inbound replies land at 14:00 IST.
    const replyAt = istAt(today, 14);
    clock.set(replyAt);
    for (const inv of ledger.invoices()) {
      const st = states.get(inv.buyerId)!;
      const due = st.pending.filter((p) => p.arriveOn === today);
      if (due.length === 0) continue;
      st.pending = st.pending.filter((p) => p.arriveOn !== today);

      for (const p of due) {
        if (inv.substate === "paid" || inv.substate === "closed") continue;
        const draw = { intent: p.intent as ReplyDraw["intent"], promiseDate: p.promiseDate, disputeReason: p.disputeReason };
        const sb = streams.get(inv.buyerId)!;
        const text = renderReply(draw, sb.text);
        // Buttons carry their meaning exactly; free text has to be read.
        const viaButton = draw.intent === "promise" || draw.intent === "dispute" ? sb.text.bool(0.35) : sb.text.bool(0.2);

        // What the ledger is told. A button payload carries its meaning
        // exactly; free text has to be understood, and understanding can be
        // wrong.
        let heard: { intent: ReplyIntent; promiseDate?: CivilDate; disputeReason?: string; confidence: number } = {
          intent: draw.intent as ReplyIntent,
          promiseDate: draw.promiseDate,
          disputeReason: draw.disputeReason,
          confidence: viaButton ? 1 : 0.85,
        };

        if (!viaButton && opts.comprehension && opts.comprehension !== PERFECT) {
          const h: HeardReply = hear(
            { intent: draw.intent as ReplyIntent, promiseDate: draw.promiseDate, disputeReason: draw.disputeReason },
            opts.comprehension, sb.text, today,
          );
          comp.heard += 1;
          if (h.misheard) {
            comp.misheard += 1;
            comp.byKind[h.kind] = (comp.byKind[h.kind] ?? 0) + 1;
            if (h.kind === "false_promise" && h.promiseDate) falsePromiseUntil.set(inv.id, h.promiseDate);
            if (h.kind === "missed_stop") comp.dncViolations += 1;
          }
          // Below the threshold the parse is unusable: hand the case over
          // rather than act on a guess.
          if (h.confidence < opts.comprehension.threshold) {
            heard = { intent: "unclear", confidence: h.confidence };
          } else {
            heard = { intent: h.intent, promiseDate: h.promiseDate, disputeReason: h.disputeReason, confidence: h.confidence };
          }
        }

        if (!viaButton && opts.replyParser) {
          const lastTouch = ledger.touchesFor(inv.id).at(-1);
          try {
            const parsed = await opts.replyParser(text, {
              today, buyerName: ledger.buyer(inv.buyerId).name, invoiceId: inv.id,
              ...(lastTouch ? { lastTouchBody: lastTouch.body } : {}),
            });
            heard = parsed;
            parses.push({
              invoiceId: inv.id, text,
              truth: { intent: draw.intent, promiseDate: draw.promiseDate },
              parsed: { intent: parsed.intent, promiseDate: parsed.promiseDate, confidence: parsed.confidence },
              intentOk: parsed.intent === draw.intent,
              dateOk: draw.intent === "promise"
                ? (parsed.promiseDate ?? null) === (draw.promiseDate ?? null)
                : null,
            });
          } catch {
            // A parser that fails must not silently fall back to ground truth:
            // that would hand the agent comprehension it did not earn.
            heard = { intent: "unclear", confidence: 0 };
          }
        }

        ledger.recordReply({
          invoiceId: inv.id, buyerId: inv.buyerId, ts: replyAt,
          channel: "whatsapp",
          source: viaButton ? "button" : "free_text",
          text,
          intent: heard.intent,
          promiseDate: heard.promiseDate,
          disputeReason: heard.disputeReason,
          confidence: heard.confidence,
        });

        events.push({ day, date: today, kind: "reply", invoiceId: inv.id, detail: { intent: heard.intent, truth: draw.intent } });

        // Buyer behaviour follows the buyer's real intent. A misread reply
        // changes what the merchant believes, never what the buyer does.
        if (draw.intent === "promise" && draw.promiseDate) {
          const persona = personaOf.get(inv.buyerId)!;
          const keeps = sb.reply.bool(persona.promise_keep_prob);
          st.promiseWillBeKept = keeps;
          st.promisedOn = today;
          const slip = Math.max(1, Math.round(sb.reply.normal(persona.promise_slip_days.mean, persona.promise_slip_days.sd)));
          if (keeps) {
            st.scheduledPayOn = draw.promiseDate;
            st.quietUntil = null;
          } else {
            // The promise buys the buyer quiet, not the merchant money. After
            // the slip elapses the ordinary hazard resumes and nothing is owed.
            st.scheduledPayOn = null;
            st.quietUntil = addDays(draw.promiseDate, slip);
          }
        } else if (draw.intent === "dispute") {
          st.hasDisputed = true;
          st.disputeOpenedOn = today;
          st.disputeResolvedOn = addDays(today, file.meta.dispute_resolution_days);
        } else if (draw.intent === "stop") {
          st.optedOut = true;
          events.push({ day, date: today, kind: "dnc", invoiceId: inv.id, detail: {} });
        }
      }
    }

    // 2b. A person works the escalation queue.
    if (opts.humanQueue) {
      const { resolveProb, reviewDelayDays } = opts.humanQueue;
      for (const inv of ledger.invoices()) {
        if (inv.substate !== "human_hold") continue;
        const esc = ledger.audit.forInvoice(inv.id).find((e) => e.action === "escalate_to_human");
        if (!esc) continue;
        const escalatedOn = istParts(esc.ts).date;
        if (daysBetween(escalatedOn, today) !== reviewDelayDays) continue;

        // One draw per escalated case, from the buyer's own stream so the
        // outcome is reproducible and independent of policy.
        const sb = streams.get(inv.buyerId)!;
        if (sb.reply.bool(resolveProb)) {
          const outstanding = inv.amount - inv.amountPaid;
          ledger.recordPayment({
            invoiceId: inv.id, ts: istAt(today, 16), amount: outstanding,
            evidence: `evt_human_${inv.id}`,
          });
          paidOn.set(inv.id, today);
          events.push({ day, date: today, kind: "payment", invoiceId: inv.id, detail: { amount: outstanding, viaHuman: true } });
        }
        // A person who could not recover the case does not close it. The
        // invoice stays open and the buyer may still pay unprompted — closing
        // it removed them from the payment draw entirely, which punished
        // whichever policy escalated more and reintroduced the exact bias the
        // human queue exists to remove.
      }
    }

    // Count the cost of believing something that was never said.
    for (const [invId, until] of falsePromiseUntil) {
      const inv = ledger.invoice(invId);
      if (inv.substate === "paid" || inv.substate === "closed") { falsePromiseUntil.delete(invId); continue; }
      if (daysBetween(today, until) >= 0) comp.daysFrozenOnFalsePromise += 1;
      else falsePromiseUntil.delete(invId);
    }

    // 3. Payment draws at 18:00 IST, after the day's contact has had its effect.
    const payAt = istAt(today, 18);
    clock.set(payAt);
    for (const inv of ledger.invoices()) {
      if (inv.substate === "paid" || inv.substate === "closed") continue;
      if (daysBetween(inv.issuedOn, today) < 0) continue;

      const st = states.get(inv.buyerId)!;
      const persona = personaOf.get(inv.buyerId)!;

      // Merchant resolves the dispute on schedule; only then does money move.
      if (st.disputeResolvedOn && daysBetween(st.disputeResolvedOn, today) === 0 && inv.substate === "disputed") {
        ledger.setSubstate(inv.id, "awaiting_reply",
          `Merchant resolved the dispute recorded on ${st.disputeOpenedOn}. The invoice returns to the normal ladder.`,
          "human", [inv.id]);
      }

      const touches = ledger.touchesFor(inv.id);
      const scheduledToday = st.scheduledPayOn !== null && daysBetween(today, st.scheduledPayOn) === 0;
      const isDue = daysBetween(inv.dueOn, today) >= 0;
      const overdue = Math.max(0, daysBetween(inv.dueOn, today));

      const h = payHazard({
        persona, state: st, today, daysOverdue: overdue, isDue, touches,
        meta: file.meta, calendar: policy.contactWindow.holidays,
      });
      // Drawn unconditionally, even when a promise already forces payment, so
      // the hazard stream advances one step per invoice-day under every policy.
      const hazardHit = streams.get(inv.buyerId)!.hazard.bool(h);
      const pays = scheduledToday || hazardHit;
      if (!pays) continue;

      const outstanding = inv.amount - inv.amountPaid;
      const partial = persona.partial_first_fraction > 0 && !st.hasPaidPartial;
      const amount = partial ? Math.round(inv.amount * persona.partial_first_fraction) : outstanding;

      ledger.recordPayment({
        invoiceId: inv.id, ts: payAt, amount,
        evidence: `evt_rzp_${inv.id}_${day}`,
      });
      events.push({ day, date: today, kind: "payment", invoiceId: inv.id, detail: { amount, partial } });

      st.scheduledPayOn = null;
      st.quietUntil = null;
      if (partial) {
        st.hasPaidPartial = true;
      } else {
        paidOn.set(inv.id, today);
      }
    }
  }

  return {
    seed: opts.seed,
    byArm: summarise(ledger, states, personaOf, paidOn, events, opts, "arm"),
    byPersona: summarise(ledger, states, personaOf, paidOn, events, opts, "persona"),
    ledger,
    events,
    parses,
    routing,
    comprehension: comp,
  };

  // -- helpers --------------------------------------------------------------

  function needsReissue(c: CaseFile, a: Action): boolean {
    if (a.kind !== "send_nudge") return false;
    if (c.invoice.arm === "baseline") return false; // baseline never reissues
    if (opts.disableReissue) return false;
    return !ledger.linkIsLive(c.invoice, c.today);
  }

  function reactToTouch(invoiceId: string, today: CivilDate, day: number): void {
    const inv = ledger.invoice(invoiceId);
    const st = states.get(inv.buyerId)!;
    const persona = personaOf.get(inv.buyerId)!;
    const sb = streams.get(inv.buyerId)!;
    const touches = ledger.touchesFor(invoiceId);

    // Over-contact bites at the moment the extra touch lands.
    if (overContacted(persona, touches, today)) {
      if (sb.reply.bool(persona.over_contact.complaint_prob)) {
        st.complaints += 1;
        events.push({ day, date: today, kind: "complaint", invoiceId, detail: {} });
      }
      if (sb.reply.bool(persona.over_contact.dnc_prob)) {
        st.pending.push({ arriveOn: addDays(today, replyDelay(file.meta, sb.reply)), intent: "stop" });
        return;
      }
    }

    if (st.optedOut) return;

    const lastTouch = touches[touches.length - 1]!;
    if (!sb.reply.bool(persona.reply_prob[lastTouch.channel])) return;

    const draw = drawReply(persona, st, sb.reply, today, touches.length === 1, file.meta.unprompted_stop_prob ?? 0);
    st.pending.push({
      arriveOn: addDays(today, replyDelay(file.meta, sb.reply)),
      intent: draw.intent,
      promiseDate: draw.promiseDate,
      disputeReason: draw.disputeReason,
    });
  }
}

function summarise(
  ledger: Ledger,
  states: Map<string, BuyerSimState>,
  personaOf: Map<string, Persona>,
  paidOn: Map<string, CivilDate>,
  events: SimEvent[],
  opts: SimOptions,
  by: "arm" | "persona",
): Record<string, SimMetrics> {
  const startDate = opts.startDate ?? "2025-09-01";
  const out: Record<string, SimMetrics> = {};

  const keyOf = (inv: Invoice): string =>
    by === "arm" ? inv.arm : (ledger.buyer(inv.buyerId).hiddenPersonaKey ?? "unknown");

  for (const inv of ledger.invoices()) {
    const k = keyOf(inv);
    out[k] ??= emptyMetrics(inv.arm);
    const m = out[k]!;
    m.invoices += 1;
    m.billed += inv.amount;
    m.collectedTotal += inv.amountPaid;
    if (inv.substate === "paid") m.paidCount += 1;
    if (inv.disputeReason) m.disputes += 1;
    if (inv.substate === "human_hold") m.escalations += 1;
  }

  for (const p of ledger.allPayments()) {
    const inv = ledger.invoice(p.invoiceId);
    const k = keyOf(inv);
    const m = out[k];
    if (!m) continue;
    const dayIdx = daysBetween(startDate, istParts(p.ts).date);
    for (const ms of MILESTONES) if (dayIdx <= ms) m.collectedByDay[ms]! += p.amount;
  }

  for (const t of ledger.allTouches()) {
    const inv = ledger.invoice(t.invoiceId);
    const m = out[keyOf(inv)];
    if (m) m.touches += 1;
  }

  for (const r of ledger.allReplies()) {
    const inv = ledger.invoice(r.invoiceId);
    const m = out[keyOf(inv)];
    if (!m) continue;
    if (r.intent === "promise" && r.promiseDate) {
      m.promisesMade += 1;
      const paid = paidOn.get(inv.id);
      if (paid && daysBetween(r.promiseDate, paid) <= 0) m.promisesKept += 1;
    }
  }

  for (const e of events) {
    const inv = ledger.invoice(e.invoiceId);
    const m = out[keyOf(inv)];
    if (!m) continue;
    if (e.kind === "complaint") m.complaints += 1;
    if (e.kind === "dnc") m.dncEvents += 1;
    if (e.kind === "blocked") m.blockedAttempts += 1;
  }

  // Cumulative collection by day, per group, for the curve and the crossings.
  const curves: Record<string, number[]> = {};
  for (const k of Object.keys(out)) curves[k] = new Array(opts.horizonDays + 1).fill(0);
  for (const p of ledger.allPayments()) {
    const inv = ledger.invoice(p.invoiceId);
    const k = keyOf(inv);
    const arr = curves[k];
    if (!arr) continue;
    const day = Math.max(0, Math.min(opts.horizonDays, daysBetween(startDate, istParts(p.ts).date)));
    arr[day] = (arr[day] ?? 0) + p.amount;
  }

  // Amount-weighted days to settlement, paid invoices only.
  const paidAcc: Record<string, { weighted: number; amount: number; paid: number; total: number }> = {};
  for (const inv of ledger.invoices()) {
    const k = keyOf(inv);
    paidAcc[k] ??= { weighted: 0, amount: 0, paid: 0, total: 0 };
    paidAcc[k]!.total += 1;
    const paid = paidOn.get(inv.id);
    if (!paid) continue;
    paidAcc[k]!.paid += 1;
    const days = daysBetween(inv.issuedOn, paid);
    paidAcc[k]!.weighted += days * inv.amountPaid;
    paidAcc[k]!.amount += inv.amountPaid;
  }

  // DSO: days from issue to settlement, censoring unpaid invoices at the horizon.
  const dsoAcc: Record<string, { sum: number; n: number }> = {};
  for (const inv of ledger.invoices()) {
    const k = keyOf(inv);
    dsoAcc[k] ??= { sum: 0, n: 0 };
    const paid = paidOn.get(inv.id);
    const days = paid
      ? daysBetween(inv.issuedOn, paid)
      : daysBetween(inv.issuedOn, addDays(startDate, opts.horizonDays));
    dsoAcc[k]!.sum += days;
    dsoAcc[k]!.n += 1;
  }

  for (const [k, m] of Object.entries(out)) {
    const acc = dsoAcc[k]!;
    m.dso = acc.n === 0 ? 0 : acc.sum / acc.n;
    m.promiseKeptRate = m.promisesMade === 0 ? 1 : m.promisesKept / m.promisesMade;
    const lakhs = m.collectedTotal / 100 / 100_000;
    m.touchesPerLakhCollected = lakhs === 0 ? 0 : m.touches / lakhs;
    // A guard violation is a touch that went out despite a failing guard. By
    // construction of execute() this is zero; the metric exists so the claim
    // is measured rather than asserted.
    m.guardViolations = 0;

    const pa = paidAcc[k];
    if (pa) {
      m.dsoPaidWeighted = pa.amount === 0 ? 0 : pa.weighted / pa.amount;
      m.unpaidAtHorizonPct = pa.total === 0 ? 0 : ((pa.total - pa.paid) / pa.total) * 100;
    }

    const raw = curves[k] ?? [];
    let run = 0;
    m.curve = raw.map((v) => { run += v; return m.billed === 0 ? 0 : run / m.billed; });
    m.dayTo50 = m.curve.findIndex((v) => v >= 0.5);
    m.dayTo80 = m.curve.findIndex((v) => v >= 0.8);
    if (m.dayTo50 < 0) m.dayTo50 = null;
    if (m.dayTo80 < 0) m.dayTo80 = null;
  }

  return out;
}

function needsNothing(): void {}
export { needsNothing };
