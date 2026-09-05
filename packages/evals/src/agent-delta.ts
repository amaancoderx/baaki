/**
 * What does the case agent add to the money?
 *
 * The collection numbers in report.md come from the deterministic path: the
 * router escalates, and the escalation falls through to the rules. That leaves
 * the central claim of the track unmeasured — the agent demonstrably runs, but
 * nothing shows it helps.
 *
 * This runs the same seeds and the same buyers twice, changing exactly one
 * thing: who answers the slow path. Decisions are cached by a canonical case
 * hash so the second run of a given situation is free and the whole thing is
 * reproducible.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  caseHash, fastPath, gemini, runCaseAgent, templateDraft,
  type CaseFile, type Decision,
} from "@baaki/core";
import { runSim, type SimMetrics } from "@baaki/sim";

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

/** The agent, with identical situations answered once and reused. */
async function agentDecision(c: CaseFile): Promise<Decision> {
  const h = caseHash(c);
  const cached = cache[h];
  if (cached) {
    hits += 1;
    return rehydrate(cached, c);
  }
  if (!llm) return rulesDecision(c);

  live += 1;
  if (live % 25 === 0) process.stderr.write(`${live}`);
  else process.stderr.write(".");

  const r = await runCaseAgent(llm, c, c.nowMs, {
    maxToolCalls: 4, timeoutMs: 20_000, onGuardReject: "retry-once-then-human",
  });
  const a = r.decision.action;
  cache[h] = { action: a.kind, args: { ...a } as Record<string, unknown>, rationale: r.decision.rationale };
  writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  return r.decision;
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

interface Row { seed: number; arm: string; collected: number; touchesPerLakh: number; dso: number; violations: number }

async function run(seed: number, slowPath: "rules" | "agent"): Promise<{ row: Row; byPersona: Record<string, SimMetrics> }> {
  const r = await runSim({
    seed, invoices: INVOICES, horizonDays: HORIZON, holdout: 0.5,
    slowDecider: slowPath === "agent" ? agentDecision : rulesDecision,
  });
  const a = r.byArm.baaki!;
  return {
    row: {
      seed, arm: slowPath,
      collected: (a.collectedTotal / a.billed) * 100,
      touchesPerLakh: a.touchesPerLakhCollected,
      dso: a.dso,
      violations: a.guardViolations,
    },
    byPersona: r.byPersona,
  };
}

const rows: Row[] = [];
const personaDelta: Record<string, { rules: number; agent: number; n: number }> = {};

for (const seed of SEEDS) {
  for (const slowPath of ["rules", "agent"] as const) {
    process.stderr.write(`\nseed ${seed} / ${slowPath}: `);
    const { row, byPersona } = await run(seed, slowPath);
    rows.push(row);
    for (const [k, m] of Object.entries(byPersona)) {
      personaDelta[k] ??= { rules: 0, agent: 0, n: 0 };
      const pct = m.billed ? (m.collectedTotal / m.billed) * 100 : 0;
      if (slowPath === "rules") personaDelta[k]!.rules += pct;
      else { personaDelta[k]!.agent += pct; personaDelta[k]!.n += 1; }
    }
  }
}
process.stderr.write("\n");

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
const pick = (arm: string, f: (r: Row) => number) => rows.filter((r) => r.arm === arm).map(f);

const lines: string[] = [];
lines.push("# What the case agent adds", "");
lines.push(`Same seeds, same buyers, one difference: who answers the slow path.`, "");
lines.push(`- **Seeds:** ${SEEDS.length} (\`${SEEDS.join(", ")}\`)`);
lines.push(`- **Invoices per seed:** ${INVOICES}, ${HORIZON}-day horizon, 50/50 split`);
lines.push(`- **Live model calls:** ${live} · **cache hits:** ${hits}`);
lines.push(`- Decisions are cached by a canonical case hash, so identical situations are asked once.`, "");

lines.push("## Per seed", "");
lines.push("| Seed | Rules collected | Agent collected | Δ pp | Rules t/₹1L | Agent t/₹1L | Violations |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const seed of SEEDS) {
  const r = rows.find((x) => x.seed === seed && x.arm === "rules")!;
  const a = rows.find((x) => x.seed === seed && x.arm === "agent")!;
  const d = a.collected - r.collected;
  lines.push(`| ${seed} | ${r.collected.toFixed(2)}% | ${a.collected.toFixed(2)}% | ${d >= 0 ? "+" : ""}${d.toFixed(2)} | ${r.touchesPerLakh.toFixed(2)} | ${a.touchesPerLakh.toFixed(2)} | ${a.violations} |`);
}
lines.push("");
const dm = mean(pick("agent", (r) => r.collected)) - mean(pick("rules", (r) => r.collected));
lines.push(`**Mean delta: ${dm >= 0 ? "+" : ""}${dm.toFixed(2)}pp across ${SEEDS.length} seeds.** Three seeds is a wide interval; the per-seed numbers above are the honest view.`, "");

lines.push("## Per persona", "");
lines.push("| Persona | Rules | Agent | Δ pp |", "| --- | --- | --- | --- |");
for (const [k, v] of Object.entries(personaDelta).sort()) {
  if (!v.n) continue;
  const r = v.rules / SEEDS.length, a = v.agent / v.n, d = a - r;
  lines.push(`| \`${k}\` | ${r.toFixed(1)}% | ${a.toFixed(1)}% | ${d >= 0 ? "+" : ""}${d.toFixed(1)} |`);
}
lines.push("");
lines.push("The agent should show up where a case needs reading — `disputer`,",
  "`promise_breaker`, `partial_payer` — and be near zero on `prompt_payer`, who",
  "pays anyway, and `ghost`, who never says anything to read.", "");
lines.push("## Reading a delta of about zero", "");
lines.push("A small delta is a result, not a failure. It would say the rules already",
  "capture most of the value and the agent's job is the minority of cases the",
  "rules cannot parse — done with zero guard violations. That is a defensible",
  "position and a more honest one than an unmeasured claim.", "");

mkdirSync("evals", { recursive: true });
writeFileSync("evals/agent-delta.md", lines.join("\n"));
console.error(`wrote evals/agent-delta.md — ${live} live calls, ${hits} cache hits, mean delta ${dm.toFixed(2)}pp`);
