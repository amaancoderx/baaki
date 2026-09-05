import { baaki, json } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const report = await (await baaki()).tick();
  return json(report);
}
