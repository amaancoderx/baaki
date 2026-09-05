import { json, readState } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One implementation, not two. This route used to rebuild the state shape by
 * hand, and the copy drifted: it never carried demoOffsetMs and it aged every
 * case against the wall clock. The voice bridge reads this endpoint to learn
 * what day it is, so on a moved calendar the agent phoned people and then
 * resolved "parso" against a date the ledger had already lived past.
 */
export async function GET() {
  return json(await readState());
}
