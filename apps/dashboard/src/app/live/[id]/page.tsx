import Link from "next/link";
import { notFound } from "next/navigation";
import { getState, type LiveInvoice } from "@/lib/api";
import { formatINR, formatDateShort, formatTs } from "@/lib/format";

export const dynamic = "force-dynamic";

const SUBSTATE_HI: Record<string, { hi: string; cls: string; note: string }> = {
  awaiting_reply: { hi: "jawab ka intezaar", cls: "chip-neutral", note: "Message gaya hai, buyer ka reply nahi aaya." },
  promised: { hi: "promise mila hai", cls: "chip-warning", note: "Buyer ne date di hai. Us din tak koi message nahi jayega." },
  disputed: { hi: "dispute khula hai", cls: "chip-alert", note: "Buyer ne sawaal uthaya. Outreach band, merchant ko dekhna hai." },
  human_hold: { hi: "insaan ke paas", cls: "chip-ink", note: "Agent ne haath khada kar diya. Ab automation kuch nahi karega." },
  paid: { hi: "paisa aa gaya", cls: "chip-accent", note: "Razorpay ne confirm kiya. Campaign band." },
  closed: { hi: "band", cls: "chip-neutral", note: "Case band ho chuka hai." },
};

const ACTOR_HI: Record<string, string> = {
  fast: "rule", agent: "Gemini agent", human: "insaan", webhook: "Razorpay/WhatsApp",
};

const ACTION_HI: Record<string, string> = {
  send_nudge: "message bheja", reissue_payment_path: "naya payment link banaya",
  schedule_wait: "wait kiya", open_dispute: "dispute khola",
  escalate_to_human: "insaan ko diya", stop: "band kiya", none: "note",
};

function Timeline({ i }: { i: LiveInvoice }) {
  type Ev = { ts: number; kind: string; title: string; body?: string; meta?: string; evidence?: string[] };
  const events: Ev[] = [
    ...i.touches.map((t) => ({
      ts: t.ts, kind: "touch",
      title: `Message bheja — ${t.persona === "owner" ? "owner ke naam se" : "accounts se"} (${t.rung.replace(/_/g, " ")})`,
      body: t.body,
      meta: t.carriedLiveLink ? "link live tha" : "link dead tha",
      evidence: [t.id],
    })),
    ...i.replies.map((r) => ({
      ts: r.ts, kind: "reply",
      title: `Buyer ka reply — ${r.source === "button" ? "button dabaya" : "khud likha"}`,
      body: r.text,
      meta: `Gemini ne padha: ${r.intent}${r.promiseDate ? ` (${r.promiseDate})` : ""} · confidence ${r.confidence.toFixed(2)}`,
      evidence: [r.id],
    })),
    ...i.payments.map((p) => ({
      ts: p.ts, kind: "payment",
      title: `Payment aaya — ${formatINR(p.amount)}`,
      meta: "Razorpay webhook se confirm hua",
      evidence: [p.evidence],
    })),
    ...i.audit.filter((a) => a.action !== "send_nudge").map((a) => ({
      ts: a.ts, kind: "decision",
      title: `${ACTOR_HI[a.actor] ?? a.actor}: ${ACTION_HI[a.action] ?? a.action}`,
      body: a.rationale,
      meta: a.guards.length ? `${a.guards.filter((g) => g.pass).length}/${a.guards.length} guards pass` : undefined,
      evidence: a.evidence,
    })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <div className="timeline">
      {events.map((e, n) => (
        <div className="tl-item" key={n}>
          <span className={`tl-dot ${e.kind}`} />
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{e.title}</span>
              <span className="num" style={{ fontSize: 11, color: "var(--text-4)", marginLeft: "auto" }}>{formatTs(e.ts)}</span>
            </div>
            {e.body && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.55, borderLeft: "2px solid var(--hairline)", paddingLeft: 10 }}>
                {e.body}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 5, alignItems: "center", flexWrap: "wrap" }}>
              {e.meta && <span style={{ fontSize: 11, color: "var(--text-4)" }}>{e.meta}</span>}
              {e.evidence?.map((ev) => <span key={ev} className="evidence">{ev}</span>)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function LiveCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let state;
  try { state = await getState(); } catch { notFound(); }
  const i = state!.invoices.find((x) => x.invoice.id === id);
  if (!i) notFound();

  const inv = i.invoice;
  const s = SUBSTATE_HI[inv.substate] ?? { hi: inv.substate, cls: "chip-neutral", note: "" };
  const today = new Date().toISOString().slice(0, 10);
  const linkDead = inv.linkExpiresOn !== null && inv.linkExpiresOn < today;

  return (
    <div className="container">
      <Link href="/" style={{ fontSize: 12, color: "var(--text-3)" }}>← Today</Link>

      <header style={{ display: "flex", alignItems: "flex-start", gap: 16, marginTop: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="h1">{i.buyer.name}</h1>
            <span className={`chip ${s.cls}`}>{s.hi}</span>
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 12, color: "var(--text-3)" }}>
            <span className="mono">{inv.id}</span>
            <span className="mono">+{i.buyer.phone}</span>
            {i.daysOverdue > 0 && <span className="chip chip-warning num">{i.daysOverdue}d late</span>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="num" style={{ fontSize: 26, fontFamily: "var(--font-serif)" }}>{formatINR(i.outstanding)}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)" }} className="num">
            {inv.amountPaid > 0 ? `${formatINR(inv.amountPaid)} aa chuka` : `due ${formatDateShort(inv.dueOn)}`}
          </div>
        </div>
      </header>

      <div className="explain" style={{ marginBottom: 20 }}>
        <span className="tag">Abhi kya haal hai</span>
        {s.note}{" "}
        {linkDead && <>Payment link <strong>expire ho chuka</strong> hai — agla message bhejne se pehle agent naya link banayega, warna message bekaar jayega.</>}
      </div>

      <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
        <section style={{ flex: 1, minWidth: 0 }}>
          <h2 className="h2" style={{ marginBottom: 14 }}>
            Pura hisaab <span style={{ color: "var(--text-4)" }}>· {i.touches.length + i.replies.length + i.payments.length + i.audit.length} events</span>
          </h2>
          <Timeline i={i} />
        </section>

        <aside style={{ width: 290, flexShrink: 0 }}>
          {inv.substate === "promised" && inv.promisedFor && (
            <div className="panel panel-tint" style={{ marginBottom: 12 }}>
              <div className="overline" style={{ marginBottom: 6 }}>Promise</div>
              <div className="num" style={{ fontSize: 22, fontFamily: "var(--font-serif)" }}>{formatDateShort(inv.promisedFor)}</div>
              <p className="explain-inline">Us din tak koi message nahi. Agar paisa nahi aaya, agent agle din khud dekhega.</p>
            </div>
          )}

          <div className="panel">
            <div className="overline" style={{ marginBottom: 6 }}>Razorpay</div>
            {i.external.shortUrl ? (
              <>
                <a href={i.external.shortUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--accent-deep)", fontSize: 12, wordBreak: "break-all" }}>
                  {i.external.shortUrl}
                </a>
                <div className="stat-row" style={{ marginTop: 8 }}>
                  <span className="k">Link status</span>
                  <span className="v" style={linkDead ? { color: "#b04a28" } : {}}>
                    {linkDead ? `expire ${formatDateShort(inv.linkExpiresOn!)}` : `valid till ${formatDateShort(inv.linkExpiresOn!)}`}
                  </span>
                </div>
              </>
            ) : <p className="explain-inline">Koi live link nahi.</p>}
            {i.external.razorpayCustomerId && (
              <div className="stat-row"><span className="k">Customer</span><span className="v mono" style={{ fontSize: 11 }}>{i.external.razorpayCustomerId}</span></div>
            )}
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="overline" style={{ marginBottom: 4 }}>Buyer ka record</div>
            <div className="stat-row"><span className="k">Average kitna late</span><span className="v">{i.memory.avgDaysLate.toFixed(1)} din</span></div>
            <div className="stat-row">
              <span className="k">Promise nibhaya</span>
              <span className="v">{i.memory.counts.promisesMade === 0 ? "abhi koi nahi" : `${i.memory.counts.promisesKept}/${i.memory.counts.promisesMade}`}</span>
            </div>
            <div className="stat-row"><span className="k">Reply per message</span><span className="v">{i.memory.repliesPerTouch.whatsapp.toFixed(2)}</span></div>
            <div className="stat-row"><span className="k">Dispute kiye</span><span className="v">{i.memory.counts.disputesRaised}</span></div>
            <div className="stat-row"><span className="k">Do-not-contact</span><span className="v" style={i.memory.doNotContact ? { color: "#b04a28" } : {}}>{i.memory.doNotContact ? "haan — permanent" : "nahi"}</span></div>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="overline" style={{ marginBottom: 4 }}>Campaign</div>
            <div className="stat-row"><span className="k">Issue hua</span><span className="v num">{formatDateShort(inv.issuedOn)}</span></div>
            <div className="stat-row"><span className="k">Due</span><span className="v num">{formatDateShort(inv.dueOn)}</span></div>
            <div className="stat-row"><span className="k">Messages bheje</span><span className="v">{i.touches.length}</span></div>
            <div className="stat-row"><span className="k">Campaign khatam</span><span className="v num">{formatDateShort(inv.campaignEndsOn)}</span></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
