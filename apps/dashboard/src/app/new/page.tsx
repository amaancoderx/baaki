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
        <h1 className="h1">Naya invoice</h1>
        <div className="explain" style={{ marginTop: 16 }}>
          <span className="tag">Service band hai</span>
          Webhook service chal nahi raha. Terminal mein{" "}
          <code className="mono">pnpm webhook</code> chalao, phir page refresh karo.
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <header style={{ marginBottom: 20 }}>
        <h1 className="h1">Naya invoice</h1>
        <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
          Buyer chuno, amount daalo, rules set karo. Uske baad agent sambhal lega.
        </p>
      </header>
      <NewInvoice contacts={state.contacts} policy={state.policy} />
    </div>
  );
}
