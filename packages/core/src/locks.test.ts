import { describe, expect, it } from "vitest";
import { Locks, LockHeld, type LockRedis } from "./locks.js";

/** In-memory stand-in with the same semantics the real client provides. */
function fakeRedis(): LockRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key, value, opts) {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, String(value));
      return "OK";
    },
    async get<T>(key: string) {
      return (store.get(key) ?? null) as T | null;
    },
    async eval<T>(_script: string, keys: string[], args: string[]) {
      // The release script: delete only if the token still matches.
      if (store.get(keys[0]!) === args[0]) { store.delete(keys[0]!); return 1 as T; }
      return 0 as T;
    },
    async del(...keys: string[]) {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
  };
}

describe("idempotency", () => {
  it("treats the first delivery as new and every redelivery as seen", async () => {
    const l = new Locks(fakeRedis());
    expect(await l.firstSeen("razorpay", "evt_1")).toBe(true);
    expect(await l.firstSeen("razorpay", "evt_1")).toBe(false);
    expect(await l.firstSeen("razorpay", "evt_1")).toBe(false);
  });

  it("keys by provider, so ids from different providers cannot collide", async () => {
    const l = new Locks(fakeRedis());
    expect(await l.firstSeen("razorpay", "abc")).toBe(true);
    expect(await l.firstSeen("whatsapp", "abc")).toBe(true);
  });
});

describe("invoice lock", () => {
  it("lets one holder in and refuses the second", async () => {
    const l = new Locks(fakeRedis());
    let inside = 0, peak = 0;
    const work = async () => {
      inside += 1; peak = Math.max(peak, inside);
      await new Promise((r) => setTimeout(r, 20));
      inside -= 1;
      return "done";
    };
    const [a, b] = await Promise.all([
      l.tryWith("inv:1", work),
      l.tryWith("inv:1", work),
    ]);
    expect(peak).toBe(1);
    expect([a, b].filter((x) => x === "done")).toHaveLength(1);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
  });

  it("releases the lock so the next caller can take it", async () => {
    const l = new Locks(fakeRedis());
    expect(await l.tryWith("inv:1", async () => 1)).toBe(1);
    expect(await l.tryWith("inv:1", async () => 2)).toBe(2);
  });

  it("releases even when the work throws", async () => {
    const l = new Locks(fakeRedis());
    await expect(l.with("inv:1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await l.tryWith("inv:1", async () => "free")).toBe("free");
  });

  it("does not delete a lock that has expired and been retaken", async () => {
    const r = fakeRedis();
    const l = new Locks(r);
    const p = l.with("inv:1", async () => {
      // Simulate the lock expiring and another instance taking it.
      r.store.set("lock:inv:1", "someone-else");
      return "ok";
    });
    await p;
    expect(r.store.get("lock:inv:1")).toBe("someone-else");
  });

  it("throws LockHeld from with(), rather than silently proceeding", async () => {
    const r = fakeRedis();
    const l = new Locks(r);
    r.store.set("lock:inv:1", "held-by-another");
    await expect(l.with("inv:1", async () => "should not run")).rejects.toBeInstanceOf(LockHeld);
  });

  it("keeps separate invoices independent", async () => {
    const l = new Locks(fakeRedis());
    const [a, b] = await Promise.all([
      l.tryWith("inv:1", async () => "a"),
      l.tryWith("inv:2", async () => "b"),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
  });
});
