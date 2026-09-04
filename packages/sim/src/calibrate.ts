/**
 * Tunes nothing automatically. It reports the untreated ledger so the hazard
 * parameters in personas.yaml can be set by hand against the published figure
 * (~73 days for Indian SMEs), and so that number is reproducible rather than
 * asserted in the README.
 */
import { runSim } from "./engine.js";
import { loadPersonas } from "./personas.js";

const SEEDS = [7919, 15838, 23757, 31676, 39595];
const INVOICES = 400;
const HORIZON = 180;

const file = loadPersonas();
const perPersona: Record<string, number[]> = {};
const overall: number[] = [];
const paidPct: number[] = [];

for (const seed of SEEDS) {
  const r = await runSim({ seed, invoices: INVOICES, horizonDays: HORIZON, holdout: 0, untreated: true });
  const all = Object.values(r.byPersona);
  const totalInv = all.reduce((s, m) => s + m.invoices, 0);
  const weightedDso = all.reduce((s, m) => s + m.dso * m.invoices, 0) / totalInv;
  overall.push(weightedDso);
  paidPct.push((all.reduce((s, m) => s + m.paidCount, 0) / totalInv) * 100);
  for (const [k, m] of Object.entries(r.byPersona)) {
    (perPersona[k] ??= []).push(m.dso);
  }
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

console.log(`untreated ledger, ${INVOICES} invoices x ${SEEDS.length} seeds, ${HORIZON}d horizon\n`);
console.log("persona".padEnd(18) + "weight".padStart(8) + "DSO".padStart(9) + "  target-sensitive");
console.log("-".repeat(52));
for (const [k, xs] of Object.entries(perPersona).sort()) {
  const w = file.personas[k]?.weight ?? 0;
  console.log(k.padEnd(18) + w.toFixed(2).padStart(8) + mean(xs).toFixed(1).padStart(9));
}
console.log("-".repeat(52));
console.log("weighted DSO".padEnd(18) + "".padStart(8) + mean(overall).toFixed(1).padStart(9) + "   target ~73");
console.log("paid within horizon".padEnd(26) + mean(paidPct).toFixed(1).padStart(9) + "%");
