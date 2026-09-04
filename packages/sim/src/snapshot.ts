/**
 * Freezes a sim run at a chosen day and emits the state the dashboard renders.
 * Nothing in the JSON is authored: proposals come from the real router, policy
 * and guards; timelines come from the ledger and audit log of the run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  fastPath, istAt, route, runGuards, templateDraft, addDays,
  type Action, type BuyerMemory, type CaseFile, type GuardResult, type Invoice, type Rung,
} from "@baaki/core";
import { runSim, type SimResult } from "./engine.js";

export interface TimelineEvent {
  ts: number;
  type: "touch" | "reply" | "payment" | "decision";
  id: string;
  summary: string;
  detail: Record<string, unknown>;
  evidence: string[];
}

export interface StorySentence {
  text: string;
  /** Event ids this sentence is derived from. A sentence with no citation is dropped. */
  cites: string[];
}

export interface CaseView {
  invoice: Invoice;
  buyer: { id: string; name: string; phone: string };
  memory: BuyerMemory;
  daysOverdue: number;
  outstanding: number;
  nextRung: Rung;
  proposal: {
    route: "fast" | "slow";
    routeReason: string;
    action: Action;
    rationale: string;
    guards: GuardResult[];
    allowed: boolean;
  };
  story: StorySentence[];
  timeline: TimelineEvent[];
}

export interface Snapshot {
  seed: number;
  day: number;
  date: string;
  generatedBy: string;
  totals: {
    invoices: number;
    open: number;
    overdue: number;
    outstanding: number;
    billed: number;
    collected: number;
    onPromise: number;
    disputed: number;
    humanHold: number;
  };
  cases: CaseView[];
}

function buildTimeline(r: SimResult, invoiceId: string): TimelineEvent[] {
  const ledger = r.ledger;
  const events: TimelineEvent[] = [];

  for (const t of ledger.touchesFor(invoiceId)) {
    events.push({
      ts: t.ts, type: "touch", id: t.id,
      summary: `${t.persona === "owner" ? "Owner" : "Accounts"} nudge on ${t.channel} (rung ${t.rung})${t.carriedLiveLink ? "" : ", link was dead"}`,
      detail: { channel: t.channel, persona: t.persona, rung: t.rung, carriedLiveLink: t.carriedLiveLink, body: t.body },
      evidence: [t.id],
    });
  }
  for (const reply of ledger.repliesFor(invoiceId)) {
    events.push({
      ts: reply.ts, type: "reply", id: reply.id,
      summary: `Buyer replied via ${reply.source === "button" ? "button" : "free text"}: ${reply.intent}${reply.promiseDate ? ` (by ${reply.promiseDate})` : ""}`,
      detail: { source: reply.source, text: reply.text, intent: reply.intent, promiseDate: reply.promiseDate ?? null, disputeReason: reply.disputeReason ?? null, confidence: reply.confidence },
      evidence: [reply.id],
    });
  }
  for (const p of ledger.paymentsFor(invoiceId)) {
    events.push({
      ts: p.ts, type: "payment", id: p.id,
      summary: `Payment received`,
      detail: { amount: p.amount, webhook: p.evidence },
      evidence: [p.evidence, p.id],
    });
  }
  for (const a of ledger.audit.forInvoice(invoiceId)) {
    // Touches already appear above with their body; keep decision entries that add information.
    if (a.action === "send_nudge") continue;
    events.push({
      ts: a.ts, type: "decision", id: a.id,
      summary: `${a.actor}: ${a.action.replace(/_/g, " ")}`,
      detail: { actor: a.actor, action: a.action, params: a.params, rationale: a.rationale, guards: a.guards, policyVersion: a.policyVersion },
      evidence: a.evidence,
    });
  }

  return events.sort((x, y) => x.ts - y.ts);
}

/**
 * Deterministic story-so-far. Three sentences, each citing the events it is
 * derived from; the LLM version that replaces this must obey the same rule.
 */
function buildStory(c: CaseFile, timeline: TimelineEvent[]): StorySentence[] {
  const s: StorySentence[] = [];
  const inv = c.invoice;

  s.push({
    text: `Invoice ${inv.id} for ${fmtL(inv.amount)} was issued on ${inv.issuedOn} and fell due on ${inv.dueOn}; it is ${c.daysOverdue} days overdue with ${fmtL(inv.amount - inv.amountPaid)} outstanding.`,
    cites: [inv.id],
  });

  const touches = timeline.filter((e) => e.type === "touch");
  const replies = timeline.filter((e) => e.type === "reply");
  if (touches.length || replies.length) {
    const lastReply = replies[replies.length - 1];
    s.push({
      text: `${touches.length} touch${touches.length === 1 ? "" : "es"} sent, ${replies.length} repl${replies.length === 1 ? "y" : "ies"} received${lastReply ? `; the last reply read as "${(lastReply.detail.intent as string).replace(/_/g, " ")}"` : ""}.`,
      cites: [...touches.map((e) => e.id), ...replies.map((e) => e.id)].slice(0, 8),
    });
  }

  if (inv.substate === "promised" && inv.promisedFor) {
    const ev = replies.filter((e) => e.detail.promiseDate).pop();
    s.push({ text: `The buyer has promised payment by ${inv.promisedFor}; outreach is frozen until the day after.`, cites: ev ? [ev.id] : [inv.id] });
  } else if (inv.substate === "disputed") {
    const ev = replies.filter((e) => e.detail.intent === "dispute").pop();
    s.push({ text: `A dispute is open (${inv.disputeReason}); outreach is frozen and the merchant has been notified.`, cites: ev ? [ev.id] : [inv.id] });
  } else if (inv.substate === "human_hold") {
    const ev = timeline.filter((e) => e.type === "decision" && e.detail.action === "escalate_to_human").pop();
    s.push({ text: `The case is with a human; automated outreach has ended.`, cites: ev ? [ev.id] : [inv.id] });
  } else if (inv.substate === "paid") {
    const ev = timeline.filter((e) => e.type === "payment").pop();
    s.push({ text: `Paid in full on ${inv.closedOn}; the campaign is closed.`, cites: ev ? [ev.id] : [inv.id] });
  } else {
    s.push({ text: `Next rung on the ladder is ${c.nextRung.replace(/_/g, " ")}, guard-checked before anything sends.`, cites: [inv.id] });
  }

  return s.filter((x) => x.cites.length > 0);
}

const fmtL = (paise: number): string => {
  const r = paise / 100;
  if (r >= 100000) return `₹${(r / 100000).toFixed(2).replace(/\.00$/, "")}L`;
  return `₹${r.toLocaleString("en-IN")}`;
};

export interface SnapshotOptions {
  seed: number;
  invoices: number;
  day: number;
  out: string;
  issueSpreadDays?: number;
}

export async function makeSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
  const startDate = "2025-09-01";
  const r = await runSim({
    seed: opts.seed, invoices: opts.invoices, horizonDays: opts.day, holdout: 0,
    issueSpreadDays: opts.issueSpreadDays ?? 50,
  });
  const date = addDays(startDate, opts.day);
  const decideAt = istAt(addDays(date, 1), 10);

  const cases: CaseView[] = [];
  const totals = {
    invoices: 0, open: 0, overdue: 0, outstanding: 0, billed: 0, collected: 0,
    onPromise: 0, disputed: 0, humanHold: 0,
  };

  for (const inv of r.ledger.invoices()) {
    totals.invoices += 1;
    totals.billed += inv.amount;
    totals.collected += inv.amountPaid;

    const c = r.ledger.caseFile(inv.id, decideAt);
    const timeline = buildTimeline(r, inv.id);

    const open = inv.substate !== "paid" && inv.substate !== "closed";
    if (open) {
      totals.open += 1;
      totals.outstanding += inv.amount - inv.amountPaid;
      if (c.daysOverdue > 0) totals.overdue += 1;
      if (inv.substate === "promised") totals.onPromise += 1;
      if (inv.substate === "disputed") totals.disputed += 1;
      if (inv.substate === "human_hold") totals.humanHold += 1;
    }

    const rd = route(c);
    const fp = fastPath(c, (rung, persona) => templateDraft(c, rung, persona));
    const verdict = runGuards(c, fp.action, decideAt);

    cases.push({
      invoice: inv,
      buyer: { id: c.buyer.id, name: c.buyer.name, phone: c.buyer.phone },
      memory: c.memory,
      daysOverdue: c.daysOverdue,
      outstanding: inv.amount - inv.amountPaid,
      nextRung: c.nextRung,
      proposal: {
        route: rd.route,
        routeReason: rd.reason,
        action: fp.action,
        rationale: fp.rationale,
        guards: verdict.results,
        allowed: verdict.allowed,
      },
      story: buildStory(c, timeline),
      timeline,
    });
  }

  const snap: Snapshot = {
    seed: opts.seed,
    day: opts.day,
    date,
    generatedBy: "packages/sim/src/snapshot.ts",
    totals,
    cases,
  };

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(snap, null, 2));
  return snap;
}
