import { fastPath, route, templateDraft, type CaseFile, type Decision } from "@baaki/core";
import { runSim } from "@baaki/sim";

const perInvoice = new Map<string, string[]>();
const decider = (c: CaseFile): Decision => {
  const arr = perInvoice.get(c.invoice.id) ?? [];
  arr.push(`${c.today}:${route(c).reason}`);
  perInvoice.set(c.invoice.id, arr);
  const fp = fastPath(c, (r, p) => templateDraft(c, r, p));
  return {
    action: fp.action, rationale: fp.rationale, confidence: 1, actor: "fast",
    ...(fp.nextReviewAt ? { nextReviewAt: fp.nextReviewAt } : {}),
  };
};

const r = await runSim({ seed: 7919, invoices: 300, horizonDays: 120, holdout: 0.5, slowDecider: decider });
const counts = [...perInvoice.values()].map((v) => v.length);
const total = counts.reduce((a, b) => a + b, 0);
console.log(`  invoices escalated at least once : ${counts.length}`);
console.log(`  total slow-path decisions        : ${total}`);
console.log(`  mean escalations per such invoice: ${(total / Math.max(1, counts.length)).toFixed(1)}`);
console.log(`  worst single invoice             : ${Math.max(...counts)}`);
console.log(`\n  reasons:`);
const reasons: Record<string, number> = {};
for (const v of perInvoice.values()) for (const e of v) { const k = e.split(":")[1]!; reasons[k] = (reasons[k] ?? 0) + 1; }
for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(5)}  ${k}`);
const worst = [...perInvoice.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
console.log(`\n  worst invoice ${worst[0]}, first 8 of ${worst[1].length}:`);
for (const e of worst[1].slice(0, 8)) console.log(`    ${e}`);
