import { describe, expect, it, beforeAll } from "vitest";
import { runSim, type SimMetrics } from "@baaki/sim";

/**
 * A change that should not touch an arm must not move it.
 *
 * Two measurement bugs got past everything else because nothing watched for
 * this. Modelling a human who works the escalation queue moved the *baseline*
 * arm, which never escalates and so cannot have a queue, from 88.0% to 77.7%.
 * The number that moved was the one that proved the change was wrong, and it
 * was only noticed by eye.
 *
 * These goldens are not claims about the right policy. They are tripwires: if
 * one moves, either the change was broader than intended or the golden needs
 * updating deliberately, with the reason written down.
 */

const SEEDS = [7919, 15838, 23757];
const OPTS = { invoices: 400, horizonDays: 120, holdout: 0.5 } as const;

const pct = (m: SimMetrics) => (m.billed === 0 ? 0 : (m.collectedTotal / m.billed) * 100);

describe("arm invariance", () => {
  const noQueue: Record<number, number> = {};

  beforeAll(async () => {
    for (const seed of SEEDS) {
      const r = await runSim({ seed, ...OPTS });
      noQueue[seed] = pct(r.byArm.baseline!);
    }
  }, 240_000);

  it("a human who resolves nothing is indistinguishable from no human at all", async () => {
    // The sharp version of this check. Watching the baseline arm is not enough:
    // baseline never escalates, so a bug in the queue cannot move it, and the
    // first version of this test passed with the bug reintroduced.
    //
    // At resolveProb 0 the person looks at each escalated case, fails to
    // recover it, and does nothing. Every arm must be byte-identical to a run
    // with no queue configured. The bug that closed the invoice on failure
    // moved the treated arm from 88.0% to 77.7% and would fail here.
    for (const seed of SEEDS) {
      const without = await runSim({ seed, ...OPTS });
      const withIdle = await runSim({ seed, ...OPTS, humanQueue: { resolveProb: 0, reviewDelayDays: 3 } });
      for (const arm of ["baaki", "baseline"] as const) {
        expect(pct(withIdle.byArm[arm]!), `${arm} seed ${seed}`)
          .toBeCloseTo(pct(without.byArm[arm]!), 6);
        expect(withIdle.byArm[arm]!.touches, `${arm} touches seed ${seed}`)
          .toBe(without.byArm[arm]!.touches);
      }
    }
  }, 600_000);

  it("the human queue never moves the baseline arm, at any resolution rate", async () => {
    // The baseline policy has no escalate_to_human action, so no baseline
    // invoice can ever reach the queue. Any movement here means the queue is
    // reaching invoices it should not.
    for (const resolveProb of [0, 0.5, 1]) {
      for (const seed of SEEDS) {
        const r = await runSim({ seed, ...OPTS, humanQueue: { resolveProb, reviewDelayDays: 3 } });
        expect(pct(r.byArm.baseline!), `seed ${seed} at resolveProb ${resolveProb}`)
          .toBeCloseTo(noQueue[seed]!, 6);
      }
    }
  }, 600_000);

  it("the holdout split does not change how a given buyer behaves", async () => {
    // Same seed, different split. A buyer's payment draws come from their own
    // stream, so whether they landed in the treatment or holdout arm must not
    // change what they would have done.
    const a = await runSim({ seed: 7919, ...OPTS, holdout: 0.2 });
    const b = await runSim({ seed: 7919, ...OPTS, holdout: 0.8 });
    const personas = new Set([...Object.keys(a.byPersona), ...Object.keys(b.byPersona)]);
    expect(personas.size).toBeGreaterThan(4);
    // Population composition is fixed by the setup stream regardless of split.
    for (const p of personas) {
      const na = a.byPersona[p]?.invoices ?? 0;
      const nb = b.byPersona[p]?.invoices ?? 0;
      expect(nb, `persona ${p} count`).toBe(na);
    }
  }, 240_000);

  it("an untreated run is unaffected by policy knobs it cannot use", async () => {
    // Nobody is contacted, so touch budgets and rung gaps are inert. If these
    // move the untreated arm, the calibration figure is not measuring what it
    // claims to.
    const base = await runSim({ seed: 7919, ...OPTS, holdout: 0, untreated: true });
    const { DEFAULT_POLICY } = await import("@baaki/core");
    const changed = await runSim({
      seed: 7919, ...OPTS, holdout: 0, untreated: true,
      policy: { ...DEFAULT_POLICY, maxTouches: 1, rungGapDays: [0, 30, 30, 30, 30], silentTouchCap: 1 },
    });
    const collected = (r: typeof base) =>
      Object.values(r.byPersona).reduce((s, m) => s + m.collectedTotal, 0);
    expect(collected(changed)).toBe(collected(base));
  }, 240_000);

  it("guard violations stay at zero in every arm", async () => {
    for (const seed of SEEDS) {
      const r = await runSim({ seed, ...OPTS, humanQueue: { resolveProb: 0.5, reviewDelayDays: 3 } });
      for (const [arm, m] of Object.entries(r.byArm)) {
        expect(m.guardViolations, `${arm} seed ${seed}`).toBe(0);
      }
    }
  }, 240_000);
});
