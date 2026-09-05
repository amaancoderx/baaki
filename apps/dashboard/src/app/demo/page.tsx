import { ladderProblem } from "@baaki/core";
import { DemoRun } from "@/components/DemoRun";
import { readState } from "@/lib/server";
import type { AppState } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function DemoPage() {
  let state: AppState;
  try {
    state = await readState();
  } catch {
    return (
      <div className="container">
        <h1 className="h1">Demo run</h1>
        <div className="explain" style={{ marginTop: 16 }}>
          <span className="tag">Cannot reach the ledger</span>
          The ledger could not be read.
        </div>
      </div>
    );
  }

  const problem = ladderProblem(state.policy as never);
  const compressed = state.policy.policyVersion?.endsWith("demo") ?? false;

  return (
    <div className="container">
      <header style={{ marginBottom: 20 }}>
        <h1 className="h1">Demo run</h1>
        <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
          The whole life of an invoice, from issuing it to getting paid, in a few clicks.
        </p>
      </header>
      {compressed && (
        <div className="explain" style={{ marginBottom: 16 }}>
          <span className="tag">Compressed calendar</span>
          This run uses a <strong>2-day cadence</strong> so the whole life of an invoice
          fits in a few minutes. The shipped policy waits <strong>10 to 18 days</strong>
          between messages, and that is not caution for its own sake: at gaps this tight
          the ladder put three messages inside every buyer&rsquo;s patience window and
          produced 55 complaints and 26 opt-outs while collecting no more money. Same
          code, same guards, same ladder. Only the gaps differ.
        </div>
      )}

      {problem && (
        <div className="explain" style={{ marginBottom: 16, borderColor: "#e0b4a4" }}>
          <span className="tag" style={{ color: "#b04a28" }}>The ladder cannot finish</span>
          {problem} Nothing will crash; the rung simply never fires, so the final
          notice on both channels never goes out.
        </div>
      )}
      <DemoRun contacts={state.contacts} state={state} compressed={compressed} />
    </div>
  );
}
