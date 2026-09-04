/**
 * Per-arm x per-persona diagnostic. The headline arm table hides which buyer
 * types the loop actually helps, and with a 20% holdout the baseline cell is
 * small enough that a single seed says nothing.
 */
import { runSim, type SimMetrics } from "./engine.js";

const SEEDS = [7919, 15838, 23757, 31676, 39595, 47514, 55433, 63352, 71271, 79190];
const INVOICES = 400;
const HORIZON = 120;

interface Cell { inv: number; billed: number; collected: number; dsoSum: number; touches: number }
const cells = new Map<string, Cell>();

const key = (arm: string, persona: string) => `${arm}|${persona}`;

for (const seed of SEEDS) {
  const r = await runSim({ seed, invoices: INVOICES, horizonDays: HORIZON, holdout: 0.5 });
  for (const inv of r.ledger.invoices()) {
    const persona = r.ledger.buyer(inv.buyerId).hiddenPersonaKey ?? "unknown";
    const k = key(inv.arm, persona);
    const c = cells.get(k) ?? { inv: 0, billed: 0, collected: 0, dsoSum: 0, touches: 0 };
    c.inv += 1;
    c.billed += inv.amount;
    c.collected += inv.amountPaid;
    c.touches += r.ledger.touchesFor(inv.id).length;
    cells.set(k, c);
  }
  for (const [k, m] of Object.entries(r.byPersona)) void k, m;
}

const personas = [...new Set([...cells.keys()].map((k) => k.split("|")[1]!))].sort();

console.log(`per-persona, per-arm  (${SEEDS.length} seeds x ${INVOICES} invoices, 50% holdout, ${HORIZON}d)\n`);
console.log("persona".padEnd(18) + "n(bk)".padStart(7) + "n(bl)".padStart(7) +
            "collected% bk".padStart(15) + "collected% bl".padStart(15) +
            "delta".padStart(9) + "t/inv bk".padStart(10) + "t/inv bl".padStart(10));
console.log("-".repeat(91));

let totBk = { c: 0, b: 0 }, totBl = { c: 0, b: 0 };
for (const p of personas) {
  const bk = cells.get(key("baaki", p));
  const bl = cells.get(key("baseline", p));
  if (!bk || !bl) continue;
  const pbk = (bk.collected / bk.billed) * 100;
  const pbl = (bl.collected / bl.billed) * 100;
  totBk.c += bk.collected; totBk.b += bk.billed;
  totBl.c += bl.collected; totBl.b += bl.billed;
  const delta = pbk - pbl;
  console.log(
    p.padEnd(18) + String(bk.inv).padStart(7) + String(bl.inv).padStart(7) +
    pbk.toFixed(1).padStart(15) + pbl.toFixed(1).padStart(15) +
    (delta >= 0 ? "+" : "") + delta.toFixed(1).padStart(8) +
    (bk.touches / bk.inv).toFixed(2).padStart(10) +
    (bl.touches / bl.inv).toFixed(2).padStart(10),
  );
}
console.log("-".repeat(91));
const pbk = (totBk.c / totBk.b) * 100, pbl = (totBl.c / totBl.b) * 100;
console.log("OVERALL".padEnd(18) + "".padStart(14) + pbk.toFixed(1).padStart(15) + pbl.toFixed(1).padStart(15) +
            ((pbk - pbl) >= 0 ? "+" : "") + (pbk - pbl).toFixed(1).padStart(8));
