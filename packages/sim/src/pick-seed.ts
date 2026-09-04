/**
 * Scans seeds for a frozen state that carries the full demo story naturally:
 * a broken promise, an open dispute, an owner-rung case, a live promise with a
 * countdown, and a healthy queue of sendable proposals. No outcomes are edited;
 * the seed is just chosen, and the choice is recorded in the snapshot.
 */
import { makeSnapshot } from "./snapshot.js";
import { rmSync } from "node:fs";

const DAYS = process.argv[2] ? [Number(process.argv[2])] : [59, 66, 73];
const N = Number(process.argv[3] ?? 60);

let best = { seed: 0, day: 0, score: -1, desc: "" };

for (const DAY of DAYS) {
for (let s = 1; s <= 40; s++) {
  const seed = s * 1009;
  const snap = await makeSnapshot({ seed, invoices: N, day: DAY, out: "/tmp/baaki-scan.json" });
  const open = snap.cases.filter((c) => c.invoice.substate !== "paid" && c.invoice.substate !== "closed");
  const sendable = open.filter((c) => c.proposal.action.kind === "send_nudge" && c.proposal.allowed);
  const brokenPromise = open.filter((c) => c.proposal.routeReason === "promise broken").length;
  const livePromise = open.filter((c) => c.invoice.substate === "promised").length;
  const disputed = open.filter((c) => c.invoice.substate === "disputed").length;
  const ownerRung = sendable.filter((c) => c.proposal.action.kind === "send_nudge" && c.proposal.action.persona === "owner").length;
  const reissue = sendable.filter((c) => !c.invoice.linkExpiresOn || c.invoice.linkExpiresOn < snap.date).length;

  const score =
    Math.min(sendable.length, 8) * 2 +
    (brokenPromise > 0 ? 6 : 0) +
    (livePromise > 0 ? 5 : 0) +
    (disputed > 0 ? 5 : 0) +
    (ownerRung > 0 ? 4 : 0) +
    (reissue > 0 ? 3 : 0) +
    Math.min(open.length, 20);

  const desc = `open=${open.length} sendable=${sendable.length} broken=${brokenPromise} promise=${livePromise} disputed=${disputed} owner=${ownerRung} reissue=${reissue}`;
  if (score > best.score) best = { seed, day: DAY, score, desc };
}
}

rmSync("/tmp/baaki-scan.json", { force: true });
console.log(`best seed ${best.seed} day ${best.day} (score ${best.score}): ${best.desc}`);
