/**
 * End-to-end run with the model actually in the loop: the router's slow-path
 * cases go to the case agent, and free-text replies are parsed rather than
 * handed to the ledger as ground truth.
 *
 * Small by necessity, since every slow-path case is a live call, so this is a
 * demonstration that the wiring holds under real conditions, not a measurement
 * of collection. The collection numbers stay in report.md on the rules arm.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  gemini, runCaseAgent, understandReply,
  type AgentTrace, type CaseFile, type Decision,
} from "@baaki/core";
import { runSim } from "@baaki/sim";

const SEED = Number(process.env.SEED ?? 2018);
const INVOICES = Number(process.env.INVOICES ?? 20);
const DAYS = Number(process.env.DAYS ?? 70);

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY not set");

const llm = gemini({
  apiKey: key,
  cacheDir: ".llm-cache",
  minIntervalMs: 2_500,
  model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  fallbackModels: (process.env.GEMINI_FALLBACKS ?? "gemini-3.6-flash").split(",").filter(Boolean),
  maxRetries: 5,
});

const traces: { invoiceId: string; day: string; action: string; trace: AgentTrace; rationale: string }[] = [];
let agentCalls = 0;

const slowDecider = async (c: CaseFile): Promise<Decision> => {
  agentCalls += 1;
  process.stderr.write(agentCalls % 20 === 0 ? `${agentCalls}` : ".");
  const r = await runCaseAgent(llm, c, c.nowMs, {
    maxToolCalls: 4, timeoutMs: 20_000, onGuardReject: "retry-once-then-human",
  });
  traces.push({
    invoiceId: c.invoice.id, day: c.today,
    action: r.decision.action.kind, trace: r.trace, rationale: r.decision.rationale,
  });
  return r.decision;
};

console.error(`agentic run: seed ${SEED}, ${INVOICES} invoices, ${DAYS} days`);
const started = Date.now();

const result = await runSim({
  seed: SEED, invoices: INVOICES, horizonDays: DAYS, holdout: 0,
  issueSpreadDays: 25,
  slowDecider,
  replyParser: (text, ctx) => understandReply(llm, text, ctx),
});
process.stderr.write("\n");

const u = llm.usage();
const secs = ((Date.now() - started) / 1000).toFixed(0);

// --- what the agent did ---------------------------------------------------
const byAction: Record<string, number> = {};
const byOutcome: Record<string, number> = {};
let totalToolCalls = 0, retries = 0, dropped = 0;
for (const t of traces) {
  byAction[t.action] = (byAction[t.action] ?? 0) + 1;
  byOutcome[t.trace.outcome] = (byOutcome[t.trace.outcome] ?? 0) + 1;
  totalToolCalls += t.trace.toolCalls.length;
  retries += t.trace.guardRetries;
  dropped += t.trace.droppedWrites.length;
}

// --- did the parser get it right ------------------------------------------
const p = result.parses;
const intentOk = p.filter((x) => x.intentOk).length;
const promiseCases = p.filter((x) => x.truth.intent === "promise");
const dateOk = promiseCases.filter((x) => x.dateOk).length;

const lines: string[] = [];
lines.push("# Agentic run", "");
lines.push(`Model in the loop end to end. Seed ${SEED}, ${INVOICES} invoices, ${DAYS} days, ${secs}s wall clock.`, "");
lines.push(`- Router: **${result.routing.fast} fast / ${result.routing.slow} slow** ` +
  `(${((result.routing.slow / (result.routing.fast + result.routing.slow)) * 100).toFixed(1)}% went to the agent)`);
lines.push(`- Live model calls: **${u.requests}** (${u.cacheHits} served from cache, ${u.modelFallbacks} model fallbacks)`);
lines.push(`- Tokens: ${u.promptTokens.toLocaleString()} in, ${u.outputTokens.toLocaleString()} out`);
lines.push(`- Guard violations: **${result.byArm.baaki?.guardViolations ?? 0}**`, "");

lines.push("## Why the router escalated", "");
lines.push("| Reason | Count |", "| --- | --- |");
for (const [k, v] of Object.entries(result.routing.reasons).sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${k} | ${v} |`);
}
lines.push("");

lines.push("## What the agent chose", "");
lines.push("| Action | Count |", "| --- | --- |");
for (const [k, v] of Object.entries(byAction).sort((a, b) => b[1] - a[1])) lines.push(`| \`${k}\` | ${v} |`);
lines.push("");
lines.push(`Mean tool calls per episode: ${(totalToolCalls / Math.max(1, traces.length)).toFixed(2)} (budget 4). ` +
  `Guard retries: ${retries}. Extra write calls dropped: ${dropped}.`, "");
lines.push("| Episode outcome | Count |", "| --- | --- |");
for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
lines.push("");

lines.push("## Reply understanding, in the loop", "");
if (p.length === 0) {
  lines.push("No free-text replies arrived in this run.", "");
} else {
  lines.push(`${p.length} free-text replies parsed. Intent correct on **${intentOk}/${p.length}** ` +
    `(${((intentOk / p.length) * 100).toFixed(1)}%).`);
  if (promiseCases.length) {
    lines.push(`Promise dates exact on **${dateOk}/${promiseCases.length}**.`);
  }
  lines.push("");
  const misses = p.filter((x) => !x.intentOk || x.dateOk === false);
  if (misses.length) {
    lines.push(`### ${misses.length} misreads, and what the ledger did with them`, "");
    lines.push("| invoice | buyer said | truth | heard | conf |", "| --- | --- | --- | --- | --- |");
    for (const m of misses.slice(0, 20)) {
      lines.push(`| ${m.invoiceId} | ${m.text.replace(/\|/g, "\\|")} | ${m.truth.intent}${m.truth.promiseDate ? ` ${m.truth.promiseDate}` : ""} | ${m.parsed.intent}${m.parsed.promiseDate ? ` ${m.parsed.promiseDate}` : ""} | ${m.parsed.confidence.toFixed(2)} |`);
    }
    lines.push("");
    lines.push("> A misread is not cosmetic. Hearing a promise that was not made freezes",
      "> outreach until a date the buyer never gave; hearing a dispute that was not",
      "> raised freezes it entirely and pages a human.", "");
  }
}

lines.push("## Sample episodes", "");
for (const t of traces.slice(0, 6)) {
  lines.push(`**${t.invoiceId}, ${t.day}** → \`${t.action}\`  `);
  lines.push(`tools: ${t.trace.toolCalls.map((x) => x.name).join(" → ") || "none"}  `);
  lines.push(`> ${t.rationale}`, "");
}

mkdirSync("evals", { recursive: true });
writeFileSync("evals/agentic-run.md", lines.join("\n"));
console.error(`\nwrote evals/agentic-run.md`);
console.error(`router ${result.routing.fast} fast / ${result.routing.slow} slow, ${u.requests} live calls, ${u.cacheHits} cached`);
if (p.length) console.error(`parser: ${intentOk}/${p.length} intents, ${dateOk}/${promiseCases.length} promise dates`);
