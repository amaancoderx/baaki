/**
 * Mutual exclusion and idempotency over Redis.
 *
 * Three things can touch the same invoice at the same moment: a Razorpay
 * webhook, a WhatsApp webhook, and a scheduled tick, on different function
 * instances, against shared state. Both providers retry deliveries when they do
 * not get a fast 2xx, so the same event arrives more than once as a matter of
 * course rather than as an edge case.
 *
 * The failure modes are the ones this product exists to prevent: a nudge sent
 * seconds after payment, or a duplicate nudge from a redelivered event.
 */

export interface LockRedis {
  set(key: string, value: unknown, opts?: { nx?: boolean; px?: number; ex?: number }): Promise<unknown>;
  get<T = unknown>(key: string): Promise<T | null>;
  eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>;
  del(...keys: string[]): Promise<unknown>;
}

/** Release only if we still hold it: a lock that expired belongs to someone else. */
const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export class LockHeld extends Error {
  constructor(readonly key: string) {
    super(`lock held: ${key}`);
    this.name = "LockHeld";
  }
}

export class Locks {
  constructor(private readonly redis: LockRedis) {}

  /**
   * True the first time an event id is seen, false on every redelivery.
   * Kept for a week: providers retry for hours, not days.
   */
  async firstSeen(provider: string, eventId: string, ttlSeconds = 7 * 86_400): Promise<boolean> {
    const res = await this.redis.set(`evt:${provider}:${eventId}`, "1", { nx: true, ex: ttlSeconds });
    return res !== null;
  }

  /**
   * Runs `fn` holding an exclusive lock. Everything inside must re-read state:
   * whatever was true before the lock was acquired may not be true now.
   */
  async with<T>(key: string, fn: () => Promise<T>, ttlMs = 10_000): Promise<T> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const got = await this.redis.set(`lock:${key}`, token, { nx: true, px: ttlMs });
    if (got === null) throw new LockHeld(key);
    try {
      return await fn();
    } finally {
      // Token-checked so a slow caller cannot delete a lock that has since
      // expired and been taken by someone else.
      await this.redis.eval(RELEASE, [`lock:${key}`], [token]).catch(() => {});
    }
  }

  /** Same, but returns null instead of throwing when the lock is held. */
  async tryWith<T>(key: string, fn: () => Promise<T>, ttlMs = 10_000): Promise<T | null> {
    try {
      return await this.with(key, fn, ttlMs);
    } catch (e) {
      if (e instanceof LockHeld) return null;
      throw e;
    }
  }
}

export const invoiceLock = (id: string): string => `inv:${id}`;
export const TICK_LOCK = "tick";
