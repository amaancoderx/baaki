import type { AppState } from "@/lib/api";
import { formatINR } from "@/lib/format";

type Inv = AppState["invoices"][number];

/**
 * One invoice's life, rendered the same way everywhere.
 *
 * The demo screen and the dashboard's invoice pages read the same ledger; this
 * makes them share the same eyes too. Events group under DAY N headers counted
 * from issue, waiting shows as a decision with its reason, and consecutive
 * quiet days collapse into one line that still counts them.
 */
const DAY = 86_400_000;

interface Ev {
  ts: number;
  day: number;
  kind: "issue" | "wait" | "send" | "reply" | "call" | "payment" | "decision" | "blocked";
  title: string;
  body?: string;
  meta?: string;
  runs?: number;
}

export const STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_reply: { label: "Payment pending", cls: "chip-neutral" },
  promised: { label: "Promise in flight", cls: "chip-accent" },
  disputed: { label: "Disputed", cls: "chip-alert" },
  human_hold: { label: "Waiting on you", cls: "chip-ink" },
  paid: { label: "Paid ✓", cls: "chip-accent" },
  closed: { label: "Closed", cls: "chip-neutral" },
};

export function dayOf(ts: number, issuedOn: string): number {
  return Math.max(0, Math.floor((ts - Date.parse(`${issuedOn}T00:00:00+05:30`)) / DAY));
}

export function buildTimeline(i: Inv): { events: Ev[]; nextOn: string | null } {
  const issued = i.invoice.issuedOn;
  const evs: Ev[] = [];
  let nextOn: string | null = null;

  for (const a of i.audit) {
    const p = a.params as Record<string, unknown>;
    if (typeof p.nextReviewAt === "string") nextOn = p.nextReviewAt;
    const base = { ts: a.ts, day: dayOf(a.ts, issued) };

    if (a.action === "none" && "amount" in p) {
      evs.push({ ...base, kind: "issue", title: `Invoice created · ${formatINR(i.invoice.amount)}`, body: a.rationale });
    } else if (a.action === "deliver_invoice") {
      const ch = Array.isArray(p.channels) ? (p.channels as string[]).map((c) => (c === "whatsapp" ? "WhatsApp" : "Email")) : [];
      evs.push({ ...base, kind: "send", title: ch.length ? `Invoice sent · ${ch.join(" + ")}` : "Invoice could not be sent", body: a.rationale });
    } else if (a.action === "none" && p.confirmation === "promise") {
      evs.push({ ...base, kind: "send", title: "Promise confirmed in writing · WhatsApp", body: a.rationale });
    } else if (a.action === "none" && p.callOutcome) {
      const answered = p.callOutcome === "completed" && Number(p.durationSeconds ?? 0) > 0;
      evs.push({ ...base, kind: "call", title: answered ? `Call answered · ${p.durationSeconds}s` : "Call went unanswered", body: a.rationale, meta: "reported by Twilio" });
    } else if (a.action === "none" && p.intent) {
      // the reply itself renders from i.replies; skip the bookkeeping twin
    } else if (a.action === "none" || a.action === "schedule_wait") {
      evs.push({ ...base, kind: "wait", title: "AI decided to wait", body: a.rationale });
    } else if (a.action === "place_call") {
      evs.push({ ...base, kind: "call", title: p.failed ? "Call could not be placed" : "AI called the buyer", body: `Reason: ${a.rationale}`, meta: typeof p.callSid === "string" ? `call ${String(p.callSid).slice(0, 18)}` : undefined });
    } else if (a.action === "reissue_payment_path") {
      evs.push({ ...base, kind: "decision", title: p.failed ? "Could not refresh the payment link" : "Fresh payment link issued", body: a.rationale });
    } else if (a.action === "escalate_to_human") {
      evs.push({ ...base, kind: "decision", title: "Handed to you", body: a.rationale });
    } else if (a.action === "open_dispute") {
      evs.push({ ...base, kind: "decision", title: "Dispute opened, outreach stopped", body: a.rationale });
    } else if (a.action === "stop") {
      evs.push({ ...base, kind: "payment", title: "AI closed the collection journey", body: a.rationale });
    } else if (Array.isArray(p.refusedBy) && p.refusedBy.length) {
      evs.push({ ...base, kind: "blocked", title: `Guard refused: ${(p.refusedBy as string[]).join(", ").replace(/_/g, " ")}`, body: a.rationale });
    }
  }

  for (const t of i.touches) {
    evs.push({
      ts: t.ts, day: dayOf(t.ts, issued), kind: "send",
      title: `Follow-up sent · WhatsApp${(t as { emailed?: boolean }).emailed ? " + Email" : ""} · ${t.rung.replace(/_/g, " ")}`,
      body: t.body,
    });
  }
  for (const r of i.replies) {
    evs.push({
      ts: r.ts, day: dayOf(r.ts, issued), kind: "reply",
      title: "Buyer replied",
      body: `“${r.text}”`,
      meta: `AI understood: ${r.intent.replace(/_/g, " ")}${r.promiseDate ? `, expected by ${r.promiseDate}` : ""}`,
    });
  }
  for (const pmt of i.payments) {
    evs.push({
      ts: pmt.ts, day: dayOf(pmt.ts, issued), kind: "payment",
      title: `Payment received · ${formatINR(pmt.amount)}`,
      meta: `Razorpay event ${pmt.evidence}`,
    });
  }

  evs.sort((a, b) => a.ts - b.ts);

  // Consecutive waits collapse: doing nothing is a decision worth one line, not five.
  const rolled: Ev[] = [];
  for (const e of evs) {
    const prev = rolled[rolled.length - 1];
    if (e.kind === "wait" && prev?.kind === "wait") {
      prev.runs = (prev.runs ?? 1) + 1;
      prev.ts = e.ts; prev.day = e.day; prev.body = e.body;
      continue;
    }
    rolled.push({ ...e });
  }
  return { events: rolled, nextOn };
}

const DOT: Record<Ev["kind"], string> = {
  issue: "🧾", wait: "🤖", send: "📨", reply: "💬", call: "📞",
  payment: "✅", decision: "🤖", blocked: "🛡️",
};


export function Journey({ inv }: { inv: Inv }) {
  const tl = buildTimeline(inv);
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {tl.events.map((e, n) => {
        const newDay = n === 0 || tl.events[n - 1]!.day !== e.day;
        return (
          <div key={n}>
            {newDay && (
              <div className="day-head" style={{ paddingTop: n ? 14 : 0 }}>
                <span>DAY {e.day}</span>
                <span style={{ color: "var(--text-4)", fontWeight: 400 }}>
                  {new Date(e.ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}
                </span>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, padding: "8px 2px", borderLeft: "2px solid var(--hairline)", marginLeft: 6, paddingLeft: 14 }}>
              <span style={{ fontSize: 15, lineHeight: "20px" }}>{DOT[e.kind]}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {e.runs && e.runs > 1 ? `AI checked ${e.runs} times, chose to wait` : e.title}
                </div>
                {e.body && <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 2 }}>{e.body}</div>}
                {e.meta && <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 2 }}>{e.meta}</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
