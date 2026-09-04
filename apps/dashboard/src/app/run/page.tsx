import { RunPanel } from "@/components/RunPanel";

export const dynamic = "force-dynamic";

export default function RunPage() {
  return (
    <div className="container">
      <header style={{ marginBottom: 20 }}>
        <h1 className="h1">Agent run</h1>
        <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
          Har khule invoice pe ek bounded decision. Guards har action se pehle chalte hain.
        </p>
      </header>
      <RunPanel />
    </div>
  );
}
