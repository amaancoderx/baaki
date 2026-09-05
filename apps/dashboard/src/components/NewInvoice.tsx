"use client";

import { useMemo, useState } from "react";
import { API, type Contact, type Policy } from "@/lib/api";

const initials = (n: string) => n.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const inr = (r: number) => "₹" + r.toLocaleString("en-IN");

type Step = 1 | 2 | 3;

export function NewInvoice({ contacts, policy }: { contacts: Contact[]; policy: Policy }) {
  const [step, setStep] = useState<Step>(1);
  const [picked, setPicked] = useState<Contact | null>(null);
  const [q, setQ] = useState("");
  const [amount, setAmount] = useState(180000);
  const [termDays, setTermDays] = useState(25);
  const [linkValidDays, setLinkValidDays] = useState(10);
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState({
    maxTouches: policy.maxTouches,
    minGapDays: policy.minGapDays,
    campaignDays: policy.campaignDays,
    windowStart: policy.contactWindow.start,
    windowEnd: policy.contactWindow.end,
    silentTouchCap: policy.silentTouchCap,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ shortUrl?: string; invoiceId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(t) || c.city.toLowerCase().includes(t) || c.phone.includes(t));
  }, [contacts, q]);

  async function submit() {
    if (!picked) return;
    setBusy(true); setError(null);
    try {
      await fetch(`${API}/api/policy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxTouches: rules.maxTouches,
          minGapDays: rules.minGapDays,
          campaignDays: rules.campaignDays,
          silentTouchCap: rules.silentTouchCap,
          contactWindow: { ...policy.contactWindow, start: rules.windowStart, end: rules.windowEnd },
        }),
      });
      const r = await fetch(`${API}/api/invoices`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: picked.id, amountRupees: amount, termDays, linkValidDays,
          description: description || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setResult({ shortUrl: j.razorpay?.shortUrl, invoiceId: j.invoice.id });
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="explain">
          <span className="tag">Created</span>
          Invoice <strong>{result.invoiceId}</strong> is live with a real Razorpay payment
          link. Baaki takes it from here: a reminder before the due date, follow-ups
          up the ladder after it, and if the buyer replies, Baaki AI reads the reply and
          adjusts. Nothing further is needed from you.
        </div>
        {result.shortUrl && (
          <div className="panel">
            <div className="overline" style={{ marginBottom: 8 }}>Payment link</div>
            <a href={result.shortUrl} target="_blank" rel="noreferrer"
              className="mono" style={{ color: "var(--accent-deep)", fontSize: 14 }}>
              {result.shortUrl}
            </a>
            <p className="explain-inline">
              A real Razorpay test link. Paying it fires a webhook and closes the case
              automatically. Nothing is entered by hand.
            </p>
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/" className="btn btn-primary">View invoices</a>
          <button className="btn btn-ghost" onClick={() => { setResult(null); setStep(1); setPicked(null); }}>
            Create another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="steps">
        {([[1, "Choose a buyer"], [2, "Amount and rules"], [3, "Agent takes over"]] as const).map(([n, label]) => (
          <div key={n} className={`step ${step === n ? "active" : step > n ? "done" : ""}`}>
            <span className="step-n">{step > n ? "✓" : n}</span>{label}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="explain">
            <span className="tag">Step 1</span>
            Who are you billing? Contacts marked <strong>WhatsApp ready</strong> can
            receive real messages. The rest are sample data: the system will still
            do everything, but nothing will actually be delivered.
          </div>
          <input className="input" placeholder="Search by name, city or number"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="card" style={{ maxHeight: 340, overflowY: "auto", padding: 6 }}>
            {filtered.map((c) => (
              <div key={c.id} className={`contact-row ${picked?.id === c.id ? "picked" : ""}`}
                onClick={() => { setPicked(c); setTermDays(c.termDays); }}>
                <span className="avatar">{initials(c.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                    {c.city} · +{c.phone} · {c.termDays}-day terms
                  </div>
                </div>
                {c.sendable
                  ? <span className="chip chip-accent">WhatsApp ready</span>
                  : <span className="chip chip-neutral">Sample</span>}
              </div>
            ))}
            {filtered.length === 0 && <p style={{ padding: 12, fontSize: 13, color: "var(--text-3)" }}>No contacts match that search.</p>}
          </div>
          <div>
            <button className="btn btn-primary" disabled={!picked} onClick={() => setStep(2)}
              style={{ opacity: picked ? 1 : 0.5 }}>
              Continue{picked ? ` with ${picked.name}` : ""}
            </button>
          </div>
        </div>
      )}

      {step === 2 && picked && (
        <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="explain">
            <span className="tag">Step 2</span>
            Set the amount and payment terms. The rules below are hard limits the agent
            cannot cross: how many messages at most, the minimum gap between them,
            and the hours it may contact anyone. These are <strong>guards</strong>,
            and they run again at send time, so a decision cannot skip them.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="panel">
              <div className="overline" style={{ marginBottom: 12 }}>Invoice</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="field">
                  <span className="label">Amount</span>
                  <input className="input num" type="number" value={amount}
                    onChange={(e) => setAmount(Number(e.target.value))} />
                  <span className="hint">{inr(amount)}</span>
                </div>
                <div className="field">
                  <span className="label">Payment terms</span>
                  <input className="input num" type="number" value={termDays}
                    onChange={(e) => setTermDays(Number(e.target.value))} />
                  <span className="hint">Due {termDays} days after issue</span>
                </div>
                <div className="field">
                  <span className="label">Payment link validity</span>
                  <input className="input num" type="number" value={linkValidDays}
                    onChange={(e) => setLinkValidDays(Number(e.target.value))} />
                  <span className="hint">
                    {linkValidDays < termDays
                      ? `Expires before the due date, so the agent must reissue it before it can chase. This is the most common real-world case.`
                      : `Stays valid past the due date.`}
                  </span>
                </div>
                <div className="field">
                  <span className="label">Description</span>
                  <input className="input" placeholder={`Supply against PO for ${picked.name}`}
                    value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="overline" style={{ marginBottom: 12 }}>Rules the agent cannot break</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="field">
                  <span className="label">Maximum messages</span>
                  <input className="input num" type="number" value={rules.maxTouches}
                    onChange={(e) => setRules({ ...rules, maxTouches: Number(e.target.value) })} />
                  <span className="hint">After this many messages the case comes to you</span>
                </div>
                <div className="field">
                  <span className="label">Minimum gap between messages</span>
                  <input className="input num" type="number" value={rules.minGapDays}
                    onChange={(e) => setRules({ ...rules, minGapDays: Number(e.target.value) })} />
                  <span className="hint">Days that must pass before the next message</span>
                </div>
                <div className="field">
                  <span className="label">Cap for silent buyers</span>
                  <input className="input num" type="number" value={rules.silentTouchCap}
                    onChange={(e) => setRules({ ...rules, silentTouchCap: Number(e.target.value) })} />
                  <span className="hint">A buyer who never replies comes to you after this many days</span>
                </div>
                <div className="field">
                  <span className="label">Contact hours (IST)</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input className="input num" value={rules.windowStart}
                      onChange={(e) => setRules({ ...rules, windowStart: e.target.value })} />
                    <span style={{ color: "var(--text-4)" }}>to</span>
                    <input className="input num" value={rules.windowEnd}
                      onChange={(e) => setRules({ ...rules, windowEnd: e.target.value })} />
                  </div>
                  <span className="hint">Sundays and public holidays are excluded automatically</span>
                </div>
                <div className="field">
                  <span className="label">Campaign length</span>
                  <input className="input num" type="number" value={rules.campaignDays}
                    onChange={(e) => setRules({ ...rules, campaignDays: Number(e.target.value) })} />
                  <span className="hint">After this the agent stops and only you can act</span>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="explain" style={{ background: "rgba(217,119,87,0.12)", borderColor: "rgba(217,119,87,0.3)" }}>
              <strong>Could not create it:</strong> {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? <><span className="spinner" /> Creating it on Razorpay…</> : `Create invoice for ${inr(amount)}`}
            </button>
            <button className="btn btn-ghost" onClick={() => setStep(1)} disabled={busy}>Back</button>
          </div>
          <p className="explain-inline">
            This makes a real Razorpay test-mode call: it creates the customer, the payment
            link, and puts that link in the WhatsApp message button.
          </p>
        </div>
      )}
    </div>
  );
}
