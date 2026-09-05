/**
 * How much mishearing can the loop absorb?
 *
 * Every other run in this repository gives the policy the buyer's true intent,
 * which flatters the behaviour it depends on most — believing a buyer and
 * waiting — and hides its most expensive failure. This finds the point where
 * that stops being worth it.
 *
 * No API key: the parser is modelled, not called.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { OBSERVED, PERFECT, runSim, stamp, type ComprehensionParams } from "@baaki/sim";

const SEEDS = [7919, 15838, 23757, 31676, 39595, 47514, 55433, 63352, 71271, 79190];
const INVOICES = 800;
const HORIZON = 120;

interface Cell {
  label: string;
  params: ComprehensionParams;
  baaki: number; baseline: number; delta: number;
  frozenDays: number; dnc: number; misheardPct: number;
}

async function measure(label: string, params: ComprehensionParams): Promise<Cell> {
  let bkC = 0, bkB = 0, blC = 0, blB = 0, frozen = 0, dnc = 0, heard = 0, misheard = 0;
  for (const seed of SEEDS) {
    const r = await runSim({
      seed, invoices: INVOICES, horizonDays: HORIZON, holdout: 0.5,
      comprehension: params,
    });
    bkC += r.byArm.baaki!.collectedTotal; bkB += r.byArm.baaki!.billed;
    blC += r.byArm.baseline!.collectedTotal; blB += r.byArm.baseline!.billed;
    frozen += r.comprehension.daysFrozenOnFalsePromise;
    dnc += r.comprehension.dncViolations;
    heard += r.comprehension.heard; misheard += r.comprehension.misheard;
  }
  const baaki = (bkC / bkB) * 100, baseline = (blC / blB) * 100;
  return {
    label, params, baaki, baseline, delta: baaki - baseline,
    frozenDays: frozen / SEEDS.length,
    dnc: dnc / SEEDS.length,
    misheardPct: heard === 0 ? 0 : (misheard / heard) * 100,
  };
}

const p = (over: Partial<ComprehensionParams>): ComprehensionParams => ({ ...OBSERVED, ...over });

console.error("sweeping…");
const cells: Cell[] = [];
cells.push(await measure("perfect comprehension", PERFECT));
cells.push(await measure("as observed in replies.md", OBSERVED));
for (const v of [0.05, 0.10, 0.20, 0.35]) cells.push(await measure(`false promise ${(v * 100).toFixed(0)}%`, p({ pFalsePromise: v })));
for (const v of [0.10, 0.25, 0.50]) cells.push(await measure(`missed promise ${(v * 100).toFixed(0)}%`, p({ pMissedPromise: v })));
for (const v of [0.125, 0.25]) cells.push(await measure(`intent flip ${(v * 100).toFixed(1)}%`, p({ pIntentFlip: v })));
for (const v of [0.05, 0.15]) cells.push(await measure(`missed opt-out ${(v * 100).toFixed(0)}%`, p({ pMissedStop: v })));

const fp = cells.filter((c) => c.label.startsWith("false promise") || c.label === "as observed in replies.md");
const breaks = fp.find((c) => c.delta <= 0);

const lines: string[] = [];
lines.push("# How much mishearing can it absorb?", "");
lines.push(`> ${stamp()}`, "");
lines.push(`Every other run in this repository hands the ledger the buyer's true intent.`,
  `That gives the policy perfect comprehension for free, which flatters the`,
  `behaviour it depends on most — believing a buyer and waiting — and hides its`,
  `most expensive failure: freezing outreach on a promise nobody made.`, "");
lines.push(`${SEEDS.length} seeds, ${INVOICES} invoices, ${HORIZON}-day horizon, 50/50 split.`,
  `The baseline arm ignores replies entirely, so mishearing cannot touch it —`,
  `which is what makes the delta readable.`, "");

lines.push("| Parser | Baseline | Baaki | Δ pp | Misheard | Days frozen on a false promise | Opt-outs missed |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const c of cells) {
  const mark = c.delta <= 0 ? " **← baseline wins**" : "";
  lines.push(`| ${c.label} | ${c.baseline.toFixed(2)}% | ${c.baaki.toFixed(2)}% | ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(2)}${mark} | ${c.misheardPct.toFixed(1)}% | ${c.frozenDays.toFixed(0)} | ${c.dnc.toFixed(1)} |`);
}
lines.push("");

const observed = cells.find((c) => c.label === "as observed in replies.md")!;
const perfect = cells.find((c) => c.label === "perfect comprehension")!;
lines.push("## What it costs to be wrong", "");
lines.push(`Moving from perfect comprehension to the error profile observed in`,
  `\`evals/replies.md\` costs **${(perfect.delta - observed.delta).toFixed(2)}pp** — the difference between`,
  `${perfect.delta.toFixed(2)}pp and ${observed.delta.toFixed(2)}pp. Every collection figure elsewhere in this`,
  `repository is measured at the top of that range and should be read as an`,
  `upper bound.`, "");
lines.push(breaks
  ? `Baaki stops beating the baseline once the false-promise rate reaches about **${breaks.label.replace("false promise ", "")}**. On the 40 replies in \`evals/replies.md\` one case was a false promise, so roughly 2.5% — well inside the safe region, on a small denominator.`
  : `Baaki still beats the baseline at every false-promise rate tested, up to 35%. On the 40 replies in \`evals/replies.md\` the observed rate was roughly 2.5%.`, "");

lines.push("## Missing an opt-out is not an accuracy point", "");
const stop = cells.filter((c) => c.label.startsWith("missed opt-out"));
lines.push(`A missed "stop" is the only route by which a real do-not-contact violation`,
  `can enter this system: every other guard is a pure function that cannot be`,
  `talked out of its answer, but a guard can only honour a flag it was told about.`, "");
for (const c of stop) {
  lines.push(`- At ${c.label.replace("missed opt-out ", "")}, **${c.dnc.toFixed(1)} violations per run** — buyers messaged after asking not to be.`);
}
lines.push("", `This is why the number is reported on its own rather than folded into an`,
  `accuracy figure. 87.5% intent accuracy sounds acceptable; "we messaged`,
  `${stop[0]?.dnc.toFixed(0) ?? "n"} people who had asked us to stop" does not.`, "");

lines.push("## The product change this argues for", "");
lines.push(`A promise heard at low confidence should not freeze outreach for a week on`,
  `a guess. It should ask: one message, two buttons, "Friday 11 Sep tak — sahi`,
  `hai?" That converts an expensive silent failure into a cheap question, and it`,
  `is the change this table exists to justify. It is not built yet.`, "");

mkdirSync("evals", { recursive: true });
writeFileSync("evals/comprehension.md", lines.join("\n"));
console.error(`wrote evals/comprehension.md — observed profile costs ${(perfect.delta - observed.delta).toFixed(2)}pp`);
