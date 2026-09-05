/**
 * Scores reply understanding against a labelled set.
 *
 * Two sets, reported separately and never merged:
 *   replies_author_written.jsonl  written by the repo author. Regression only.
 *   replies_hand_labelled.jsonl   written by merchants. The real number.
 *
 * Merging them would let the self-consistent set inflate the honest one.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gemini, understandReply, type ParsedReply, type ReplyIntent } from "@baaki/core";

interface Case {
  id: string;
  text: string;
  today: string;
  label: { intent: ReplyIntent; promise_date?: string };
  note?: string;
}

const INTENTS: ReplyIntent[] = ["will_pay", "promise", "dispute", "already_paid", "partial", "stop", "unclear"];

function load(path: string): Case[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Case);
}

interface Scored { c: Case; got: ParsedReply; intentOk: boolean; dateOk: boolean | null }

async function scoreSet(name: string, cases: Case[]): Promise<{ name: string; rows: Scored[] } | null> {
  if (cases.length === 0) return null;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const llm = gemini({
    apiKey: key,
    cacheDir: ".llm-cache",
    // Pace deliberately: free-tier projects are capped per model per minute as
    // well as per day, and an unpaced loop spends the budget on 429s.
    minIntervalMs: 4_000,
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    fallbackModels: (process.env.GEMINI_FALLBACKS ?? "gemini-3.6-flash").split(",").filter(Boolean),
    maxRetries: 5,
  });

  const rows: Scored[] = [];
  for (const c of cases) {
    let got: ParsedReply;
    try {
      got = await understandReply(llm, c.text, {
        today: c.today, buyerName: "the buyer", invoiceId: "the invoice",
      });
    } catch (e) {
      console.error(`\n\nStopped at ${c.id} after ${rows.length}/${cases.length} cases.`);
      console.error(String(e instanceof Error ? e.message : e));
      console.error(
        `\nResults so far are cached in .llm-cache and will be reused free on the next run.\n` +
        `Re-run when quota resets (midnight Pacific), or set GEMINI_API_KEY to a key from\n` +
        `https://aistudio.google.com/apikey. Standard keys begin with "AIza".`,
      );
      if (rows.length === 0) process.exit(1);
      break;
    }
    const intentOk = got.intent === c.label.intent;
    const dateOk = c.label.intent === "promise"
      ? (got.promiseDate ?? null) === (c.label.promise_date ?? null)
      : null;
    rows.push({ c, got, intentOk, dateOk });
    process.stderr.write(intentOk ? "." : "x");
  }
  process.stderr.write("\n");
  const u = llm.usage();
  console.error(`${name}: ${u.requests} live calls, ${u.cacheHits} cache hits, ${u.modelFallbacks} model fallbacks, ${u.promptTokens + u.outputTokens} tokens`);
  return { name, rows };
}

function report(name: string, rows: Scored[]): string {
  const n = rows.length;
  const correct = rows.filter((r) => r.intentOk).length;

  const lines: string[] = [];
  lines.push(`### ${name}`, "");
  lines.push(`${n} cases. Intent accuracy **${((correct / n) * 100).toFixed(1)}%** (${correct}/${n}).`, "");

  const promises = rows.filter((r) => r.c.label.intent === "promise");
  const dateHits = promises.filter((r) => r.dateOk).length;
  if (promises.length) {
    lines.push(`Promise-date exact match: **${((dateHits / promises.length) * 100).toFixed(1)}%** (${dateHits}/${promises.length}).`, "");
  }

  lines.push("| Intent | Support | Precision | Recall | F1 |", "| --- | --- | --- | --- | --- |");
  for (const i of INTENTS) {
    const support = rows.filter((r) => r.c.label.intent === i).length;
    if (support === 0) continue;
    const predicted = rows.filter((r) => r.got.intent === i).length;
    const tp = rows.filter((r) => r.got.intent === i && r.c.label.intent === i).length;
    const p = predicted === 0 ? 0 : tp / predicted;
    const rc = support === 0 ? 0 : tp / support;
    const f1 = p + rc === 0 ? 0 : (2 * p * rc) / (p + rc);
    lines.push(`| \`${i}\` | ${support} | ${(p * 100).toFixed(0)}% | ${(rc * 100).toFixed(0)}% | ${(f1 * 100).toFixed(0)}% |`);
  }
  lines.push("");

  const misses = rows.filter((r) => !r.intentOk || r.dateOk === false);
  if (misses.length) {
    lines.push(`**${misses.length} miss${misses.length === 1 ? "" : "es"}:**`, "");
    lines.push("| id | text | expected | got | conf | note |", "| --- | --- | --- | --- | --- | --- |");
    for (const m of misses) {
      const exp = m.c.label.intent + (m.c.label.promise_date ? ` ${m.c.label.promise_date}` : "");
      const got = m.got.intent + (m.got.promiseDate ? ` ${m.got.promiseDate}` : "");
      lines.push(`| ${m.c.id} | ${m.c.text.replace(/\|/g, "\\|")} | ${exp} | ${got} | ${m.got.confidence.toFixed(2)} | ${m.c.note ?? ""} |`);
    }
    lines.push("");
  }

  // Does the confidence signal actually separate right from wrong?
  const right = rows.filter((r) => r.intentOk).map((r) => r.got.confidence);
  const wrong = rows.filter((r) => !r.intentOk).map((r) => r.got.confidence);
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
  if (wrong.length) {
    lines.push(
      `Mean confidence when correct: ${mean(right).toFixed(2)}; when wrong: ${mean(wrong).toFixed(2)}. ` +
      `Below the 0.6 routing threshold: ${rows.filter((r) => r.got.confidence < 0.6).length} of ${n}.`,
      "",
    );
  }
  return lines.join("\n");
}

const dataDir = join(process.cwd(), "packages/evals/data");
const author = await scoreSet("author-written (regression only)", load(join(dataDir, "replies_author_written.jsonl")));
const hand = await scoreSet("hand-labelled by merchants", load(join(dataDir, "replies_hand_labelled.jsonl")));

const parts: string[] = ["# Reply understanding", "",
  "Generated by `pnpm evals:replies`. Model: `gemini-3.5-flash`, temperature 0.", ""];

if (hand) {
  parts.push(report("Hand-labelled by merchants: the real number", hand.rows));
} else {
  parts.push(
    "### Hand-labelled by merchants: not yet collected",
    "",
    "Plan §7 asks for 60 replies written by people who run small businesses.",
    "That file does not exist yet, so **there is no honest accuracy number for",
    "this system.** See `packages/evals/data/README.md`.",
    "",
  );
}
if (author) {
  parts.push(
    report("Author-written: regression only, not an accuracy claim", author.rows),
    "> The same person wrote the parser prompt and these cases. This number",
    "> measures self-consistency and catches regressions. It is not evidence of",
    "> how the parser handles replies from real buyers.",
    "",
  );
}

mkdirSync("evals", { recursive: true });
writeFileSync("evals/replies.md", parts.join("\n"));
console.error("wrote evals/replies.md");
