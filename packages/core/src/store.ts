import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger, type LedgerSnapshot } from "./ledger.js";
import { systemClock, type Clock } from "./time.js";
import { DEFAULT_POLICY, type Policy } from "./types.js";

/**
 * File-backed ledger. The live app spans processes (a webhook delivery, a
 * dashboard render, a scheduled tick), so the ledger has to survive each of
 * them. Writes go through a temp file and a rename so a crash mid-write cannot
 * leave a half-written ledger behind.
 */
export class LedgerStore {
  constructor(
    private readonly path: string,
    private readonly clock: Clock = systemClock(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * The caller's policy wins over the one in the snapshot. Policy is live
   * configuration a merchant edits; the ledger is history. Letting the stored
   * copy win meant an edited contact window was written to disk, ignored on
   * load, and the guards kept enforcing the window from whenever the first
   * invoice happened to be raised.
   */
  load(policy: Policy = DEFAULT_POLICY): Ledger {
    if (!existsSync(this.path)) return new Ledger({ policy, clock: this.clock });
    const snap = JSON.parse(readFileSync(this.path, "utf8")) as LedgerSnapshot;
    return Ledger.fromJSON(snap, { policy, clock: this.clock });
  }

  save(ledger: Ledger): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger.toJSON(), null, 2));
    renameSync(tmp, this.path);
  }

  /** Load, mutate, save. Keeps callers from forgetting the save. */
  async update<T>(fn: (l: Ledger) => Promise<T> | T, policy: Policy = DEFAULT_POLICY): Promise<T> {
    const l = this.load(policy);
    const out = await fn(l);
    this.save(l);
    return out;
  }
}

/**
 * What Baaki needs from a store. The file-backed one is synchronous and the
 * Redis one is not, so callers await either; awaiting a non-promise costs a
 * microtask and lets the same runtime serve a laptop and a serverless function.
 */
export interface LedgerStoreLike {
  load(policy?: Policy): Ledger | Promise<Ledger>;
  save(ledger: Ledger): void | Promise<void>;
  update<T>(fn: (l: Ledger) => Promise<T> | T, policy?: Policy): Promise<T>;
}

export const defaultStorePath = (root = process.cwd()): string => join(root, "data", "ledger.json");
