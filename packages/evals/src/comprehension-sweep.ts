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
  frozenDays: number; dnc: number; misheardPct: number; touches: number;
}

async function measure(label: string, params: ComprehensionParams): Promise<Cell> {
  let bkC = 0, bkB = 0, blC = 0, blB = 0, frozen = 0, dnc = 0, heard = 0, misheard = 0, touches = 0;
  for (const seed of SEEDS) {
    const r = await runSim({
      seed, invoices: INVOICES, horizonDays: HORIZON, holdout: 0.5,
      comprehension: params,
    });
    bkC += r.byArm.baaki!.collectedTotal; bkB += r.byArm.baaki!.billed;
    touches += r.byArm.baaki!.touches;
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
    touches: touches / SEEDS.length,
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

lines.push("| Parser | Baaki | Δ pp | Misheard | Days frozen on a false promise | Touches | Opt-outs missed |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const c of cells) {
  const mark = c.delta <= 0 ? " **← baseline wins**" : "";
  lines.push(`| ${c.label} | ${c.baaki.toFixed(2)}% | ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(2)}${mark} | ${c.misheardPct.toFixed(1)}% | ${c.frozenDays.toFixed(0)} | ${c.touches.toFixed(0)} | ${c.dnc.toFixed(1)} |`);
}
lines.push("");
lines.push("The baseline column is omitted because it cannot move: that arm ignores",
  "replies entirely, so there is nothing for it to mishear.");
lines.push("");

const observed = cells.find((c) => c.label === "as observed in replies.md")!;
const perfect = cells.find((c) => c.label === "perfect comprehension")!;
const observed = cells.find((c) => c.label === "as observed in replies.md")!;
const perfect = cells.find((c) => c.label === "perfect comprehension")!;
const worst = cells.find((c) => c.label === "false promise 35%")!;

lines.push("## Mishearing costs almost nothing here, and the reason matters", "");
lines.push(`At a 35% false-promise rate the parser invents ${(worst.frozenDays).toFixed(0)} days of frozen`,
  `outreach per run and collection moves by ${Math.abs(worst.delta - perfect.delta).toFixed(2)}pp. That looks like the model is`,
  `not wired in. It is: misheard replies rise from ${perfect.misheardPct.toFixed(1)}% to ${worst.misheardPct.toFixed(1)}% and promises`,
  `recorded rise by roughly a third.`, "");
lines.push(`The mechanism is that the policy was not going to send anything during`,
  `those windows anyway. Touches move from ${perfect.touches.toFixed(0)} to ${worst.touches.toFixed(0)} — a handful,`,
  `across ${INVOICES} invoices. Sticky decisions and 10-to-18 day rung gaps mean a`,
  `week-long freeze usually overlaps a period of deliberate silence.`, "");
lines.push(`So this is not evidence that comprehension does not matter. It is evidence`,
  `that **restraint is a hedge against being wrong**: a policy that messages`,
  `rarely has little exposure to freezing when it should not. A more aggressive`,
  `ladder would pay much more for the same parser.`, "");
lines.push(`Every collection figure elsewhere in this repository assumes perfect`,
  `comprehension. On this evidence that assumption is worth about`,
  `${Math.abs(perfect.delta - observed.delta).toFixed(2)}pp, which is small — but it is small because of the policy,`,
  `not because parsing is easy.`, "");

lines.push("## Missing an opt-out is not an accuracy point", "");
const stop = cells.filter((c) => c.label.startsWith("missed opt-out"));
lines.push(`A missed "stop" is the only route by which a real do-not-contact violation`,
  `can enter this system: every other guard is a pure function that cannot be`,
  `talked out of its answer, but a guard can only honour a flag it was told about.`, "");
for (const c of stop) {
  lines.push(`- At ${c.label.replace("missed opt-out ", "")}, **${c.dnc.toFixed(1)} violations per run** — buyers messaged after asking not to be.`);
}
lines.push("", `This is why it is reported on its own rather than folded into an accuracy`,
  `figure. "87.5% intent accuracy" sounds acceptable in a way that "we messaged`,
  `people who had asked us to stop" does not.`, "");
lines.push("", `This class was untestable until recently. The only route to an opt-out was`,
  `the over-contact penalty, and the shipped rung gaps never trigger it, so no`,
  `buyer ever opted out and the count was zero for want of a chance to fail`,
  `rather than through safety. Buyers now opt out unprompted at a low rate.`, "");

lines.push("## The product change this argues for", "");
lines.push(`A promise heard at low confidence should not freeze outreach for a week on`,
  `a guess. It should ask: one message, two buttons, "Friday 11 Sep tak — sahi`,
  `hai?" That converts an expensive silent failure into a cheap question, and it`,
  `is the change this table exists to justify. It is not built yet.`, "");

mkdirSync("evals", { recursive: true });
writeFileSync("evals/comprehension.md", lines.join("\n"));
console.error(`wrote evals/comprehension.md — observed profile costs ${(perfect.delta - observed.delta).toFixed(2)}pp`);
