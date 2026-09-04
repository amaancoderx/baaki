import { loadSnapshot } from "@/lib/data";
import { formatINRCompact } from "@/lib/format";
import { TodayBoard } from "@/components/TodayBoard";

export default function TodayPage() {
  const snap = loadSnapshot();
  const t = snap.totals;

  const open = snap.cases.filter(
    (c) => c.invoice.substate !== "paid" && c.invoice.substate !== "closed",
  );
  const needsApproval = open.filter(
    (c) =>
      c.proposal.allowed &&
      (c.proposal.action.kind === "send_nudge" || c.proposal.action.kind === "escalate_to_human"),
  );

  return (
    <div className="container">
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 className="h1">Today</h1>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 4 }}>
            One proposed action per open invoice. Guards re-run before anything sends.
          </p>
        </div>
      </header>

      <section className="stats rise" style={{ marginBottom: 32 }}>
        <div className="stat">
          <span className="overline">Outstanding</span>
          <span className="stat-value">{formatINRCompact(t.outstanding)}</span>
          <span className="stat-sub">of {formatINRCompact(t.billed)} billed</span>
        </div>
        <div className="stat">
          <span className="overline">Collected</span>
          <span className="stat-value">{formatINRCompact(t.collected)}</span>
          <span className="stat-sub">{((t.collected / t.billed) * 100).toFixed(1)}% of billed</span>
        </div>
        <div className="stat">
          <span className="overline">Open</span>
          <span className="stat-value">{t.open}</span>
          <span className="stat-sub">{t.overdue} overdue</span>
        </div>
        <div className="stat">
          <span className="overline">Held</span>
          <span className="stat-value">{t.onPromise + t.disputed}</span>
          <span className="stat-sub">{t.onPromise} promised · {t.disputed} disputed</span>
        </div>
        <div className="stat">
          <span className="overline">For approval</span>
          <span className="stat-value" style={{ color: "var(--accent-deep)" }}>{needsApproval.length}</span>
          <span className="stat-sub">{t.humanHold} with humans</span>
        </div>
      </section>

      <TodayBoard cases={open} />
    </div>
  );
}
