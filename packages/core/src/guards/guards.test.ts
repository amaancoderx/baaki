import { describe, expect, it } from "vitest";
import { istAt, addDays } from "../time.js";
import { DEFAULT_POLICY, type Action, type CaseFile, type Invoice, type Reply, type Touch } from "../types.js";
import { emptyMemory } from "../memory.js";
import {
  campaignEnd, contactWindow, doNotContact, draftFilter, maxTouches, minGap,
  noContactWhileHeld, runGuards, stopOnPaid, whatsappSessionWindow,
} from "./index.js";

const TODAY = "2025-11-12"; // a Wednesday, not a holiday in IN-KA

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv_1", buyerId: "b_1", amount: 18_000_000, amountPaid: 0,
    issuedOn: "2025-09-01", dueOn: "2025-09-26", linkExpiresOn: "2025-12-01",
    state: "overdue", substate: "awaiting_reply", promisedFor: null, disputeReason: null,
    campaignEndsOn: "2025-12-25", arm: "baaki", closedOn: null, closedReason: null,
    ...over,
  };
}

function caseFile(over: Partial<CaseFile> = {}): CaseFile {
  const inv = over.invoice ?? invoice();
  return {
    today: TODAY,
    nowMs: istAt(TODAY, 11),
    invoice: inv,
    buyer: { id: "b_1", name: "Sharma Traders", phone: "+919000000001" },
    memory: emptyMemory("b_1"),
    touches: [], replies: [], payments: [],
    daysOverdue: 47, nextRung: "whatsapp", lastDecisionTs: null, nextReviewOn: null, policy: DEFAULT_POLICY,
    ...over,
  };
}

const nudge = (over: Partial<Extract<Action, { kind: "send_nudge" }>> = {}): Action => ({
  kind: "send_nudge", channel: "whatsapp", persona: "accounts", rung: "whatsapp",
  draft: "Invoice is overdue, here is the link.", ...over,
});

const touch = (over: Partial<Touch> = {}): Touch => ({
  id: "t_1", invoiceId: "inv_1", buyerId: "b_1", ts: istAt(TODAY, 10),
  channel: "whatsapp", persona: "accounts", rung: "whatsapp", carriedLiveLink: true,
  body: "…", ...over,
});

const reply = (over: Partial<Reply> = {}): Reply => ({
  id: "r_1", invoiceId: "inv_1", buyerId: "b_1", ts: istAt(TODAY, 10),
  channel: "whatsapp", source: "free_text", text: "…", intent: "unclear", confidence: 0.9, ...over,
});

describe("contact window", () => {
  it("permits a send inside 09:00-18:00 IST on a business day", () => {
    expect(contactWindow(caseFile(), nudge(), istAt(TODAY, 11)).pass).toBe(true);
  });

  it("blocks a send before the window opens", () => {
    const r = contactWindow(caseFile(), nudge(), istAt(TODAY, 8, 59));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("outside the contact window");
  });

  it("blocks a send at exactly the closing hour", () => {
    expect(contactWindow(caseFile(), nudge(), istAt(TODAY, 18, 0)).pass).toBe(false);
  });

  it("blocks a send on a Sunday", () => {
    expect(contactWindow(caseFile(), nudge(), istAt("2025-11-16", 11)).pass).toBe(false);
  });

  it("blocks a send on a listed holiday", () => {
    const r = contactWindow(caseFile(), nudge(), istAt("2025-12-25", 11));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("holiday");
  });

  it("does not gate waiting, escalating or stopping", () => {
    const at3am = istAt(TODAY, 3);
    expect(contactWindow(caseFile(), { kind: "schedule_wait", until: TODAY, reason: "x" }, at3am).pass).toBe(true);
    expect(contactWindow(caseFile(), { kind: "escalate_to_human", reason: "x" }, at3am).pass).toBe(true);
    expect(contactWindow(caseFile(), { kind: "stop", reason: "x" }, at3am).pass).toBe(true);
  });
});

describe("touch budget", () => {
  it("blocks the send that would exceed maxTouches", () => {
    const touches = Array.from({ length: DEFAULT_POLICY.maxTouches }, (_, i) => touch({ id: `t_${i}` }));
    const r = maxTouches(caseFile({ touches }), nudge(), istAt(TODAY, 11));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain(`cap is ${DEFAULT_POLICY.maxTouches}`);
  });

  it("permits the send at one below the cap", () => {
    const touches = Array.from({ length: DEFAULT_POLICY.maxTouches - 1 }, (_, i) => touch({ id: `t_${i}` }));
    expect(maxTouches(caseFile({ touches }), nudge(), istAt(TODAY, 11)).pass).toBe(true);
  });

  it("blocks a send inside the minimum gap", () => {
    const yesterday = touch({ ts: istAt(addDays(TODAY, -1), 11) });
    const r = minGap(caseFile({ touches: [yesterday] }), nudge(), istAt(TODAY, 11));
    expect(r.pass).toBe(false);
  });

  it("permits a send once the gap has elapsed", () => {
    const old = touch({ ts: istAt(addDays(TODAY, -DEFAULT_POLICY.minGapDays), 11) });
    expect(minGap(caseFile({ touches: [old] }), nudge(), istAt(TODAY, 11)).pass).toBe(true);
  });
});

describe("holds", () => {
  it("blocks contact while a promise is in flight", () => {
    const inv = invoice({ substate: "promised", promisedFor: addDays(TODAY, 3) });
    const r = noContactWhileHeld(caseFile({ invoice: inv }), nudge(), istAt(TODAY, 11));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("promised payment");
  });

  it("blocks contact on the promised date itself", () => {
    const inv = invoice({ substate: "promised", promisedFor: TODAY });
    expect(noContactWhileHeld(caseFile({ invoice: inv }), nudge(), istAt(TODAY, 11)).pass).toBe(false);
  });

  it("permits contact the day after a promise lapses", () => {
    const inv = invoice({ substate: "promised", promisedFor: addDays(TODAY, -1) });
    expect(noContactWhileHeld(caseFile({ invoice: inv }), nudge(), istAt(TODAY, 11)).pass).toBe(true);
  });

  it("blocks contact while disputed", () => {
    const inv = invoice({ substate: "disputed", disputeReason: "80 units hi aaye the" });
    const r = noContactWhileHeld(caseFile({ invoice: inv }), nudge(), istAt(TODAY, 11));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("disputed");
  });

  it("blocks contact while on human_hold", () => {
    const inv = invoice({ substate: "human_hold" });
    expect(noContactWhileHeld(caseFile({ invoice: inv }), nudge(), istAt(TODAY, 11)).pass).toBe(false);
  });
});

describe("do_not_contact", () => {
  it("is permanent and blocks every outbound", () => {
    const mem = { ...emptyMemory("b_1"), doNotContact: true };
    const r = doNotContact(caseFile({ memory: mem }), nudge(), istAt(TODAY, 11));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("cannot be overridden");
  });

  it("still permits stopping and escalating", () => {
    const mem = { ...emptyMemory("b_1"), doNotContact: true };
    expect(doNotContact(caseFile({ memory: mem }), { kind: "stop", reason: "x" }, istAt(TODAY, 11)).pass).toBe(true);
  });
});

describe("stop on paid", () => {
  it("blocks any further action once paid", () => {
    const inv = invoice({ substate: "paid", amountPaid: 18_000_000 });
    expect(stopOnPaid(caseFile({ invoice: inv }), nudge(), istAt(TODAY, 11)).pass).toBe(false);
    expect(stopOnPaid(caseFile({ invoice: inv }), { kind: "escalate_to_human", reason: "x" }, istAt(TODAY, 11)).pass).toBe(false);
  });

  it("permits stop itself, so a paid case can be closed", () => {
    const inv = invoice({ substate: "paid" });
    expect(stopOnPaid(caseFile({ invoice: inv }), { kind: "stop", reason: "paid" }, istAt(TODAY, 11)).pass).toBe(true);
  });
});

describe("campaign end", () => {
  it("forces a terminal decision past the end date", () => {
    const inv = invoice({ campaignEndsOn: addDays(TODAY, -1) });
    const c = caseFile({ invoice: inv });
    expect(campaignEnd(c, nudge(), istAt(TODAY, 11)).pass).toBe(false);
    expect(campaignEnd(c, { kind: "escalate_to_human", reason: "x" }, istAt(TODAY, 11)).pass).toBe(true);
    expect(campaignEnd(c, { kind: "stop", reason: "x" }, istAt(TODAY, 11)).pass).toBe(true);
  });

  it("permits outreach on the end date itself", () => {
    const inv = invoice({ campaignEndsOn: TODAY });
    expect(campaignEnd(caseFile({ invoice: inv }), nudge(), istAt(TODAY, 11)).pass).toBe(true);
  });
});

describe("whatsapp session window", () => {
  it("blocks free-form outside 24h of the last inbound", () => {
    const old = reply({ ts: istAt(addDays(TODAY, -2), 11) });
    const r = whatsappSessionWindow(caseFile({ replies: [old] }), nudge({ draft: "[free_form] hello" }), istAt(TODAY, 11));
    expect(r.pass).toBe(false);
  });

  it("permits free-form inside the window", () => {
    const recent = reply({ ts: istAt(TODAY, 9) });
    expect(whatsappSessionWindow(caseFile({ replies: [recent] }), nudge({ draft: "[free_form] hello" }), istAt(TODAY, 11)).pass).toBe(true);
  });

  it("permits templates with no inbound at all", () => {
    expect(whatsappSessionWindow(caseFile(), nudge(), istAt(TODAY, 11)).pass).toBe(true);
  });
});

describe("draft filter", () => {
  it("blocks legal language before the final rung", () => {
    const r = draftFilter(caseFile(), nudge({ draft: "Pay now or we will take legal action." }), istAt(TODAY, 11));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("legal action");
  });

  it("blocks threats regardless of casing", () => {
    expect(draftFilter(caseFile(), nudge({ draft: "This is your LAST WARNING." }), istAt(TODAY, 11)).pass).toBe(false);
  });

  it("permits an ordinary reminder", () => {
    expect(draftFilter(caseFile(), nudge(), istAt(TODAY, 11)).pass).toBe(true);
  });
});

describe("runGuards", () => {
  it("evaluates every guard rather than short-circuiting", () => {
    const mem = { ...emptyMemory("b_1"), doNotContact: true };
    const v = runGuards(caseFile({ memory: mem }), nudge(), istAt(TODAY, 3));
    expect(v.allowed).toBe(false);
    // A complete audit trail needs a verdict from each guard, not just the first failure.
    expect(v.results).toHaveLength(9);
    expect(v.results.filter((r) => !r.pass).length).toBeGreaterThan(1);
  });

  it("reports a single concatenated violation for the agent retry", () => {
    const v = runGuards(caseFile(), nudge(), istAt(TODAY, 22));
    expect(v.violation).toContain("contact_window");
  });

  it("allows a clean send", () => {
    const v = runGuards(caseFile(), nudge(), istAt(TODAY, 11));
    expect(v.allowed).toBe(true);
    expect(v.violation).toBeNull();
  });
});
