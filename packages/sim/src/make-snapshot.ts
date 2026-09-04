import { makeSnapshot } from "./snapshot.js";

const snap = await makeSnapshot({
  seed: Number(process.argv[2] ?? 2018),
  invoices: Number(process.argv[3] ?? 60),
  day: Number(process.argv[4] ?? 59),
  out: process.argv[5] ?? "apps/dashboard/data/snapshot.json",
});
const open = snap.cases.filter((c) => c.invoice.substate !== "paid" && c.invoice.substate !== "closed");
console.log(`snapshot: seed ${snap.seed}, frozen at ${snap.date} (day ${snap.day}), ${snap.cases.length} invoices, ${open.length} open`);
