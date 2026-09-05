import { json, store } from "@/lib/server";
import type { Policy } from "@baaki/core";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const patch = (await req.json()) as Partial<Policy>;
  return json({ policy: await store().savePolicy(patch) });
}
