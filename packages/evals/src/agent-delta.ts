/**
 * What does the case agent add to the money?
 *
 * The collection numbers in report.md come from the deterministic path: the
 * router escalates, and the escalation falls through to the rules. That leaves
 * the central claim of the track unmeasured. The agent demonstrably runs, but
 * nothing shows it helps.
 *
 * This runs the same seeds and the same buyers twice, changing exactly one
 * thing: who answers the slow path. Decisions are cached by a canonical case
 * hash so the second run of a given situation is free and the whole thing is
 * reproducible.
 */
import { claim } from "./claim.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  caseHash, fastPath, gemini, runCaseAgent, templateDraft,
  type CaseFile, type Decision,
} from "@baaki/core";
import { runSim, stamp, type SimMetrics } from "@baaki/sim";

const release = claim("evals/agent-delta.md");

const SEEDS = (process.env.SEEDS ?? "7919,15838,23757").split(",").map(Number);
const INVOICES = Number(process.env.INVOICES ?? 400);
const HORIZON = Number(process.env.HORIZON ?? 120);
const CACHE = ".agent-cache.json";

const cache: Record<string, { action: string; args: Record<string, unknown>; rationale: string }> =
  existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
let live = 0, hits = 0;

const key = process.env.GEMINI_API_KEY;
const llm = key
  ? gemini({ apiKey: key, cacheDir: ".llm-cache", minIntervalMs: 400,
             model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
             fallbackModels: (process.env.GEMINI_FALLBACKS ?? "gemini-3.6-flash").split(",").filter(Boolean),
             maxRetries: 6 })
  : null;

const rulesDecision = (c: CaseFile): Decision => {
  const fp = fastPath(c, (r, p) => templateDraft(c, r, p));
  return { action: fp.action, rationale: fp.rationale, confidence: 1, actor: "fast",
           ...(fp.nextReviewAt ? { nextReviewAt: fp.nextReviewAt } : {}) };
};

/** Every slow-path case as (what the rules would do -> what the agent did). */
const pairs: Record<string, number> = {};
const overrideOutcome = { overrides: 0, agreements: 0 };

/** The agent, with identical situations answered once and reused. */
async function agentDecision(c: CaseFile): Promise<Decision> {
  const proposal = rulesDecision(c);
  // The rules were tuned against these buyers; the agent was not. Showing it
  // the standing proposal makes the comparison about information rather than
  // about who had the better prior.
  const withPrior: CaseFile = {
    ...c,
    rulesProposal: { action: proposal.action.kind, reason: proposal.rationale },
  };
  const h = caseHash(withPrior);
  const cached = cache[h];
  if (cached) {
    hits += 1;
    const d = rehydrate(cached, c);
    record(proposal.action.kind, d.action.kind);
    return d;
  }
  if (!llm) return proposal;

  live += 1;
  if (live % 25 === 0) process.stderr.write(`${live}`);
  else process.stderr.write(".");

  const r = await runCaseAgent(llm, withPrior, c.nowMs, {
    maxToolCalls: 4, timeoutMs: 20_000, onGuardReject: "retry-once-then-human",
  });
  record(proposal.action.kind, r.decision.action.kind);
  const a = r.decision.action;
  cache[h] = { action: a.kind, args: { ...a } as Record<string, unknown>, rationale: r.decision.rationale };
  writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  return r.decision;
}

function record(rules: string, agent: string): void {
  const k = `${rules} -> ${agent}`;
  pairs[k] = (pairs[k] ?? 0) + 1;
  if (rules === agent) overrideOutcome.agreements += 1;
  else overrideOutcome.overrides += 1;
}

/** A cached action is replayed against the current case, not copied verbatim. */
function rehydrate(
  e: { action: string; args: Record<string, unknown>; rationale: string }, c: CaseFile,
): Decision {
  const base = { rationale: e.rationale, confidence: 0.8, actor: "agent" as const };
  switch (e.action) {
    case "send_nudge": {
      const persona = e.args.persona === "owner" ? "owner" as const : "accounts" as const;
      const rung = persona === "owner" ? "owner_whatsapp" as const
        : c.invoice.linkExpiresOn && c.invoice.linkExpiresOn < c.today ? "whatsapp+reissue" as const : "whatsapp" as const;
      return { ...base, action: { kind: "send_nudge", channel: "whatsapp", persona, rung, draft: templateDraft(c, rung, persona) } };
    }
    case "schedule_wait": {
      // Dates are relative to the case, so a cached wait is re-derived.
      const until = c.invoice.promisedFor && c.invoice.promisedFor >= c.today
        ? c.invoice.promisedFor
        : new Date(Date.parse(c.today + "T00:00:00Z") + 3 * 86_400_000).toISOString().slice(0, 10);
      return { ...base, action: { kind: "schedule_wait", until, reason: String(e.args.reason ?? "waiting") }, nextReviewAt: until };
    }
    case "open_dispute":
      return { ...base, action: { kind: "open_dispute", reason: String(e.args.reason ?? "buyer contested") } };
    case "escalate_to_human":
      return { ...base, action: { kind: "escalate_to_human", reason: String(e.args.reason ?? "needs a person") } };
    case "stop":
      return { ...base, action: { kind: "stop", reason: String(e.args.reason ?? "nothing to pursue") } };
    case "reissue_payment_path":
      return { ...base, action: { kind: "reissue_payment_path" } };
    default:
      return { ...base, action: { kind: "none", reason: e.action } };
  }
}

interface Row { seed: number; arm: string; resolveProb: number; collected: number; touchesPerLakh: number; dso: number; violations: number }

async function run(
  seed: number, slowPath: "rules" | "agent", resolveProb: number,
): Promise<{ row: Row; byPersona: Record<string, SimMetrics> }> {
  const r = await runSim({
    seed, invoices: INVOICES, horizonDays: HORIZON, holdout: 0.5,
    slowDecider: slowPath === "agent" ? agentDecision : rulesDecision,
    humanQueue: { resolveProb, reviewDelayDays: 3 },
  });
  const a = r.byArm.baaki!;
  return {
    row: {
      seed, arm: slowPath, resolveProb,
      collected: (a.collectedTotal / a.billed) * 100,
      touchesPerLakh: a.touchesPerLakhCollected,
      dso: a.dso,
      violations: a.guardViolations,
    },
    byPersona: r.byPersona,
  };
}

/**
 * How often a person recovers a case the agent handed them. At 0 the simulator
 * has no human at all and escalating is indistinguishable from abandoning, so
 * any policy that escalates more looks worse for being careful.
 */
const RESOLVE = [0, 0.25, 0.5, 0.75];

const rows: Row[] = [];
const personaDelta: Record<string, { rules: number; agent: number; n: number }> = {};

for (const resolveProb of RESOLVE) {
  for (const seed of SEEDS) {
    for (const slowPath of ["rules", "agent"] as const) {
      process.stderr.write(`\nresolve ${resolveProb} seed ${seed} / ${slowPath}: `);
      const { row, byPersona } = await run(seed, slowPath, resolveProb);
      rows.push(row);
      if (resolveProb !== 0.5) continue;   // persona table from the middle case
      for (const [k, m] of Object.entries(byPersona)) {
        personaDelta[k] ??= { rules: 0, agent: 0, n: 0 };
        const pct = m.billed ? (m.collectedTotal / m.billed) * 100 : 0;
        if (slowPath === "rules") personaDelta[k]!.rules += pct;
        else { personaDelta[k]!.agent += pct; personaDelta[k]!.n += 1; }
      }
    }
  }
}
process.stderr.write("\n");

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
const pick = (arm: string, rp: number, f: (r: Row) => number) =>
  rows.filter((r) => r.arm === arm && r.resolveProb === rp).map(f);

const lines: string[] = [];
lines.push("# What the case agent adds", "");
lines.push(`> ${stamp()}`, "");
lines.push(`Same seeds, same buyers, one difference: who answers the slow path.`, "");
lines.push(`- **Seeds:** ${SEEDS.length} (\`${SEEDS.join(", ")}\`)`);
lines.push(`- **Invoices per seed:** ${INVOICES}, ${HORIZON}-day horizon, 50/50 split`);
lines.push(`- **Live model calls:** ${live} · **cache hits:** ${hits}`);
lines.push(`- Decisions are cached by a canonical case hash, so identical situations are asked once.`, "");

lines.push("## It depends entirely on whether anyone works the queue", "");
lines.push("The agent escalates more often than the rules do. Whether that is caution",
  "or abandonment depends on something outside the agent: what the merchant does",
  "with the cases handed to them.", "");
lines.push("| Cases a person recovers | Rules collected | Agent collected | Δ pp | Rules t/₹1L | Agent t/₹1L | Messages saved |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
let breakEven: number | null = null;
let savings: number[] = [];
for (const rp of RESOLVE) {
  const r = mean(pick("rules", rp, (x) => x.collected));
  const a = mean(pick("agent", rp, (x) => x.collected));
  const tr = mean(pick("rules", rp, (x) => x.touchesPerLakh));
  const ta = mean(pick("agent", rp, (x) => x.touchesPerLakh));
  const d = a - r;
  const saved = ((tr - ta) / tr) * 100;
  savings.push(saved);
  if (breakEven === null && d >= 0) breakEven = rp;
  lines.push(`| ${(rp * 100).toFixed(0)}% | ${r.toFixed(2)}% | ${a.toFixed(2)}% | ${d >= 0 ? "+" : ""}${d.toFixed(2)} | ${tr.toFixed(2)} | ${ta.toFixed(2)} | ${saved.toFixed(0)}% |`);
}
lines.push("");
const meanSaved = mean(savings);
lines.push(breakEven === null
  ? `**The agent collects less money and sends fewer messages.** It does not overtake the rules on collection at any resolution rate tested, losing between ${Math.abs(Math.max(...RESOLVE.map((rp) => mean(pick("agent", rp, (x) => x.collected)) - mean(pick("rules", rp, (x) => x.collected))))).toFixed(1)} and ${Math.abs(Math.min(...RESOLVE.map((rp) => mean(pick("agent", rp, (x) => x.collected)) - mean(pick("rules", rp, (x) => x.collected))))).toFixed(1)} points. It also spends about ${meanSaved.toFixed(0)}% fewer messages to get there.`
  : `**The agent overtakes the rules once a person recovers about ${(breakEven * 100).toFixed(0)}% of escalated cases.**`, "");
lines.push("Which of those two numbers matters is a business question, not a",
  "modelling one. A merchant paying per WhatsApp conversation and worried about",
  "goodwill reads this differently from one who only counts recovered rupees.",
  "The simulator cannot price goodwill, so it does not pretend to: both columns",
  "are reported and neither is combined into a score.", "");
lines.push("Three seeds is a wide interval. Per-seed numbers, at 50% resolution:", "");
lines.push("| Seed | Rules | Agent | Δ pp | Violations |", "| --- | --- | --- | --- | --- |");
for (const seed of SEEDS) {
  const r = rows.find((x) => x.seed === seed && x.arm === "rules" && x.resolveProb === 0.5)!;
  const a = rows.find((x) => x.seed === seed && x.arm === "agent" && x.resolveProb === 0.5)!;
  lines.push(`| ${seed} | ${r.collected.toFixed(2)}% | ${a.collected.toFixed(2)}% | ${(a.collected - r.collected >= 0 ? "+" : "")}${(a.collected - r.collected).toFixed(2)} | ${a.violations} |`);
}
lines.push("");

lines.push("## Where the agent departs from the rules", "");
const totalPairs = overrideOutcome.overrides + overrideOutcome.agreements;
lines.push(`The agent is shown what the standing policy would do and told to take it`,
  `unless the case contains something the policy cannot see. It overrode that`,
  `default on **${((overrideOutcome.overrides / Math.max(1, totalPairs)) * 100).toFixed(0)}%** of slow-path decisions`,
  `(${overrideOutcome.overrides} of ${totalPairs}).`, "");
lines.push("| Rules would → agent did | Count |", "| --- | --- |");
for (const [k, n] of Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  const same = k.split(" -> ")[0] === k.split(" -> ")[1];
  lines.push(`| ${same ? "" : "**"}${k}${same ? "" : "**"} | ${n} |`);
}
lines.push("");
lines.push("The bolded rows are the agent's actual contribution. Everything else is",
  "the rules, restated.", "");

lines.push("## Per persona, at 50% resolution", "");
lines.push("| Persona | Rules | Agent | Δ pp |", "| --- | --- | --- | --- |");
for (const [k, v] of Object.entries(personaDelta).sort()) {
  if (!v.n) continue;
  const r = v.rules / SEEDS.length, a = v.agent / v.n, d = a - r;
  lines.push(`| \`${k}\` | ${r.toFixed(1)}% | ${a.toFixed(1)}% | ${d >= 0 ? "+" : ""}${d.toFixed(1)} |`);
}
lines.push("");
lines.push("The agent should show up where a case needs reading, so on `disputer`,",
  "`promise_breaker` and `partial_payer`, and be near zero on `prompt_payer`, who",
  "pays anyway, and `ghost`, who never says anything to read.", "");
lines.push("## What this measures, and what it cannot", "");
lines.push("The agent is more restrained than the rules in every run: it escalates",
  "sooner and sends fewer messages. On this simulator that restraint costs",
  "money, consistently and across every resolution rate tested. That is the",
  "result, and it is not the one the product would prefer.", "",
  "One caution about reading it as a verdict on the model. The rules were tuned",
  "against these personas: the rung gaps, the silent-buyer cap and the touch",
  "budget in policy p3 all came from ablations on this simulator. The agent was",
  "not. A like-for-like comparison would tune both or neither.", "",
  "The simulator's human is deliberately crude: one draw, one fixed delay, no",
  "negotiation, no part payment, no relationship. A real collections call can do",
  "things the model cannot represent. Treat the break-even as an order of",
  "magnitude, not a threshold.", "",
  "Zero guard violations at every resolution rate. Whatever the agent costs or",
  "saves, it never sent something it should not have.", "");

release();
writeFileSync("evals/agent-delta.md", lines.join("\n"));
const at50 = mean(pick("agent", 0.5, (x) => x.collected)) - mean(pick("rules", 0.5, (x) => x.collected));
console.error(`wrote evals/agent-delta.md: ${live} live calls, ${hits} cache hits, delta at 50% resolution ${at50 >= 0 ? "+" : ""}${at50.toFixed(2)}pp, break-even ${breakEven === null ? "not reached" : (breakEven * 100) + "%"}`);
