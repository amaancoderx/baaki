import { formatINR } from "@baaki/core";
import { runSim, type SimMetrics } from "./engine.js";

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : Number(process.argv[i + 1]);
};

const seeds = arg("seeds", 3);
const invoices = arg("invoices", 300);
const horizon = arg("horizon", 120);

function row(label: string, m: SimMetrics): string {
  const pct = m.billed === 0 ? 0 : (m.collectedTotal / m.billed) * 100;
  return [
    label.padEnd(16),
    String(m.invoices).padStart(5),
    formatINR(m.collectedTotal).padStart(14),
    `${pct.toFixed(1)}%`.padStart(7),
    m.dso.toFixed(1).padStart(7),
    String(m.touches).padStart(8),
    m.touchesPerLakhCollected.toFixed(2).padStart(9),
    `${(m.promiseKeptRate * 100).toFixed(0)}%`.padStart(7),
    String(m.complaints).padStart(6),
    String(m.dncEvents).padStart(5),
    String(m.blockedAttempts).padStart(8),
  ].join(" ");
}

const header = [
  "arm/persona".padEnd(16), "inv".padStart(5), "collected".padStart(14),
  "pct".padStart(7), "dso".padStart(7), "touches".padStart(8),
  "t/lakh".padStart(9), "keep".padStart(7), "cmpl".padStart(6),
  "dnc".padStart(5), "blocked".padStart(8),
].join(" ");

for (let s = 1; s <= seeds; s++) {
  const r = await runSim({ seed: s * 7919, invoices, horizonDays: horizon, holdout: 0.2 });
  console.log(`\nseed ${s * 7919}  (${invoices} invoices, ${horizon}d horizon)`);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const [k, m] of Object.entries(r.byArm)) console.log(row(k, m));
  console.log("-".repeat(header.length));
  for (const [k, m] of Object.entries(r.byPersona).sort()) console.log(row(k, m));
}
