import { createHash } from "node:crypto";
import type { GuardResult } from "../audit.js";
import { runGuards, type Guard } from "../guards/index.js";
import type { Llm, ToolCall } from "../llm/types.js";
import { formatINR } from "../money.js";
import { addDays } from "../time.js";
import type { Action, CaseFile, Decision } from "../types.js";
import { AGENT_SYSTEM, renderCase } from "./prompt.js";
import { ALL_TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "./tools.js";

/**
 * Tools offered for this case. `schedule_wait` is withheld when there is
 * nothing to wait for.
 *
 * Told in the prompt that delivery timing is the guards' problem, the model
 * still reached for schedule_wait because the date looked like a weekend, and
 * did so repeatedly, on a case that was 22 days overdue with a dead payment link. An
 * instruction it can ignore is not a bound. The router escalates a case
 * precisely when a decision is needed; if no promise is in flight and no reply
 * is outstanding, deferring is not one of the available decisions.
 */
export function toolsFor(c: CaseFile): typeof ALL_TOOLS {
  const promiseInFlight = c.invoice.substate === "promised" && c.invoice.promisedFor !== null
    && c.invoice.promisedFor >= c.today;
  const lastReply = c.replies[c.replies.length - 1];
  const lastTouch = c.touches[c.touches.length - 1];
  const replyOutstanding = Boolean(lastReply && (!lastTouch || lastReply.ts > lastTouch.ts));

  if (promiseInFlight || replyOutstanding) return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => t.name !== "schedule_wait");
}

export * from "./tools.js";
export * from "./prompt.js";

export interface AgentOptions {
  maxToolCalls?: number;
  timeoutMs?: number;
  /** Guard rejection behaviour. Plan §9: retry once, then hand to a human. */
  onGuardReject?: "retry-once-then-human" | "human";
  guards?: readonly Guard[];
}

export interface AgentTrace {
  toolCalls: { name: string; args: Record<string, unknown> }[];
  /** Write calls beyond the first, which are dropped. */
  droppedWrites: string[];
  guardRetries: number;
  outcome: "decided" | "retried-then-decided" | "human-after-reject" | "human-no-action" | "human-error";
  error?: string;
}

export interface AgentResult {
  decision: Decision;
  trace: AgentTrace;
  guards: GuardResult[];
}

/** Read tools answer from the case file. No side effects, no budget beyond the call count. */
function runReadTool(name: string, c: CaseFile): unknown {
  const inv = c.invoice;
  switch (name) {
    case "get_invoice":
      return {
        id: inv.id, billed: formatINR(inv.amount), paid: formatINR(inv.amountPaid),
        outstanding: formatINR(inv.amount - inv.amountPaid),
        issued_on: inv.issuedOn, due_on: inv.dueOn, days_overdue: c.daysOverdue,
        state: inv.state, substate: inv.substate,
        promised_for: inv.promisedFor, dispute_reason: inv.disputeReason,
        payment_link: inv.linkExpiresOn
          ? (inv.linkExpiresOn >= c.today ? `live until ${inv.linkExpiresOn}` : `expired on ${inv.linkExpiresOn}`)
          : "none",
        campaign_ends_on: inv.campaignEndsOn,
      };
    case "get_buyer_history":
      return {
        name: c.buyer.name,
        avg_days_late: Number(c.memory.avgDaysLate.toFixed(1)),
        promises_made: c.memory.counts.promisesMade,
        promises_kept: c.memory.counts.promisesKept,
        replies_per_touch: Number(c.memory.repliesPerTouch.whatsapp.toFixed(2)),
        disputes_raised: c.memory.counts.disputesRaised,
        language: c.memory.language,
        do_not_contact: c.memory.doNotContact,
      };
    case "get_touch_log":
      return [
        ...c.touches.map((t) => ({ ts: t.ts, kind: "sent", rung: t.rung, persona: t.persona, live_link: t.carriedLiveLink, body: t.body })),
        ...c.replies.map((r) => ({ ts: r.ts, kind: "reply", intent: r.intent, promise_date: r.promiseDate ?? null, source: r.source, text: r.text })),
      ].sort((a, b) => a.ts - b.ts);
    case "check_payment_status":
      return {
        settled: inv.amountPaid >= inv.amount,
        paid: formatINR(inv.amountPaid),
        outstanding: formatINR(inv.amount - inv.amountPaid),
        note: "Reflects the latest webhook received from the payment provider.",
      };
    default:
      return { error: `unknown read tool ${name}` };
  }
}

/**
 * Amounts are injected, never generated. A draft naming a rupee figure that is
 * not the outstanding balance is a hallucinated number heading for a buyer, so
 * the message is rewritten rather than merely flagged.
 */
export function sanitiseDraft(message: string, c: CaseFile): { text: string; repaired: boolean } {
  const outstanding = c.invoice.amount - c.invoice.amountPaid;
  const allowed = new Set([
    formatINR(outstanding).replace(/^₹/, ""),
    formatINR(c.invoice.amount).replace(/^₹/, ""),
  ]);
  let repaired = false;
  const text = message.replace(/₹\s?([\d,]+(?:\.\d+)?)/g, (whole, num: string) => {
    if (allowed.has(num)) return whole;
    repaired = true;
    return formatINR(outstanding);
  });
  return { text, repaired };
}

function toAction(call: ToolCall, c: CaseFile): { action: Action; reissueFirst: boolean } {
  const a = call.args;
  switch (call.name) {
    case "send_nudge": {
      const persona = a.persona === "owner" ? "owner" : "accounts";
      const { text } = sanitiseDraft(String(a.message ?? ""), c);
      const rung = persona === "owner" ? "owner_whatsapp"
        : a.reissue_link_first ? "whatsapp+reissue" : "whatsapp";
      return {
        action: { kind: "send_nudge", channel: "whatsapp", persona, rung, draft: text },
        reissueFirst: Boolean(a.reissue_link_first),
      };
    }
    case "reissue_payment_path":
      return { action: { kind: "reissue_payment_path" }, reissueFirst: false };
    case "schedule_wait": {
      const until = typeof a.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.until)
        ? a.until : addDays(c.today, 3);
      return { action: { kind: "schedule_wait", until, reason: String(a.reason ?? "waiting") }, reissueFirst: false };
    }
    case "open_dispute":
      return { action: { kind: "open_dispute", reason: String(a.reason ?? "buyer contested the invoice") }, reissueFirst: false };
    case "escalate_to_human":
      return { action: { kind: "escalate_to_human", reason: String(a.reason ?? "needs a person") }, reissueFirst: false };
    case "stop":
      return { action: { kind: "stop", reason: String(a.reason ?? "nothing further to pursue") }, reissueFirst: false };
    default:
      return { action: { kind: "escalate_to_human", reason: `unknown tool ${call.name}` }, reissueFirst: false };
  }
}

const human = (reason: string, rationale: string): Decision => ({
  action: { kind: "escalate_to_human", reason },
  rationale, confidence: 0, actor: "agent",
});

/**
 * One bounded episode per case. Read tools are free to call but count against
 * the budget; the episode ends at the first write tool. Everything the model
 * cannot be trusted to respect (one write, the budget, the timeout, the guard
 * verdict) is enforced here rather than requested in the prompt.
 */
export async function runCaseAgent(
  llm: Llm,
  c: CaseFile,
  nowMs: number,
  opts: AgentOptions = {},
): Promise<AgentResult> {
  const maxToolCalls = opts.maxToolCalls ?? 4;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const onReject = opts.onGuardReject ?? "retry-once-then-human";

  const trace: AgentTrace = { toolCalls: [], droppedWrites: [], guardRetries: 0, outcome: "decided" };
  const history: { call: ToolCall; result: unknown }[] = [];
  const basePrompt = renderCase(c);
  const deadline = Date.now() + timeoutMs;

  // Key the cache on what the model actually reads. Keying on ids and counts
  // meant an edited policy returned yesterday's decision, which made the rules
  // editor look broken because the answer never changed.
  const offered = toolsFor(c);
  const promptDigest = createHash("sha256")
    .update(basePrompt).update("\u0000").update(c.policy.policyVersion)
    .update("\u0000").update(offered.map((t) => t.name).join(","))
    .digest("hex").slice(0, 16);

  async function episode(extra: string | null): Promise<{ decision: Decision; guards: GuardResult[]; violation: string | null } | null> {
    const prompt = extra ? `${basePrompt}\n\n${extra}` : basePrompt;

    for (let step = 0; step < maxToolCalls; step++) {
      if (Date.now() > deadline) {
        trace.outcome = "human-error";
        trace.error = "episode exceeded its time budget";
        return null;
      }

      const turn = await llm.tools({
        system: AGENT_SYSTEM,
        prompt,
        tools: offered,
        history,
        temperature: 0,
        cacheKey: `agent:${c.invoice.id}:${promptDigest}:${extra ? createHash("sha256").update(extra).digest("hex").slice(0, 8) : "0"}:${step}`,
      });

      if (turn.calls.length === 0) {
        // No tool call. Nothing has been decided, so nothing may be assumed.
        trace.outcome = "human-no-action";
        return null;
      }

      const writes = turn.calls.filter((t) => WRITE_TOOL_NAMES.has(t.name));
      const reads = turn.calls.filter((t) => READ_TOOL_NAMES.has(t.name));

      if (writes.length > 0) {
        const chosen = writes[0]!;
        trace.toolCalls.push({ name: chosen.name, args: chosen.args });
        trace.droppedWrites.push(...writes.slice(1).map((w) => w.name));

        const { action, reissueFirst } = toAction(chosen, c);
        const rationale = (turn.text || "").trim() || rationaleFor(chosen, c);
        const verdict = runGuards(c, action, nowMs, opts.guards);

        return {
          decision: {
            action, rationale, confidence: 0.8, actor: "agent",
            toolCalls: [...trace.toolCalls, ...(reissueFirst ? [{ name: "reissue_payment_path", args: {} }] : [])],
          },
          guards: verdict.results,
          violation: verdict.violation,
        };
      }

      for (const r of reads) {
        trace.toolCalls.push({ name: r.name, args: r.args });
        history.push({ call: r, result: runReadTool(r.name, c) });
      }
    }

    // Budget spent on reads without ever deciding.
    trace.outcome = "human-no-action";
    return null;
  }

  try {
    const first = await episode(null);
    if (!first) {
      return {
        decision: human("agent produced no action", `The case agent spent its budget of ${maxToolCalls} tool calls without choosing an action. Handing to a human rather than guessing.`),
        trace, guards: [],
      };
    }

    if (!first.violation) return { decision: first.decision, trace, guards: first.guards };

    if (onReject === "human") {
      trace.outcome = "human-after-reject";
      return {
        decision: human("guard rejected the agent's action", `The agent proposed ${first.decision.action.kind} and the guard layer refused it: ${first.violation}`),
        trace, guards: first.guards,
      };
    }

    // One retry, with the violation handed back verbatim.
    trace.guardRetries = 1;
    const second = await episode(
      `Your previous choice was ${first.decision.action.kind}, and the guard layer refused it:\n\n${first.violation}\n\n` +
      `That is a rule, not an obstacle to work around. Choose an action that respects it. Waiting or escalating is always permitted.`,
    );

    if (second && !second.violation) {
      trace.outcome = "retried-then-decided";
      return { decision: second.decision, trace, guards: second.guards };
    }

    trace.outcome = "human-after-reject";
    return {
      decision: human(
        "guard rejected the agent twice",
        `The agent proposed ${first.decision.action.kind}, the guard layer refused it (${first.violation}), and its retry ${second ? `proposed ${second.decision.action.kind} which was also refused` : "produced no action"}. Handing to a human.`,
      ),
      trace, guards: second?.guards ?? first.guards,
    };
  } catch (e) {
    trace.outcome = "human-error";
    trace.error = e instanceof Error ? e.message : String(e);
    return {
      decision: human("agent error", `The case agent failed: ${trace.error}. Handing to a human rather than acting on a broken episode.`),
      trace, guards: [],
    };
  }
}

function rationaleFor(call: ToolCall, c: CaseFile): string {
  switch (call.name) {
    case "send_nudge":
      return `Agent chose to send a ${call.args.persona === "owner" ? "owner-level" : "routine"} message at ${c.daysOverdue} days overdue.`;
    case "schedule_wait":
      return `Agent chose to wait until ${call.args.until}: ${call.args.reason}`;
    case "open_dispute":
      return `Agent recorded a dispute: ${call.args.reason}`;
    case "escalate_to_human":
      return `Agent handed the case to a person: ${call.args.reason}`;
    case "stop":
      return `Agent closed the campaign: ${call.args.reason}`;
    case "reissue_payment_path":
      return "Agent reissued the payment link.";
    default:
      return `Agent called ${call.name}.`;
  }
}
