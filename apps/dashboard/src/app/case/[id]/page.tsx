import Link from "next/link";
import { notFound } from "next/navigation";
import { loadSnapshot } from "@/lib/data";
import {
  daysBetween, formatDate, formatDateShort, formatINR, formatTs, overdueSeverity,
} from "@/lib/format";
import type { CaseView, TimelineEvent } from "@/lib/types";

export function generateStaticParams() {
  return loadSnapshot().cases.map((c) => ({ id: c.invoice.id }));
}

const substateChip: Record<string, { cls: string; label: string }> = {
  awaiting_reply: { cls: "chip-neutral", label: "awaiting reply" },
  promised: { cls: "chip-warning", label: "promised" },
  disputed: { cls: "chip-alert", label: "disputed" },
  human_hold: { cls: "chip-ink", label: "with a human" },
  paid: { cls: "chip-accent", label: "paid" },
  closed: { cls: "chip-neutral", label: "closed" },
};

function EvidenceLinks({ ids }: { ids: string[] }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {ids.map((id) => (
        <a key={id} href={`#${id}`} className="evidence">{id}</a>
      ))}
    </span>
  );
}

function TimelineItem({ e }: { e: TimelineEvent }) {
  const body =
    e.type === "touch" ? (e.detail.body as string)
    : e.type === "reply" ? (e.detail.text as string)
    : e.type === "decision" ? (e.detail.rationale as string)
    : null;

  return (
    <div className="tl-item" id={e.id}>
      <span className={`tl-dot ${e.type}`} />
      <div style={{ padding: "0 0 0 4px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{e.summary}</span>
          {e.type === "payment" && (
            <span className="num chip chip-accent">{formatINR(e.detail.amount as number)}</span>
          )}
          <span className="num" style={{ fontSize: 11, color: "var(--text-4)", marginLeft: "auto" }}>
            {formatTs(e.ts)}
          </span>
        </div>
        {body && (
          <p style={{
            fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.55,
            borderLeft: "2px solid var(--hairline)", paddingLeft: 10,
          }}>
            {body}
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
          <details>
            <summary>raw evidence</summary>
            <pre className="tl-raw">{JSON.stringify({ id: e.id, ts: e.ts, ...e.detail, evidence: e.evidence }, null, 2)}</pre>
          </details>
          <EvidenceLinks ids={e.evidence} />
        </div>
      </div>
    </div>
  );
}

function MemoryBar({ value }: { value: number }) {
  return (
    <span style={{
      display: "inline-block", width: 48, height: 4, background: "rgba(31,30,29,0.08)",
      borderRadius: 999, verticalAlign: "middle", marginLeft: 8,
    }}>
      <span style={{
        display: "block", width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`,
        height: "100%", background: "var(--accent)", borderRadius: 999,
      }} />
    </span>
  );
}

function Rail({ c, today }: { c: CaseView; today: string }) {
  const m = c.memory;
  const inv = c.invoice;
  const promiseDays = inv.promisedFor ? daysBetween(today, inv.promisedFor) : null;

  return (
    <aside style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", gap: 0 }}>
      {inv.substate === "promised" && inv.promisedFor && (
        <div className="panel panel-tint" style={{ marginBottom: 12 }}>
          <div className="overline" style={{ marginBottom: 8 }}>Active promise</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="num" style={{ fontSize: 28, fontFamily: "var(--font-serif)" }}>
              {promiseDays !== null && promiseDays >= 0 ? promiseDays : 0}
            </span>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              day{promiseDays === 1 ? "" : "s"} to {formatDateShort(inv.promisedFor)}
            </span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-3)", marginTop: 6 }}>
            Outreach is frozen until the day after. If no payment lands, the router
            hands the case to judgment.
          </p>
        </div>
      )}

      <div className="panel">
        <div className="overline" style={{ marginBottom: 8 }}>Next step</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span className="chip chip-ink">
            {c.proposal.action.kind.replace(/_/g, " ")}
          </span>
          <span className={`chip ${c.proposal.route === "slow" ? "chip-accent" : "chip-neutral"}`}>
            {c.proposal.route === "slow" ? "case agent" : "rules"}
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
          {c.proposal.rationale}
        </p>
        <p style={{ fontSize: 11, color: "var(--text-4)", marginTop: 8 }}>
          Every guard re-runs at send time; a decision made now does not skip the
          check later.
        </p>
        <div className="guards" style={{ marginTop: 8 }}>
          {c.proposal.guards.filter((g) => !g.pass).length === 0 ? (
            <span className="guard"><span className="tick">✓</span> all {c.proposal.guards.length} guards pass</span>
          ) : (
            c.proposal.guards.filter((g) => !g.pass).map((g) => (
              <span key={g.name} className="guard failed" title={g.detail}>
                <span className="tick">✕</span> {g.name.replace(/_/g, " ")}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="overline" style={{ marginBottom: 4 }}>Buyer memory</div>
        <div className="stat-row">
          <span className="k">Avg days late</span>
          <span className="v">{m.avgDaysLate.toFixed(1)}</span>
        </div>
        <div className="stat-row">
          <span className="k">Promises kept</span>
          <span className="v">
            {m.counts.promisesMade === 0 ? "no promises yet" : `${m.counts.promisesKept}/${m.counts.promisesMade}`}
            {m.counts.promisesMade > 0 && <MemoryBar value={m.promiseKeptRate} />}
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Replies per touch</span>
          <span className="v">
            {(m.repliesPerTouch.whatsapp).toFixed(2)}
            <MemoryBar value={m.repliesPerTouch.whatsapp} />
          </span>
        </div>
        <div className="stat-row">
          <span className="k">Disputes raised</span>
          <span className="v">{m.counts.disputesRaised}</span>
        </div>
        <div className="stat-row">
          <span className="k">Language</span>
          <span className="v">{m.language}</span>
        </div>
        <div className="stat-row">
          <span className="k">Do not contact</span>
          <span className="v" style={m.doNotContact ? { color: "#b04a28" } : {}}>
            {m.doNotContact ? "yes — permanent" : "no"}
          </span>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="overline" style={{ marginBottom: 4 }}>Invoice</div>
        <div className="stat-row"><span className="k">Issued</span><span className="v num">{formatDateShort(c.invoice.issuedOn)}</span></div>
        <div className="stat-row"><span className="k">Due</span><span className="v num">{formatDateShort(c.invoice.dueOn)}</span></div>
        <div className="stat-row">
          <span className="k">Payment link</span>
          <span className="v num" style={inv.linkExpiresOn && inv.linkExpiresOn < today ? { color: "#b04a28" } : {}}>
            {inv.linkExpiresOn ? (inv.linkExpiresOn < today ? `expired ${formatDateShort(inv.linkExpiresOn)}` : `live to ${formatDateShort(inv.linkExpiresOn)}`) : "none"}
          </span>
        </div>
        <div className="stat-row"><span className="k">Campaign ends</span><span className="v num">{formatDateShort(c.invoice.campaignEndsOn)}</span></div>
      </div>
    </aside>
  );
}

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snap = loadSnapshot();
  const c = snap.cases.find((x) => x.invoice.id === id);
  if (!c) notFound();

  const inv = c.invoice;
  const sub = substateChip[inv.substate]!;
  const sev = overdueSeverity(c.daysOverdue);

  return (
    <div className="container">
      <Link href="/" style={{ fontSize: 12, color: "var(--text-3)" }}>← Today</Link>

      <header style={{ display: "flex", alignItems: "flex-start", gap: 16, marginTop: 12, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="h1">{c.buyer.name}</h1>
            <span className={`chip ${sub.cls}`}>{sub.label}</span>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 12, color: "var(--text-3)", alignItems: "center" }}>
            <span className="mono">{inv.id}</span>
            <span className="mono">{c.buyer.phone}</span>
            {c.daysOverdue > 0 && (
              <span className={`chip ${sev === "alert" ? "chip-alert" : sev === "warning" ? "chip-warning" : "chip-neutral"} num`}>
                {c.daysOverdue}d overdue
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="num" style={{ fontSize: 26, fontFamily: "var(--font-serif)", letterSpacing: "-0.01em" }}>
            {formatINR(c.outstanding)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }} className="num">
            {inv.amountPaid > 0 ? `${formatINR(inv.amountPaid)} paid of ${formatINR(inv.amount)}` : `due ${formatDate(inv.dueOn)}`}
          </div>
        </div>
      </header>

      <section
        className="panel rise"
        style={{ marginBottom: 24, background: "var(--surface)", borderColor: "rgba(31,30,29,0.08)" }}
      >
        <div className="overline" style={{ marginBottom: 8 }}>Story so far</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {c.story.map((s, i) => (
            <p key={i} style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-2)" }}>
              {s.text}{" "}
              <EvidenceLinks ids={s.cites.slice(0, 4)} />
            </p>
          ))}
        </div>
      </section>

      <div style={{ display: "flex", gap: 32, alignItems: "flex-start" }}>
        <section style={{ flex: 1, minWidth: 0 }}>
          <h2 className="h2" style={{ marginBottom: 16 }}>
            Timeline <span style={{ color: "var(--text-4)" }}>· {c.timeline.length} events</span>
          </h2>
          {c.timeline.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-3)" }}>Nothing has happened yet.</p>
          ) : (
            <div className="timeline">
              {c.timeline.map((e) => <TimelineItem key={e.id} e={e} />)}
            </div>
          )}
        </section>

        <Rail c={c} today={snap.date} />
      </div>
    </div>
  );
}
