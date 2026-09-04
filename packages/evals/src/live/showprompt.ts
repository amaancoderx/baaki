import { LedgerStore, DEFAULT_POLICY, renderCase, AGENT_SYSTEM } from "@baaki/core";
const l = new LedgerStore("data/ledger.json").load(DEFAULT_POLICY);
const inv = l.openInvoices()[0]!;
const c = l.caseFile(inv.id, Date.now());
console.log("---------------- SYSTEM (timing paragraph) ----------------");
const m = AGENT_SYSTEM.match(/Timing is not your job[\s\S]*?guards\./);
console.log(m ? m[0] : "!! timing paragraph MISSING from system prompt");
console.log("\n---------------- CASE ----------------");
console.log(renderCase(c));
