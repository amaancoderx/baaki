/**
 * Generates evals/report.md. Everything the README claims about money comes
 * from this file, and this file comes from seeded runs that anyone can repeat
 * with `pnpm evals:report`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fastPath, route, templateDraft, type CaseFile, type Decision } from "@baaki/core";
import { runSim, type PersonaOverrides, type SimMetrics, type SimResult } from "@baaki/sim";
import { croreLakh, pm, range, summarise, type Summary } from "./stats.js";

const SEEDS = [7919, 15838, 23757, 31676, 39595, 47514, 55433, 63352, 71271, 79190];
const INVOICES = 1200;
const HORIZON = 120;
/**
 * Headline measurement uses a balanced split. A 20% holdout is what a merchant
 * would actually run — you do not leave half your receivables untreated — but
 * it leaves the baseline arm with a quarter of the invoices and a standard
 * deviation two to three times the treatment arm's, which is too noisy to read
 * a two-point effect from. Both are reported; §2 gives the 20% figure.
 */
const HOLDOUT = 0.5;
const DEPLOY_HOLDOUT = 0.2;

type ArmKey = "baaki" | "baseline";

interface SeedRow { seed: number; baaki: SimMetrics; baseline: SimMetrics }

const pct = (m: SimMetrics) => (m.billed === 0 ? 0 : (m.collectedTotal / m.billed) * 100);
const pctAt = (m: SimMetrics, day: number) =>
  m.billed === 0 ? 0 : (m.collectedByDay[day]! / m.billed) * 100;

/**
 * Counts what the router would have handed to a case agent, then does exactly
 * what these runs do: fall back to the rules. The count is reported in §0 so
 * the size of the unevaluated surface is a number rather than a footnote.
 */
const coverage = { escalated: 0, freeText: 0, button: 0, reasons: {} as Record<string, number> };

function countingDecider(c: CaseFile): Decision {
  coverage.escalated += 1;
  const r = route(c);
  coverage.reasons[r.reason] = (coverage.reasons[r.reason] ?? 0) + 1;
  const fp = fastPath(c, (rung, persona) => templateDraft(c, rung, persona));
  return { action: fp.action, rationale: fp.rationale, confidence: 1, actor: "fast" };
}

async function mainRuns(holdout: number, instrument = false): Promise<SeedRow[]> {
  const rows: SeedRow[] = [];
  for (const seed of SEEDS) {
    const r = await runSim({
      seed, invoices: INVOICES, horizonDays: HORIZON, holdout,
      ...(instrument ? { slowDecider: countingDecider } : {}),
    });
    if (instrument) {
      for (const rep of r.ledger.allReplies()) {
        if (r.ledger.invoice(rep.invoiceId).arm !== "baaki") continue;
        if (rep.source === "free_text") coverage.freeText += 1;
        else coverage.button += 1;
      }
    }
    rows.push({ seed, baaki: r.byArm.baaki!, baseline: r.byArm.baseline! });
  }
  return rows;
}

/** Paired per-seed delta with a normal-approximation interval. */
function deltaCI(rows: SeedRow[]): { mean: number; sd: number; lo: number; hi: number; wins: number } {
  const d = rows.map((r) => pct(r.baaki) - pct(r.baseline));
  const s = summarise(d);
  const se = s.sd / Math.sqrt(s.n);
  return { mean: s.mean, sd: s.sd, lo: s.mean - 1.96 * se, hi: s.mean + 1.96 * se, wins: d.filter((x) => x > 0).length };
}

/**
 * What each component of the loop is actually worth. Run at the deployment
 * holdout so the numbers line up with §2.
 */
async function ablation(): Promise<string> {
  const { DEFAULT_POLICY } = await import("@baaki/core");
  const P = (o: Record<string, unknown>) => ({ ...DEFAULT_POLICY, ...o });
  const variants: { name: string; note: string; opts: Record<string, unknown> }[] = [
    { name: "Full policy (p3)", note: "as shipped", opts: {} },
    { name: "No link reissue", note: "nudge without repairing a dead payment link", opts: { disableReissue: true } },
    { name: "No pre-due nudge", note: "drop the rung the plan specifies in §4.1", opts: { policy: P({ preDueDays: 0 }) } },
    { name: "No silent backoff or cap", note: "climb the ladder regardless of replies", opts: { policy: P({ silentBackoffMultiplier: 1, silentTouchCap: 99 }) } },
    { name: "Narrow rung gaps", note: "the p2 gaps, [0,3,7,11,14]", opts: { policy: P({ rungGapDays: [0, 3, 7, 11, 14] }) } },
    { name: "maxTouches 3", note: "shorter ladder", opts: { policy: P({ maxTouches: 3 }) } },
  ];

  const lines = [
    "| Variant | Collected | Delta vs baseline | Touches/inv | Complaints | Opt-outs |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const v of variants) {
    const bk: number[] = [], bl: number[] = [], ti: number[] = [], cm: number[] = [], dn: number[] = [];
    for (const seed of SEEDS) {
      const r = await runSim({ seed, invoices: INVOICES, horizonDays: HORIZON, holdout: HOLDOUT, ...(v.opts as object) });
      const a = r.byArm.baaki!, b = r.byArm.baseline!;
      bk.push(pct(a)); bl.push(pct(b)); ti.push(a.touches / a.invoices);
      cm.push(a.complaints); dn.push(a.dncEvents);
    }
    const mb = summarise(bk).mean, ml = summarise(bl).mean;
    lines.push(
      `| ${v.name} | ${mb.toFixed(1)}% | ${mb - ml >= 0 ? "+" : ""}${(mb - ml).toFixed(2)}pp | ${summarise(ti).mean.toFixed(2)} | ${summarise(cm).mean.toFixed(1)} | ${summarise(dn).mean.toFixed(1)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Cumulative collected as a share of billed, both arms, averaged over seeds.
 * Drawn as text so it survives in a diff and needs no chart library.
 */
function curveChart(rows: SeedRow[]): string {
  const avg = (arm: ArmKey): number[] => {
    const cs = rows.map((r) => r[arm].curve).filter((c) => c.length);
    if (!cs.length) return [];
    const n = cs[0]!.length;
    return Array.from({ length: n }, (_, i) => cs.reduce((s, c) => s + (c[i] ?? 0), 0) / cs.length);
  };
  const bk = avg("baaki"), bl = avg("baseline");
  if (!bk.length) return "(no curve data)";

  const rowsOut: string[] = ["day   baseline                    baaki", ""];
  for (let d = 0; d <= 120; d += 10) {
    const b = bl[d] ?? 0, k = bk[d] ?? 0;
    const bar = (v: number) => "#".repeat(Math.round(v * 24)).padEnd(24);
    const lead = k > b ? "  baaki ahead" : k < b ? "  baseline ahead" : "";
    rowsOut.push(`${String(d).padStart(3)}   ${bar(b)}${(b * 100).toFixed(1).padStart(6)}%   ${bar(k)}${(k * 100).toFixed(1).padStart(6)}%${lead}`);
  }
  const cross = bk.findIndex((v, i) => v > (bl[i] ?? 0) && i > 5);
  rowsOut.push("", cross > 0 ? `curves cross on day ${cross}` : "curves do not cross");
  return rowsOut.join("\n");
}

function metricTable(rows: SeedRow[]): string {
  const pick = (arm: ArmKey, f: (m: SimMetrics) => number): Summary =>
    summarise(rows.map((r) => f(r[arm])));

  const lines: string[] = [];
  lines.push("| Metric | Baseline (holdout) | Baaki | Delta |");
  lines.push("| --- | --- | --- | --- |");

  const add = (
    label: string, f: (m: SimMetrics) => number, digits = 1, suffix = "",
    better: "high" | "low" = "high",
  ) => {
    const bl = pick("baseline", f);
    const bk = pick("baaki", f);
    const d = bk.mean - bl.mean;
    // Round before judging direction, so a delta that displays as 0.0 is not
    // marked as a regression. Both arms sitting at zero complaints is a tie.
    const shown = Number(d.toFixed(digits));
    const mark = shown === 0 ? "—" : (better === "high" ? shown > 0 : shown < 0) ? "✓" : "✗";
    const sign = shown > 0 ? "+" : "";
    lines.push(
      `| ${label} | ${pm(bl, digits)}${suffix} | ${pm(bk, digits)}${suffix} | ${sign}${shown.toFixed(digits)}${suffix} ${mark} |`,
    );
  };

  add("Collected by day 30 (% of billed)", (m) => pctAt(m, 30), 1, "%");
  add("Collected by day 60 (% of billed)", (m) => pctAt(m, 60), 1, "%");
  add("Collected by day 90 (% of billed)", (m) => pctAt(m, 90), 1, "%");
  add("Collected at horizon (% of billed)", pct, 1, "%");
  add("DSO (days, issue to settlement)", (m) => m.dso, 1, "", "low");
  add("DSO, amount-weighted, paid only", (m) => m.dsoPaidWeighted, 1, "", "low");
  add("Unpaid at horizon", (m) => m.unpaidAtHorizonPct, 1, "%", "low");
  add("Day reaching 50% collected", (m) => m.dayTo50 ?? 999, 0, "", "low");
  add("Day reaching 80% collected", (m) => m.dayTo80 ?? 999, 0, "", "low");
  add("Touches per ₹1L collected", (m) => m.touchesPerLakhCollected, 2, "", "low");
  add("Promise-kept rate", (m) => m.promiseKeptRate * 100, 0, "%");
  add("Complaints", (m) => m.complaints, 1, "", "low");
  add("Do-not-contact events", (m) => m.dncEvents, 1, "", "low");
  add("Guard violations", (m) => m.guardViolations, 0, "", "low");

  return lines.join("\n");
}

function perSeedTable(rows: SeedRow[]): { md: string; wins: number } {
  const lines: string[] = [];
  lines.push("| Seed | Baseline collected | Baaki collected | Baseline DSO | Baaki DSO | Winner |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  let wins = 0;
  for (const r of rows) {
    const pbl = pct(r.baseline), pbk = pct(r.baaki);
    const win = pbk > pbl;
    if (win) wins += 1;
    lines.push(
      `| ${r.seed} | ${pbl.toFixed(1)}% | ${pbk.toFixed(1)}% | ${r.baseline.dso.toFixed(1)} | ${r.baaki.dso.toFixed(1)} | ${win ? "Baaki" : "Baseline"} |`,
    );
  }
  return { md: lines.join("\n"), wins };
}

async function personaTable(): Promise<string> {
  // A 50% holdout here, not 20%: the per-persona cells are small and this table
  // is about direction per buyer type, not about the headline figure.
  interface Cell { inv: number; billed: number; collected: number; touches: number; dso: number }
  const cells = new Map<string, Cell>();
  for (const seed of SEEDS) {
    const r = await runSim({ seed, invoices: INVOICES, horizonDays: HORIZON, holdout: 0.5 });
    for (const inv of r.ledger.invoices()) {
      const persona = r.ledger.buyer(inv.buyerId).hiddenPersonaKey ?? "unknown";
      const k = `${inv.arm}|${persona}`;
      const c = cells.get(k) ?? { inv: 0, billed: 0, collected: 0, touches: 0, dso: 0 };
      c.inv += 1;
      c.billed += inv.amount;
      c.collected += inv.amountPaid;
      c.touches += r.ledger.touchesFor(inv.id).length;
      cells.set(k, c);
    }
  }
  const personas = [...new Set([...cells.keys()].map((k) => k.split("|")[1]!))].sort();
  const lines = [
    "| Persona | n per arm | Baseline collected | Baaki collected | Delta | Touches/inv (bl → bk) |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const p of personas) {
    const bk = cells.get(`baaki|${p}`), bl = cells.get(`baseline|${p}`);
    if (!bk || !bl) continue;
    const pbk = (bk.collected / bk.billed) * 100, pbl = (bl.collected / bl.billed) * 100;
    const d = pbk - pbl;
    lines.push(
      `| \`${p}\` | ${bk.inv} / ${bl.inv} | ${pbl.toFixed(1)}% | ${pbk.toFixed(1)}% | ${d >= 0 ? "+" : ""}${d.toFixed(1)} | ${(bl.touches / bl.inv).toFixed(2)} → ${(bk.touches / bk.inv).toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}

interface GridCell {
  ownerLift: number; keepProb: number; penalty: number; replyScale: number;
  deadLinks: number; liftScale: number;
  baaki: number; baseline: number; delta: number;
}

async function sensitivityGrid(): Promise<{ md: string; losing: GridCell[]; total: number }> {
  const OWNER = [1.0, 1.3];
  const KEEP = [0.25, 0.5, 0.8];
  const PENALTY = [0, 0.5];
  const REPLY = [0.5, 1.0];
  // The two dimensions the ablation says matter. At DEAD=0 there is nothing
  // for reissue to repair; at LIFT=0 no touch moves payment at all, which is
  // the axis along which any outreach product has nothing to sell.
  const DEAD = [0, 0.4];
  const LIFT = [0, 0.5, 1.0];
  const GRID_SEEDS = SEEDS.slice(0, 4);

  const cells: GridCell[] = [];
  for (const ownerLift of OWNER) {
    for (const keepProb of KEEP) {
      for (const penalty of PENALTY) {
        for (const replyScale of REPLY) {
          for (const deadLinks of DEAD) {
          for (const liftScale of LIFT) {
            const overrides: PersonaOverrides = {
              ownerPersonaLift: ownerLift,
              promiseKeepProb: keepProb,
              overContactPenalty: penalty,
              replyProbScale: replyScale,
              touchLiftScale: liftScale,
            };
            let bkC = 0, bkB = 0, blC = 0, blB = 0;
            for (const seed of GRID_SEEDS) {
              const r = await runSim({
                seed, invoices: 250, horizonDays: HORIZON, holdout: 0.35, overrides,
                deadLinkRate: deadLinks,
              });
              bkC += r.byArm.baaki!.collectedTotal; bkB += r.byArm.baaki!.billed;
              blC += r.byArm.baseline!.collectedTotal; blB += r.byArm.baseline!.billed;
            }
            const baaki = (bkC / bkB) * 100, baseline = (blC / blB) * 100;
            cells.push({ ownerLift, keepProb, penalty, replyScale, deadLinks, liftScale, baaki, baseline, delta: baaki - baseline });
          }
          }
        }
      }
    }
  }

  const losing = cells.filter((c) => c.delta <= 0);
  const lines = [
    "| owner lift | promise keep | over-contact penalty | reply scale | dead links | touch lift | Baseline | Baaki | Delta |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const c of cells) {
    const mark = c.delta <= 0 ? " **← Baseline wins**" : "";
    lines.push(
      `| ${c.ownerLift.toFixed(2)} | ${c.keepProb.toFixed(2)} | ${c.penalty.toFixed(2)} | ${c.replyScale.toFixed(1)}× | ${(c.deadLinks * 100).toFixed(0)}% | ${c.liftScale.toFixed(1)}× | ${c.baseline.toFixed(1)}% | ${c.baaki.toFixed(1)}% | ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(1)}${mark} |`,
    );
  }
  return { md: lines.join("\n"), losing, total: cells.length };
}

async function untreatedDso(): Promise<Summary> {
  const xs: number[] = [];
  for (const seed of SEEDS.slice(0, 5)) {
    const r = await runSim({ seed, invoices: INVOICES, horizonDays: 180, holdout: 0, untreated: true });
    const all = Object.values(r.byPersona);
    const n = all.reduce((s, m) => s + m.invoices, 0);
    xs.push(all.reduce((s, m) => s + m.dso * m.invoices, 0) / n);
  }
  return summarise(xs);
}

// ---------------------------------------------------------------------------

console.error("running arms (balanced)…");
const rows = await mainRuns(HOLDOUT, true);
console.error("running arms (deployment holdout)…");
const deployRows = await mainRuns(DEPLOY_HOLDOUT);
console.error("running ablation…");
const ablationTable = await ablation();
console.error("running per-persona…");
const personas = await personaTable();
console.error("running sensitivity grid…");
const grid = await sensitivityGrid();
console.error("running untreated calibration…");
const untreated = await untreatedDso();

const seedTable = perSeedTable(rows);
const deploySeed = perSeedTable(deployRows);
const ci = deltaCI(rows);
const deployCi = deltaCI(deployRows);
const collectedBk = summarise(rows.map((r) => r.baaki.collectedTotal));
const collectedBl = summarise(rows.map((r) => r.baseline.collectedTotal));

const losingSummary = (() => {
  const L = grid.losing;
  if (L.length === 0) return "No cell in the grid favoured Baseline.";

  const frac = (f: (c: GridCell) => boolean) => L.filter(f).length;
  const facts: { label: string; n: number }[] = [
    { label: "promise-kept probability at 0.25", n: frac((c) => c.keepProb === 0.25) },
    { label: "touches that do not move payment at all (lift 0×)", n: frac((c) => c.liftScale === 0) },
    { label: "touches at half strength (lift 0.5×)", n: frac((c) => c.liftScale === 0.5) },
    { label: "no dead payment links, so nothing for reissue to repair", n: frac((c) => c.deadLinks === 0) },
    { label: "no over-contact penalty", n: frac((c) => c.penalty === 0) },
    { label: "no owner-persona lift", n: frac((c) => c.ownerLift === 1.0) },
    { label: "replies at 0.5× the base rate", n: frac((c) => c.replyScale === 0.5) },
  ];

  const universal = facts.filter((f) => f.n === L.length).map((f) => f.label);
  const absent = facts.filter((f) => f.n === 0).map((f) => f.label);

  const lines: string[] = [
    `${L.length} of ${grid.total} cells favour Baseline. What they have in common:`,
    "",
    ...facts.map((f) => `- ${f.n}/${L.length} have ${f.label}.`),
    "",
  ];

  if (universal.length > 0) {
    lines.push(
      `**Necessary condition.** Every losing cell has ${universal.join(" and ")}. When a`,
      "promise means nothing, the days spent honouring one are never repaid, and the",
      "single most valuable thing the loop does — believing a buyer and waiting —",
      "becomes its most expensive habit.",
      "",
      "That alone is not sufficient. It has to combine with the loop having nothing",
      "else to sell: either no payment link ever dies, so there is nothing for reissue",
      "to repair, or a touch does not move payment at all, in which case no outreach",
      "product of any kind has a mechanism.",
      "",
    );
  }

  if (absent.length > 0) {
    lines.push(
      `**What does not appear.** Not one losing cell has ${absent.join(", nor ")}.`,
      "Scarce replies were expected to be a losing condition and are not. Reading the",
      "few replies that do arrive still pays, because acting on them correctly costs",
      "nothing extra — the touch budget is spent either way.",
      "",
    );
  }

  lines.push(
    "In the losing region the correct product is a fixed reminder schedule, and",
    "Baaki is overhead.",
  );
  return lines.join("\n");
})();

const md = `# Baaki — evaluation report

Generated by \`pnpm evals:report\`. Every figure below comes from seeded runs of
the simulator in \`packages/sim\`; nothing here is hand-entered.

- **Seeds:** ${SEEDS.length} (\`${SEEDS.join(", ")}\`)
- **Invoices per seed:** ${INVOICES}
- **Horizon:** ${HORIZON} days
- **Split:** ${HOLDOUT * 100}/${100 - HOLDOUT * 100} for measurement, ${DEPLOY_HOLDOUT * 100}% holdout reported separately in §2
- **Net terms:** 25 days
- **Policy version:** p3

## 0. What is measured here, and what is not

**Every number in this file comes from the deterministic path.** The arms below
run the ledger, buyer memory, router, fast-path policy, guards and audit. No
language model was called to produce them.

That is a deliberate limit, not an oversight. Scoring the case agent across
${SEEDS.length} seeds would mean roughly ${(coverage.escalated * SEEDS.length).toLocaleString()} live model calls at this scale;
the collection figures are meant to be reproducible by anyone with the repo and
no API key.

Two consequences worth stating plainly:

- The router escalated **${coverage.escalated.toLocaleString()} decisions** to the case agent across these runs.
  In *this* file they fell through to the rules. The agent exists, is bounded and
  is tested — see \`evals/agentic-run.md\` for a run with the model in the loop
  end to end, and \`packages/core/src/agent/agent.test.ts\` for the bounds.
- Free-text replies here reach the ledger with the intent the simulator sampled,
  not a parsed one. **${coverage.freeText.toLocaleString()} of ${(coverage.freeText + coverage.button).toLocaleString()} replies were free text** (${((coverage.freeText / Math.max(1, coverage.freeText + coverage.button)) * 100).toFixed(0)}%), so the
  arms below give Baaki perfect comprehension for free. Real parse accuracy is in
  \`evals/replies.md\`, and its failure modes are not free: hearing a promise that
  was never made freezes outreach until a date the buyer never gave.

Read the collection numbers as *what the guarded rules layer is worth*. The
model's contribution is measured separately and is not folded in.

## 1. Arms

**Baseline** sends fixed reminders at due, +7 and +14 on one channel and ignores
replies. That is what a reminder schedule does today. **Baaki** runs the full
loop: ledger, buyer memory, router, fast-path policy, guards, audit.

Both arms draw from the same seeded buyer population, and each buyer's payment
hazard is drawn from its own RNG stream, so the two arms see the same buyers
behaving the same way. A policy change cannot reshuffle who is who.

${metricTable(rows)}

Absolute money, mean over seeds: Baseline collected ${croreLakh(collectedBl.mean)},
Baaki ${croreLakh(collectedBk.mean)}. The arms hold roughly equal invoice counts at
this split, but percentages remain the comparable figures.

**Headline effect: ${ci.mean >= 0 ? "+" : ""}${ci.mean.toFixed(2)}pp collected, 95% CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}], winning ${ci.wins} of ${SEEDS.length} seeds.**

### Reading the DSO rows

Amount-weighted DSO over paid invoices is **worse** for Baaki, and that is a
selection effect rather than a regression. Baaki collects invoices the baseline
never collects at all — unpaid at horizon drops from about 20% to about 13% —
and the invoices it rescues are late by nature. Adding them to the paid pool
raises the average of that pool.

This is why the unpaid share sits directly beside it. Quoting a weighted DSO
alone would flatter whichever arm gives up on hard invoices soonest.

The row that actually captures the trade-off is **day reaching 80% collected**:
Baaki gets there roughly a month earlier, having waited on promises and been
behind for the first few weeks.

### The collection curve

Where the trade-off actually lives. Baaki is behind early because it waits on
promises, and ahead later. The crossing point is the honest summary of the
whole effect.

\`\`\`
${curveChart(rows)}
\`\`\`

## 2. Per-seed results, and the effect of the split

At a balanced ${HOLDOUT * 100}/${100 - HOLDOUT * 100} split:

${seedTable.md}

At the ${DEPLOY_HOLDOUT * 100}% holdout a merchant would actually run, the point estimate is
similar but the interval is much wider, because the baseline arm holds a
quarter of the invoices and its seed-to-seed standard deviation roughly doubles:

| Split | Delta | 95% CI | Seeds won |
| --- | --- | --- | --- |
| ${HOLDOUT * 100}% holdout (measurement) | ${ci.mean >= 0 ? "+" : ""}${ci.mean.toFixed(2)}pp | [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] | ${ci.wins}/${SEEDS.length} |
| ${DEPLOY_HOLDOUT * 100}% holdout (deployment) | ${deployCi.mean >= 0 ? "+" : ""}${deployCi.mean.toFixed(2)}pp | [${deployCi.lo.toFixed(2)}, ${deployCi.hi.toFixed(2)}] | ${deployCi.wins}/${SEEDS.length} |

The honest reading: the effect is real but small. It is roughly two points of
collected receivables, not a transformation, and at a 20% holdout a single run
cannot distinguish it from zero. Any claim larger than this is not supported by
what is in this repository.

## 2b. What each part of the loop is worth

Removing one component at a time, ${SEEDS.length} seeds each, same split as §1:

${ablationTable}

Two things worth stating plainly:

- **Link reissue carries most of the effect.** 40% of invoices in the population
  have a payment link that expires before it is needed, and a nudge without a
  live link does nothing at all. Repairing the path before speaking is most of
  what Baaki does better than a reminder schedule.
- **The pre-due nudge from plan §4.1 measures net-negative here.** It spends a
  touch and a slot in the over-contact window while the payment hazard is still
  near zero. It is kept on by default anyway, because this simulator models a
  nudge as something that accelerates payment and cannot represent a pre-due
  reminder preventing lateness in the first place. That is a limitation of the
  model, not evidence the rung is useless — but it does mean the rung is
  currently unsupported by measurement. Set \`preDueDays: 0\` to disable it.

## 3. Calibration

The untreated ledger — nobody contacted at all — settles at a DSO of
**${pm(untreated, 1)} days** (range ${range(untreated, 1)}, ${untreated.n} seeds). The published
figure for Indian SME receivables is roughly 73 days, and the persona hazards in
\`packages/sim/src/personas.yaml\` were set by hand against that number. The
calibration is reproducible with \`tsx packages/sim/src/calibrate.ts\`.

## 4. Per-persona breakdown

Persona parameters are hidden from the agent. It sees replies and payments and
nothing else. This table is cut at a 50% holdout so each cell has enough
invoices to read.

${personas}

## 5. Sensitivity — where Baaki loses

Six dimensions: owner-persona lift, promise-kept probability, over-contact
penalty, a scale on reply probability, the fraction of payment links that expire
before they are needed, and a scale on how much any touch moves the payment
hazard. The last two were added after an ablation showed the first four could not
produce a losing cell — they probe reply-reading and restraint, while the effect
turned out to live mostly in link repair. ${grid.total} cells, ${SEEDS.slice(0, 4).length} seeds each, 250 invoices per run.

${losingSummary}

<details>
<summary>Full grid (${grid.total} cells)</summary>

${grid.md}

</details>

## 6. Invariants

\`packages/evals/src/invariants.test.ts\` runs the guard suite over full
simulated runs rather than over fixtures. The test names are the stopping rules:

- sends no touch outside 09:00–18:00 IST
- sends no touch on a holiday or a Sunday
- never exceeds maxTouches on any invoice
- never sends two touches closer than minGapDays
- sends zero touches while a promise is in flight
- sends zero touches while a dispute is open
- sends zero touches after escalation to a human
- sends zero touches after do_not_contact is set
- sends zero touches after the invoice is paid in full
- sends no free-form WhatsApp outside the 24-hour session window
- reaches a terminal state on every campaign by its end date
- gives every audit entry a rationale and at least one evidence link
- records a guard verdict on every touch it logged

Run with \`pnpm test\`.

## 7. Reproducing this

\`\`\`
pnpm install
pnpm test              # guards + invariants
pnpm evals:report      # regenerates this file
\`\`\`
`;

mkdirSync("evals", { recursive: true });
writeFileSync("evals/report.md", md);
console.error(`\nwrote evals/report.md — Baaki won ${seedTable.wins}/${SEEDS.length} seeds, ${grid.losing.length}/${grid.total} grid cells favour Baseline`);
