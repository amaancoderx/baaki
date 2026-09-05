import { RunPanel } from "@/components/RunPanel";

export const dynamic = "force-dynamic";

export default function RunPage() {
  return (
    <div className="container">
      <header style={{ marginBottom: 20 }}>
        <h1 className="h1">Run agent</h1>
        <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
          One bounded decision per open invoice. Guards run before anything is sent.
        </p>
      </header>
      <RunPanel />
    </div>
  );
}
