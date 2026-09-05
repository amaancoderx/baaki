import { describe, expect, it } from "vitest";
import { fakeLlm } from "../llm/fake.js";
import type { ToolTurn } from "../llm/types.js";
import { emptyMemory } from "../memory.js";
import { istAt, addDays } from "../time.js";
import { DEFAULT_POLICY, type CaseFile, type Invoice } from "../types.js";
import { runCaseAgent, sanitiseDraft } from "./index.js";

const TODAY = "2025-11-12";
const NOW = istAt(TODAY, 11);

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv_1", buyerId: "b_1", amount: 18_000_000, amountPaid: 0,
    issuedOn: "2025-09-01", dueOn: "2025-09-26", linkExpiresOn: "2025-12-01",
    state: "overdue", substate: "awaiting_reply", promisedFor: null, disputeReason: null,
    campaignEndsOn: "2025-12-25", arm: "baaki", closedOn: null, closedReason: null, ...over,
  };
}

function caseFile(over: Partial<CaseFile> = {}): CaseFile {
  const inv = over.invoice ?? invoice();
  return {
    today: TODAY, nowMs: NOW, invoice: inv,
    buyer: { id: "b_1", name: "Sharma Traders", phone: "+919000000001" },
    memory: emptyMemory("b_1"), touches: [], replies: [], payments: [],
    daysOverdue: 47, nextRung: "whatsapp", callsPlaced: 0, lastCallAt: null, lastDecisionTs: null, nextReviewOn: null, policy: DEFAULT_POLICY, ...over,
  };
}

const turn = (calls: ToolTurn["calls"], text = ""): ToolTurn => ({ calls, text });

describe("episode bounds", () => {
  it("takes the first write tool and drops the rest", async () => {
    const llm = fakeLlm({
      fallbackTool: turn([
        { name: "schedule_wait", args: { until: "2025-11-20", reason: "promise in flight" } },
        { name: "send_nudge", args: { persona: "accounts", message: "pay up" } },
        { name: "stop", args: { reason: "nope" } },
      ]),
    });
    const r = await runCaseAgent(llm, caseFile(), NOW);
    expect(r.decision.action.kind).toBe("schedule_wait");
    expect(r.trace.droppedWrites).toEqual(["send_nudge", "stop"]);
  });

  it("escalates when the model spends its budget on reads without deciding", async () => {
    const llm = fakeLlm({ fallbackTool: turn([{ name: "get_invoice", args: {} }]) });
    const r = await runCaseAgent(llm, caseFile(), NOW, { maxToolCalls: 3 });
    expect(r.decision.action.kind).toBe("escalate_to_human");
    expect(r.trace.outcome).toBe("human-no-action");
    expect(r.trace.toolCalls).toHaveLength(3);
  });

  it("escalates when the model returns no tool call at all", async () => {
    const llm = fakeLlm({ fallbackTool: turn([], "I think we should wait.") });
    const r = await runCaseAgent(llm, caseFile(), NOW);
    expect(r.decision.action.kind).toBe("escalate_to_human");
    expect(r.trace.outcome).toBe("human-no-action");
  });

  it("escalates rather than acting when the model throws", async () => {
    const llm = fakeLlm({});  // no rules configured: every call throws
    const r = await runCaseAgent(llm, caseFile(), NOW);
    expect(r.decision.action.kind).toBe("escalate_to_human");
    expect(r.trace.outcome).toBe("human-error");
    expect(r.decision.rationale).toContain("Handing to a human");
  });

  it("feeds read-tool results back and lets the model then decide", async () => {
    let step = 0;
    const llm = {
      name: "scripted",
      async json<T>(): Promise<T> { throw new Error("unused"); },
      async tools(): Promise<ToolTurn> {
        step += 1;
        return step === 1
          ? turn([{ name: "get_buyer_history", args: {} }])
          : turn([{ name: "escalate_to_human", args: { reason: "no replies to three touches" } }], "Buyer has never replied.");
      },
      usage: () => ({ requests: step, promptTokens: 0, outputTokens: 0, cacheHits: 0, modelFallbacks: 0 }),
    };
    const r = await runCaseAgent(llm, caseFile(), NOW);
    expect(r.trace.toolCalls.map((t) => t.name)).toEqual(["get_buyer_history", "escalate_to_human"]);
    expect(r.decision.action.kind).toBe("escalate_to_human");
    expect(r.decision.rationale).toBe("Buyer has never replied.");
  });
});

describe("guard rejection", () => {
  it("hands the violation back and accepts a corrected second choice", async () => {
    // Promise in flight: a nudge is barred, waiting is not.
    const c = caseFile({ invoice: invoice({ substate: "promised", promisedFor: addDays(TODAY, 5) }) });
    let step = 0;
    const llm = {
      name: "scripted",
      async json<T>(): Promise<T> { throw new Error("unused"); },
      async tools(req: { prompt: string }): Promise<ToolTurn> {
        step += 1;
        if (step === 1) return turn([{ name: "send_nudge", args: { persona: "accounts", message: "kindly pay" } }]);
        expect(req.prompt).toContain("promised payment");
        expect(req.prompt).toContain("rule, not an obstacle");
        return turn([{ name: "schedule_wait", args: { until: addDays(TODAY, 6), reason: "promise in flight" } }]);
      },
      usage: () => ({ requests: step, promptTokens: 0, outputTokens: 0, cacheHits: 0, modelFallbacks: 0 }),
    };
    const r = await runCaseAgent(llm, c, NOW);
    expect(r.decision.action.kind).toBe("schedule_wait");
    expect(r.trace.guardRetries).toBe(1);
    expect(r.trace.outcome).toBe("retried-then-decided");
  });

  it("hands to a human when the retry is refused too", async () => {
    const c = caseFile({ invoice: invoice({ substate: "promised", promisedFor: addDays(TODAY, 5) }) });
    const llm = fakeLlm({
      fallbackTool: turn([{ name: "send_nudge", args: { persona: "owner", message: "please pay" } }]),
    });
    const r = await runCaseAgent(llm, c, NOW);
    expect(r.decision.action.kind).toBe("escalate_to_human");
    expect(r.trace.outcome).toBe("human-after-reject");
    expect(r.decision.rationale).toContain("refused");
  });

  it("never lets the agent talk past do_not_contact", async () => {
    const c = caseFile({ memory: { ...emptyMemory("b_1"), doNotContact: true } });
    const llm = fakeLlm({
      fallbackTool: turn([{ name: "send_nudge", args: { persona: "accounts", message: "hello" } }]),
    });
    const r = await runCaseAgent(llm, c, NOW);
    expect(r.decision.action.kind).toBe("escalate_to_human");
  });
});

describe("draft sanitising", () => {
  it("rewrites a rupee figure the agent invented", () => {
    const c = caseFile();
    const { text, repaired } = sanitiseDraft("Please pay ₹99,999 today.", c);
    expect(repaired).toBe(true);
    expect(text).toBe("Please pay ₹1,80,000 today.");
  });

  it("leaves the correct outstanding figure alone", () => {
    const c = caseFile();
    const { text, repaired } = sanitiseDraft("Invoice for ₹1,80,000 is overdue.", c);
    expect(repaired).toBe(false);
    expect(text).toBe("Invoice for ₹1,80,000 is overdue.");
  });

  it("sanitises the draft that actually reaches the action", async () => {
    const llm = fakeLlm({
      fallbackTool: turn([{ name: "send_nudge", args: { persona: "accounts", message: "You owe ₹5,00,000, pay now." } }]),
    });
    const r = await runCaseAgent(llm, caseFile(), NOW);
    expect(r.decision.action.kind).toBe("send_nudge");
    if (r.decision.action.kind === "send_nudge") {
      expect(r.decision.action.draft).toContain("₹1,80,000");
      expect(r.decision.action.draft).not.toContain("5,00,000");
    }
  });

  it("still blocks a draft carrying legal language", async () => {
    const llm = fakeLlm({
      fallbackTool: turn([{ name: "send_nudge", args: { persona: "accounts", message: "Pay or we take legal action." } }]),
    });
    const r = await runCaseAgent(llm, caseFile(), NOW);
    expect(r.decision.action.kind).toBe("escalate_to_human");
  });
});
