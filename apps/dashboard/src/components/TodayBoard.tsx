"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Action, CaseView } from "@/lib/types";
import { formatINR, formatDateShort, overdueSeverity } from "@/lib/format";

type CardState = { status: "pending" | "scheduled" | "skipped"; draft: string; edited: boolean };

const actionLabel = (a: Action): string => {
  switch (a.kind) {
    case "send_nudge":
      return a.rung === "whatsapp+reissue" ? "Reissue link + nudge" : "Send nudge";
    case "escalate_to_human": return "Hand to a human";
    case "schedule_wait": return `Wait until ${formatDateShort(a.until)}`;
    case "reissue_payment_path": return "Reissue payment link";
    case "open_dispute": return "Open dispute";
    case "stop": return "Stop";
    case "none": return "No action";
  }
};

const sevChip: Record<string, string> = {
  neutral: "chip-neutral", mild: "chip-neutral", warning: "chip-warning", alert: "chip-alert",
};

function OverdueChip({ days }: { days: number }) {
  const sev = overdueSeverity(days);
  return (
    <span className={`chip ${sevChip[sev]} num`}>
      {days > 0 ? `${days}d overdue` : "not due"}
    </span>
  );
}

function GuardTicks({ c }: { c: CaseView }) {
  return (
    <div className="guards">
      {c.proposal.guards.map((g) => (
        <span key={g.name} className={`guard ${g.pass ? "" : "failed"}`} title={g.detail ?? g.name}>
          <span className="tick">{g.pass ? "✓" : "✕"}</span>
          {g.name.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}

function ProposalCard({
  c, selected, state, onApprove, onSkip, onEdit, onSelect, editing, setEditing, index,
}: {
  c: CaseView;
  selected: boolean;
  state: CardState;
  onApprove: () => void;
  onSkip: () => void;
  onEdit: (draft: string) => void;
  onSelect: () => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  index: number;
}) {
  const a = c.proposal.action;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  if (state.status === "scheduled") {
    return (
      <div className="card rise" style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, background: "var(--accent-wash)", borderColor: "transparent" }}>
        <span style={{ color: "var(--accent-deep)", fontSize: 13, fontWeight: 500 }}>✓ Scheduled</span>
        <span style={{ fontSize: 13 }}>{c.buyer.name}</span>
        <span className="mono" style={{ color: "var(--text-3)" }}>{c.invoice.id}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-3)" }}>
          sends today 10:00 IST · guards re-checked at send{state.edited ? " · draft edited" : ""}
        </span>
      </div>
    );
  }
  if (state.status === "skipped") {
    return (
      <div className="card" style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, opacity: 1, background: "rgba(31,30,29,0.03)" }}>
        <span style={{ color: "var(--text-3)", fontSize: 13 }}>Skipped</span>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{c.buyer.name}</span>
        <span className="mono" style={{ color: "var(--text-4)" }}>{c.invoice.id}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-4)" }}>re-proposed tomorrow</span>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={`card rise ${selected ? "selected" : ""}`}
      style={{ padding: 14, animationDelay: `${Math.min(index * 40, 240)}ms` }}
      onClick={onSelect}
    >
      <div style={{ display: "flex", alignItems: "stretch", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Link href={`/case/${c.invoice.id}`} style={{ fontWeight: 500, fontSize: 15 }}
              onClick={(e) => e.stopPropagation()}>
              {c.buyer.name}
            </Link>
            <span className="mono" style={{ color: "var(--text-4)" }}>{c.invoice.id}</span>
            <OverdueChip days={c.daysOverdue} />
            {c.proposal.route === "slow" && (
              <span className="chip chip-accent" title={`Router: ${c.proposal.routeReason}`}>
                needs judgment · {c.proposal.routeReason}
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <span className="chip chip-ink">{actionLabel(a)}</span>
            {a.kind === "send_nudge" && (
              <>
                <span className="chip chip-outline">{a.persona === "owner" ? "owner persona" : "accounts"}</span>
                <span className="chip chip-outline">{a.channel}</span>
                <span className="chip chip-outline">rung · {a.rung.replace(/_/g, " ")}</span>
              </>
            )}
          </div>

          <p style={{ marginTop: 8, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {c.proposal.rationale}
          </p>

          {editing && a.kind === "send_nudge" ? (
            <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
              <textarea
                autoFocus
                defaultValue={state.draft}
                rows={3}
                style={{
                  width: "100%", font: "inherit", fontSize: 13, padding: 10,
                  border: "1px solid var(--accent)", borderRadius: "var(--r)",
                  resize: "vertical", outline: "none", lineHeight: 1.5,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    onEdit((e.target as HTMLTextAreaElement).value);
                    setEditing(false);
                  }
                }}
                onBlur={(e) => { onEdit(e.target.value); setEditing(false); }}
              />
              <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 4 }}>
                ⌘↵ save · esc cancel · amounts stay ledger-injected
              </div>
            </div>
          ) : (
            a.kind === "send_nudge" && (
              <div style={{
                marginTop: 8, padding: "8px 11px", background: "var(--surface)",
                borderRadius: "var(--r)", fontSize: 13, color: "var(--text-2)", lineHeight: 1.5,
              }}>
                {state.draft}
                {state.edited && <span className="chip chip-neutral" style={{ marginLeft: 8 }}>edited</span>}
              </div>
            )
          )}

          <div style={{ marginTop: 10 }}>
            <GuardTicks c={c} />
          </div>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <div className="num" style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {formatINR(c.outstanding)}
          </div>
          {c.invoice.amountPaid > 0 && (
            <div className="num" style={{ fontSize: 11, color: "var(--text-3)" }}>
              of {formatINR(c.invoice.amount)}
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--text-4)" }}>
            due {formatDateShort(c.invoice.dueOn)}
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 12, justifyContent: "flex-end" }}
            onClick={(e) => e.stopPropagation()}>
            <button className="btn btn-primary" onClick={onApprove}>Approve</button>
            {a.kind === "send_nudge" && (
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>
            )}
            <button className="btn btn-quiet" onClick={onSkip}>Skip</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WaitingRow({ c }: { c: CaseView }) {
  const a = c.proposal.action;
  const inv = c.invoice;
  let why: string;
  let chip: React.ReactNode = null;

  if (inv.substate === "promised" && inv.promisedFor) {
    why = `promise in flight`;
    chip = <span className="chip chip-warning num">pays by {formatDateShort(inv.promisedFor)}</span>;
  } else if (inv.substate === "disputed") {
    why = inv.disputeReason ?? "dispute open";
    chip = <span className="chip chip-alert">disputed</span>;
  } else if (a.kind === "none") {
    why = a.reason;
  } else if (a.kind === "schedule_wait") {
    why = a.reason;
    chip = <span className="chip chip-neutral num">until {formatDateShort(a.until)}</span>;
  } else {
    why = c.proposal.rationale;
  }

  return (
    <Link href={`/case/${inv.id}`} className="row-line" style={{ color: "inherit" }}>
      <span style={{ fontWeight: 500, width: 200, flexShrink: 0 }}>{c.buyer.name}</span>
      <span className="mono" style={{ color: "var(--text-4)", width: 60, flexShrink: 0 }}>{inv.id}</span>
      <OverdueChip days={c.daysOverdue} />
      <span style={{ color: "var(--text-3)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {why}
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {chip}
        <span className="num" style={{ fontWeight: 500 }}>{formatINR(c.outstanding)}</span>
      </span>
    </Link>
  );
}

export function TodayBoard({ cases }: { cases: CaseView[] }) {
  const approvals = useMemo(
    () =>
      cases
        .filter(
          (c) =>
            c.proposal.allowed &&
            (c.proposal.action.kind === "send_nudge" || c.proposal.action.kind === "escalate_to_human"),
        )
        .sort((a, b) => b.outstanding - a.outstanding),
    [cases],
  );
  const waiting = useMemo(
    () =>
      cases
        .filter((c) => !approvals.includes(c) && c.invoice.substate !== "human_hold")
        .sort((a, b) => b.daysOverdue - a.daysOverdue),
    [cases, approvals],
  );
  const withHumans = useMemo(
    () => cases.filter((c) => c.invoice.substate === "human_hold").sort((a, b) => b.outstanding - a.outstanding),
    [cases],
  );

  const [states, setStates] = useState<Record<string, CardState>>(() =>
    Object.fromEntries(
      approvals.map((c) => [
        c.invoice.id,
        {
          status: "pending",
          draft: c.proposal.action.kind === "send_nudge" ? c.proposal.action.draft : "",
          edited: false,
        },
      ]),
    ),
  );
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState(false);

  const pendingIds = approvals.filter((c) => states[c.invoice.id]?.status === "pending").map((c) => c.invoice.id);

  const mutate = useCallback((id: string, patch: Partial<CardState>) => {
    setStates((s) => ({ ...s, [id]: { ...s[id]!, ...patch } }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      const id = approvals[sel]?.invoice.id;
      switch (e.key) {
        case "j": setSel((s) => Math.min(s + 1, approvals.length - 1)); break;
        case "k": setSel((s) => Math.max(s - 1, 0)); break;
        case "a": if (id && states[id]?.status === "pending") mutate(id, { status: "scheduled" }); break;
        case "s": if (id && states[id]?.status === "pending") mutate(id, { status: "skipped" }); break;
        case "e": if (id && states[id]?.status === "pending") setEditing(true); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approvals, sel, states, editing, mutate]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 className="h2">Needs approval <span style={{ color: "var(--text-4)" }}>· {pendingIds.length}</span></h2>
          <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--text-4)", alignItems: "center" }}>
            <span><span className="kbd">j</span> <span className="kbd">k</span> move</span>
            <span><span className="kbd">a</span> approve</span>
            <span><span className="kbd">e</span> edit</span>
            <span><span className="kbd">s</span> skip</span>
          </div>
        </div>
        {approvals.length === 0 ? (
          <p style={{ color: "var(--text-3)", fontSize: 13 }}>Nothing needs approval.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {approvals.map((c, i) => (
              <ProposalCard
                key={c.invoice.id}
                c={c}
                index={i}
                selected={i === sel}
                state={states[c.invoice.id]!}
                editing={editing && i === sel}
                setEditing={setEditing}
                onSelect={() => setSel(i)}
                onApprove={() => mutate(c.invoice.id, { status: "scheduled" })}
                onSkip={() => mutate(c.invoice.id, { status: "skipped" })}
                onEdit={(draft) =>
                  mutate(c.invoice.id, { draft, edited: draft !== (c.proposal.action.kind === "send_nudge" ? c.proposal.action.draft : "") })
                }
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="h2" style={{ marginBottom: 12 }}>
          Waiting <span style={{ color: "var(--text-4)" }}>· {waiting.length}</span>
        </h2>
        <div className="card">
          {waiting.map((c) => <WaitingRow key={c.invoice.id} c={c} />)}
        </div>
      </section>

      {withHumans.length > 0 && (
        <section>
          <h2 className="h2" style={{ marginBottom: 12 }}>
            With humans <span style={{ color: "var(--text-4)" }}>· {withHumans.length}</span>
          </h2>
          <div className="card">
            {withHumans.map((c) => <WaitingRow key={c.invoice.id} c={c} />)}
          </div>
        </section>
      )}
    </div>
  );
}
