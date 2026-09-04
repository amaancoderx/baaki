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
          <span className="tag">Ho gaya</span>
          Invoice <strong>{result.invoiceId}</strong> ban gaya aur Razorpay pe live
          payment link bhi ready hai. Ab Baaki khud dekhega: due date se pehle
          reminder, phir ladder ke hisaab se follow-up, aur beech mein buyer ka
          reply aaya to woh padhega. Aapko kuch karne ki zaroorat nahi.
        </div>
        {result.shortUrl && (
          <div className="panel">
            <div className="overline" style={{ marginBottom: 8 }}>Live payment link</div>
            <a href={result.shortUrl} target="_blank" rel="noreferrer"
              className="mono" style={{ color: "var(--accent-deep)", fontSize: 14 }}>
              {result.shortUrl}
            </a>
            <p className="explain-inline">
              Ye asli Razorpay test link hai. Ise pay karoge to webhook aayega aur
              case apne aap close ho jayega — koi manual entry nahi.
            </p>
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/" className="btn btn-primary">Today dekho</a>
          <button className="btn btn-ghost" onClick={() => { setResult(null); setStep(1); setPicked(null); }}>
            Ek aur invoice banao
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="steps">
        {([[1, "Buyer chuno"], [2, "Amount aur rules"], [3, "Agent chalu"]] as const).map(([n, label]) => (
          <div key={n} className={`step ${step === n ? "active" : step > n ? "done" : ""}`}>
            <span className="step-n">{step > n ? "✓" : n}</span>{label}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="explain">
            <span className="tag">Step 1</span>
            Kisko bill bhejna hai? Neeche aapki contact list hai. Jo contact{" "}
            <strong>WhatsApp ready</strong> hai, sirf usi pe asli message jayega —
            baaki synthetic hain, unke liye system sab kuch karega par message
            actually deliver nahi hoga.
          </div>
          <input className="input" placeholder="Naam, sheher ya number se dhoondo…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="card" style={{ maxHeight: 340, overflowY: "auto", padding: 6 }}>
            {filtered.map((c) => (
              <div key={c.id} className={`contact-row ${picked?.id === c.id ? "picked" : ""}`}
                onClick={() => { setPicked(c); setTermDays(c.termDays); }}>
                <span className="avatar">{initials(c.name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                    {c.city} · +{c.phone} · net {c.termDays}
                  </div>
                </div>
                {c.sendable
                  ? <span className="chip chip-accent">WhatsApp ready</span>
                  : <span className="chip chip-neutral">synthetic</span>}
              </div>
            ))}
            {filtered.length === 0 && <p style={{ padding: 12, fontSize: 13, color: "var(--text-3)" }}>Koi contact nahi mila.</p>}
          </div>
          <div>
            <button className="btn btn-primary" disabled={!picked} onClick={() => setStep(2)}
              style={{ opacity: picked ? 1 : 0.5 }}>
              Aage badho{picked ? ` — ${picked.name}` : ""}
            </button>
          </div>
        </div>
      )}

      {step === 2 && picked && (
        <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="explain">
            <span className="tag">Step 2</span>
            Amount aur payment terms daalo. Rules woh limits hain jo agent kabhi
            cross nahi kar sakta — kitne message max, beech mein kitne din gap,
            aur kis time pe message ja sakta hai. Ye <strong>guards</strong> hain:
            agent inhe bypass nahi kar sakta, chahe woh kuch bhi decide kare.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="panel">
              <div className="overline" style={{ marginBottom: 12 }}>Invoice</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="field">
                  <span className="label">Amount (₹)</span>
                  <input className="input num" type="number" value={amount}
                    onChange={(e) => setAmount(Number(e.target.value))} />
                  <span className="hint">{inr(amount)}</span>
                </div>
                <div className="field">
                  <span className="label">Payment terms (din)</span>
                  <input className="input num" type="number" value={termDays}
                    onChange={(e) => setTermDays(Number(e.target.value))} />
                  <span className="hint">Due date issue se {termDays} din baad</span>
                </div>
                <div className="field">
                  <span className="label">Link validity (din)</span>
                  <input className="input num" type="number" value={linkValidDays}
                    onChange={(e) => setLinkValidDays(Number(e.target.value))} />
                  <span className="hint">
                    {linkValidDays < termDays
                      ? `Due date se pehle hi expire ho jayega — agent ko reissue karna padega. Yehi asli duniya mein sabse zyada hota hai.`
                      : `Due date ke baad tak valid rahega.`}
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
              <div className="overline" style={{ marginBottom: 12 }}>Rules — agent inhe todh nahi sakta</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="field">
                  <span className="label">Max messages per invoice</span>
                  <input className="input num" type="number" value={rules.maxTouches}
                    onChange={(e) => setRules({ ...rules, maxTouches: Number(e.target.value) })} />
                  <span className="hint">Iske baad case insaan ke paas jayega</span>
                </div>
                <div className="field">
                  <span className="label">Minimum gap (din)</span>
                  <input className="input num" type="number" value={rules.minGapDays}
                    onChange={(e) => setRules({ ...rules, minGapDays: Number(e.target.value) })} />
                  <span className="hint">Do message ke beech kam se kam itne din</span>
                </div>
                <div className="field">
                  <span className="label">Chup buyer ke liye cap</span>
                  <input className="input num" type="number" value={rules.silentTouchCap}
                    onChange={(e) => setRules({ ...rules, silentTouchCap: Number(e.target.value) })} />
                  <span className="hint">Jo bilkul reply nahi karta, utne message ke baad insaan</span>
                </div>
                <div className="field">
                  <span className="label">Contact window (IST)</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input className="input num" value={rules.windowStart}
                      onChange={(e) => setRules({ ...rules, windowStart: e.target.value })} />
                    <span style={{ color: "var(--text-4)" }}>se</span>
                    <input className="input num" value={rules.windowEnd}
                      onChange={(e) => setRules({ ...rules, windowEnd: e.target.value })} />
                  </div>
                  <span className="hint">Sunday aur holiday pe waise bhi message nahi jayega</span>
                </div>
                <div className="field">
                  <span className="label">Campaign length (din)</span>
                  <input className="input num" type="number" value={rules.campaignDays}
                    onChange={(e) => setRules({ ...rules, campaignDays: Number(e.target.value) })} />
                  <span className="hint">Iske baad sirf insaan decide karega</span>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="explain" style={{ background: "rgba(217,119,87,0.12)", borderColor: "rgba(217,119,87,0.3)" }}>
              <strong>Nahi ban paya:</strong> {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={submit} disabled={busy}>
              {busy ? <><span className="spinner" /> Razorpay pe bana raha hai…</> : `Invoice banao — ${inr(amount)}`}
            </button>
            <button className="btn btn-ghost" onClick={() => setStep(1)} disabled={busy}>Peeche</button>
          </div>
          <p className="explain-inline">
            Ye asli Razorpay test-mode call hai: customer banega, payment link banega,
            aur wahi link WhatsApp template ke button mein jayega.
          </p>
        </div>
      )}
    </div>
  );
}
