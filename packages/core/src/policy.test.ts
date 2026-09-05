import { describe, expect, it } from "vitest";
import { istAt } from "./time.js";
import { emptyMemory } from "./memory.js";
import { daysToLastRung, ladderProblem, voiceCall } from "./policy.js";
import { DEFAULT_POLICY, LIVE_POLICY, type CaseFile, type Policy } from "./types.js";

/**
 * A ladder whose last rung cannot be reached before the campaign ends is not a
 * conservative ladder, it is a rung of dead code: the policy claims an escalation
 * it will never perform, and the message with the most record value, the final
 * notice on both channels, never goes out.
 *
 * This was live. `campaignDays` was 30 against gaps that need 31 days for a
 * replying buyer and 55 for a silent one, so the last rung never fired once.
 */
describe.each([
  ["DEFAULT_POLICY", DEFAULT_POLICY],
  ["LIVE_POLICY", LIVE_POLICY],
])("%s ladder reachability", (_name, p) => {
  it("reaches the last outreach rung before the campaign ends", () => {
    expect(daysToLastRung(p, { silent: false })).toBeLessThanOrEqual(p.campaignDays);
  });

  it("reaches it even for a buyer who never replies and earns the wider gaps", () => {
    expect(daysToLastRung(p, { silent: true })).toBeLessThanOrEqual(p.campaignDays);
  });

  it("has a gap for every rung", () => {
    expect(p.rungGapDays.length).toBe(p.ladder.length);
  });

  it("can spend a touch on every rung it can reach", () => {
    // The ladder has one terminal rung that sends nothing, so the touch budget
    // has to cover the rest or the last rung is unreachable for a second reason.
    expect(p.maxTouches).toBeGreaterThanOrEqual(p.ladder.length - 1);
  });

  it("reports no problem at all", () => {
    expect(ladderProblem(p)).toBeNull();
  });
});

describe("ladderProblem catches the misconfiguration that shipped", () => {
  it("names the campaign window when the last rung cannot be reached", () => {
    // The exact policy that was live: 30-day campaign, 31 days of gaps.
    const broken = { ...DEFAULT_POLICY, campaignDays: 30 };
    expect(ladderProblem(broken)).toContain("can never fire");
  });

  it("catches the subtler case where only replying buyers reach it", () => {
    const p = { ...DEFAULT_POLICY, campaignDays: daysToLastRung(DEFAULT_POLICY, { silent: false }) };
    expect(ladderProblem(p)).toContain("who reply");
  });

  it("catches a touch budget too small for the ladder", () => {
    expect(ladderProblem({ ...DEFAULT_POLICY, maxTouches: 2 })).toContain("touch budget");
  });
});

describe("voice is off in the measured policy", () => {
  it("stays off in DEFAULT_POLICY, which is what the simulator runs", () => {
    // The simulator models messages moving a payment hazard and has no
    // representation of a conversation. A policy that placed calls inside it
    // would be measuring a fiction, so every published figure describes this.
    expect(DEFAULT_POLICY.voice?.enabled).toBe(false);
  });

  it("is on in the policy the product actually runs", () => {
    expect(LIVE_POLICY.voice?.enabled).toBe(true);
  });

  it("holds calls to a narrower window than messages", () => {
    const v = LIVE_POLICY.voice!;
    expect(v.window.start >= LIVE_POLICY.contactWindow.start).toBe(true);
    expect(v.window.end <= LIVE_POLICY.contactWindow.end).toBe(true);
  });
});

describe("voiceCall fires as a rule, before any routing", () => {
  const base: CaseFile = {
    today: "2026-10-08", nowMs: istAt("2026-10-08", 11),
    invoice: {
      id: "inv_1", buyerId: "b_1", amount: 32_000_000, amountPaid: 0,
      issuedOn: "2026-09-05", dueOn: "2026-09-20", linkExpiresOn: "2026-11-01",
      state: "overdue", substate: "awaiting_reply", promisedFor: null, disputeReason: null,
      campaignEndsOn: "2026-12-19", arm: "baaki", closedOn: null, closedReason: null,
    },
    buyer: { id: "b_1", name: "Sharma Traders", phone: "919000000001" },
    memory: emptyMemory("b_1"),
    touches: [{
      id: "t_1", invoiceId: "inv_1", buyerId: "b_1", ts: istAt("2026-09-28", 11),
      channel: "whatsapp", persona: "accounts", rung: "whatsapp", carriedLiveLink: true, body: "…",
    }],
    replies: [], payments: [], daysOverdue: 18, nextRung: "whatsapp+reissue",
    callsPlaced: 0, lastDecisionTs: null, nextReviewOn: null, policy: LIVE_POLICY,
  };

  it("calls a buyer who has gone silent past the threshold", () => {
    expect(voiceCall(base)?.action.kind).toBe("place_call");
  });

  it("does not call when voice is off, which is the simulator", () => {
    expect(voiceCall({ ...base, policy: DEFAULT_POLICY })).toBeNull();
  });

  it("does not call twice", () => {
    expect(voiceCall({ ...base, callsPlaced: 1 })).toBeNull();
  });

  it("does not call before anything has been tried", () => {
    expect(voiceCall({ ...base, touches: [] })).toBeNull();
  });

  it("does not call a buyer who replied", () => {
    const replied = {
      ...base,
      replies: [{ id: "r_1", invoiceId: "inv_1", buyerId: "b_1", ts: istAt("2026-09-29", 12), channel: "whatsapp" as const, source: "free_text" as const, text: "next week", intent: "will_pay" as const, confidence: 0.9 }],
    };
    expect(voiceCall(replied)).toBeNull();
  });

  it("does call when a promise passed with nothing said since", () => {
    const broken = {
      ...base,
      invoice: { ...base.invoice, substate: "promised" as const, promisedFor: "2026-10-01" },
      replies: [{ id: "r_1", invoiceId: "inv_1", buyerId: "b_1", ts: istAt("2026-09-25", 12), channel: "whatsapp" as const, source: "free_text" as const, text: "1 tarikh tak", intent: "will_pay" as const, promiseDate: "2026-10-01", confidence: 0.9 }],
    };
    expect(voiceCall(broken)?.action.kind).toBe("place_call");
  });

  it("never calls about a dispute", () => {
    const d = { ...base, invoice: { ...base.invoice, substate: "disputed" as const, disputeReason: "short delivery" } };
    expect(voiceCall(d)).toBeNull();
  });

  it("never calls a buyer who asked not to be contacted", () => {
    expect(voiceCall({ ...base, memory: { ...emptyMemory("b_1"), doNotContact: true } })).toBeNull();
  });

  it("does not call after the campaign has ended", () => {
    expect(voiceCall({ ...base, invoice: { ...base.invoice, campaignEndsOn: "2026-10-01" } })).toBeNull();
  });
});
