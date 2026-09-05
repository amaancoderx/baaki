import { NewInvoice } from "@/components/NewInvoice";
import { readState } from "@/lib/server";
import type { AppState } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  let state: AppState;
  try {
    state = await readState();
  } catch {
    return (
      <div className="container">
        <h1 className="h1">New invoice</h1>
        <div className="explain" style={{ marginTop: 16 }}>
          <span className="tag">Service down</span>
          The webhook service is not running. Start it with{" "}
          <code className="mono">pnpm webhook</code>, then reload this page.
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <header style={{ marginBottom: 20 }}>
        <h1 className="h1">New invoice</h1>
        <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
          Pick a buyer, set the amount and the rules. The agent takes it from there.
        </p>
      </header>
      <NewInvoice contacts={state.contacts} policy={state.policy} />
    </div>
  );
}
