import { Ledger, type LedgerSnapshot } from "./ledger.js";
import { systemClock, type Clock } from "./time.js";
import { DEFAULT_POLICY, type Policy } from "./types.js";

/**
 * Redis-backed ledger, for when the app does not own a filesystem.
 *
 * Serverless functions get an ephemeral disk and no shared state between
 * instances, so a JSON file on disk works locally and silently loses every
 * write in production. The whole ledger is one key: it is small, it is read and
 * written as a unit, and a single document keeps the append-only audit log
 * consistent with the invoices it describes.
 */

export interface RedisLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
}

const KEY = { ledger: "baaki:ledger", policy: "baaki:policy", contacts: "baaki:contacts" } as const;

export class RedisLedgerStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly clock: Clock = systemClock(),
  ) {}

  async load(policy: Policy = DEFAULT_POLICY): Promise<Ledger> {
    const snap = await this.redis.get<LedgerSnapshot | string>(KEY.ledger);
    if (!snap) return new Ledger({ policy, clock: this.clock });
    const parsed = typeof snap === "string" ? (JSON.parse(snap) as LedgerSnapshot) : snap;
    // Live policy wins over whatever was stored with the snapshot.
    return Ledger.fromJSON(parsed, { policy, clock: this.clock });
  }

  async save(ledger: Ledger): Promise<void> {
    await this.redis.set(KEY.ledger, JSON.stringify(ledger.toJSON()));
  }

  /**
   * Read, mutate, write. Not transactional: two webhook deliveries landing in
   * the same millisecond could interleave. Acceptable here because the ledger
   * is one merchant's book and deliveries are seconds apart; a busier one
   * wants per-invoice keys and a WATCH.
   */
  async update<T>(fn: (l: Ledger) => Promise<T> | T, policy: Policy = DEFAULT_POLICY): Promise<T> {
    const l = await this.load(policy);
    const out = await fn(l);
    await this.save(l);
    return out;
  }

  async loadPolicy(): Promise<Policy> {
    const p = await this.redis.get<Policy | string>(KEY.policy);
    if (!p) return DEFAULT_POLICY;
    return { ...DEFAULT_POLICY, ...(typeof p === "string" ? JSON.parse(p) : p) };
  }

  async savePolicy(patch: Partial<Policy>): Promise<Policy> {
    const next = { ...(await this.loadPolicy()), ...patch };
    await this.redis.set(KEY.policy, JSON.stringify(next));
    return next;
  }

  async loadContacts<T>(seed: () => T[]): Promise<T[]> {
    const c = await this.redis.get<T[] | string>(KEY.contacts);
    if (!c) {
      const fresh = seed();
      await this.redis.set(KEY.contacts, JSON.stringify(fresh));
      return fresh;
    }
    return typeof c === "string" ? (JSON.parse(c) as T[]) : c;
  }

  async saveContacts<T>(contacts: T[]): Promise<void> {
    await this.redis.set(KEY.contacts, JSON.stringify(contacts));
  }
}
