"use client";

import { useEffect, useRef, useState } from "react";

interface Msg { role: "user" | "model"; text: string }

/**
 * The screens are English so they can be scanned. Explaining why the system did
 * something is a different job, and it happens here, in the language a merchant
 * would actually ask the question in.
 */
const OPENERS = [
  "Aaj kya karna hai?",
  "Sabse zyada paisa kispe atka hai?",
  "Guards kya hain?",
  "Agent ne pichhli baar kya kiya?",
];

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    const next = [...msgs, { role: "user" as const, text: q }];
    setMsgs(next);
    setBusy(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, history: msgs.slice(-6) }),
      });
      const j = await r.json();
      setMsgs([...next, {
        role: "model",
        text: j.reply ?? `Sorry, kuch dikkat aa gayi. ${j.error ?? ""}`.trim(),
      }]);
    } catch {
      setMsgs([...next, { role: "model", text: "Connect nahi ho paya. Thodi der baad try karo." }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="assistant-fab" onClick={() => setOpen(true)} aria-label="Ask about this system">
        <span className="assistant-fab-dot" />
        Puchho
      </button>
    );
  }

  return (
    <div className="assistant">
      <div className="assistant-head">
        <div>
          <div style={{ fontWeight: 500, fontSize: 14 }}>Baaki se puchho</div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            Hinglish mein poochho — ye aapke ledger se hi jawab dega
          </div>
        </div>
        <button className="btn btn-quiet" onClick={() => setOpen(false)} aria-label="Close">✕</button>
      </div>

      <div className="assistant-body">
        {msgs.length === 0 && (
          <>
            <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
              Main aapke invoices, agent ke decisions aur guards ke baare mein bata
              sakta hoon. Kuch bhej nahi sakta — sirf samjha sakta hoon.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
              {OPENERS.map((o) => (
                <button key={o} className="chip chip-outline" style={{ cursor: "pointer" }} onClick={() => send(o)}>
                  {o}
                </button>
              ))}
            </div>
          </>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>{m.text}</div>
        ))}
        {busy && <div className="bubble model"><span className="spinner" /> soch raha hoon…</div>}
        <div ref={endRef} />
      </div>

      <div className="assistant-foot">
        <input
          className="input"
          placeholder="Kuch bhi poochho…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
          disabled={busy}
        />
        <button className="btn btn-primary" onClick={() => send(input)} disabled={busy || !input.trim()}>
          Bhejo
        </button>
      </div>
    </div>
  );
}
