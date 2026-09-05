"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const VOICE = process.env.NEXT_PUBLIC_VOICE ?? "ws://localhost:3002";

type Line = { who: string; text: string };

/**
 * Browser call. Mic is captured at whatever rate the device gives, downsampled
 * to the 16 kHz Gemini Live expects, and replies come back as 24 kHz PCM which
 * is queued so consecutive chunks play without a gap.
 */
export function CallPanel({ invoiceId, buyerName }: { invoiceId: string; buyerName: string }) {
  const [state, setState] = useState<"idle" | "connecting" | "live" | "ended">("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [tools, setTools] = useState<{ name: string; outcome: string }[]>([]);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playAtRef = useRef(0);

  const hangUp = useCallback(() => {
    wsRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    acRef.current?.close().catch(() => {});
    wsRef.current = null; acRef.current = null; streamRef.current = null;
    setState("ended");
  }, []);

  useEffect(() => () => hangUp(), [hangUp]);

  async function start() {
    setErr(null); setLines([]); setTools([]); setState("connecting");
    try {
      const ws = new WebSocket(`${VOICE}/browser?invoice=${encodeURIComponent(invoiceId)}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      const ac = new AudioContext({ sampleRate: 48000 });
      acRef.current = ac;
      playAtRef.current = 0;

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          // 24 kHz signed 16-bit PCM from the model.
          const pcm = new Int16Array(ev.data);
          const buf = ac.createBuffer(1, pcm.length, 24000);
          const ch = buf.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
          const src = ac.createBufferSource();
          src.buffer = buf; src.connect(ac.destination);
          const now = ac.currentTime;
          playAtRef.current = Math.max(playAtRef.current, now + 0.05);
          src.start(playAtRef.current);
          playAtRef.current += buf.duration;
          return;
        }
        const m = JSON.parse(ev.data as string);
        if (m.type === "ready") setState("live");
        if (m.type === "transcript") {
          setLines((ls) => {
            const last = ls[ls.length - 1];
            // The model streams a turn in fragments; join them into one line.
            if (last && last.who === m.who) return [...ls.slice(0, -1), { who: m.who, text: last.text + m.text }];
            return [...ls, { who: m.who, text: m.text }];
          });
        }
        if (m.type === "tool") setTools((t) => [...t, { name: m.name, outcome: m.outcome }]);
        if (m.type === "error") { setErr(m.message); setState("ended"); }
      };
      ws.onclose = () => setState((s) => (s === "ended" ? s : "ended"));
      ws.onerror = () => setErr("Could not reach the voice service. Is `pnpm voice` running?");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const source = ac.createMediaStreamSource(stream);
      const node = ac.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const inBuf = e.inputBuffer.getChannelData(0);
        const ratio = ac.sampleRate / 16000;
        const outLen = Math.floor(inBuf.length / ratio);
        const out = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const v = inBuf[Math.floor(i * ratio)] ?? 0;
          out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
        }
        ws.send(out.buffer);
      };
      source.connect(node); node.connect(ac.destination);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("ended");
    }
  }

  function sendTyped() {
    if (!typed.trim() || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setLines((ls) => [...ls, { who: "buyer", text: typed }]);
    wsRef.current.send(JSON.stringify({ type: "text", text: typed }));
    setTyped("");
  }

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="overline" style={{ marginBottom: 8 }}>Place a call</div>

      {state === "idle" && (
        <>
          <p className="explain-inline" style={{ marginBottom: 10 }}>
            Call {buyerName} from the browser. The agent speaks Hindi and Hinglish, takes
            consent first, and writes any promise or dispute straight into the ledger.
            It does not negotiate: a discount or settlement request is handed to a person.
          </p>
          <button className="btn btn-primary" onClick={start}>Start call</button>
        </>
      )}

      {state === "connecting" && <p style={{ fontSize: 13 }}><span className="spinner" /> Connecting…</p>}

      {(state === "live" || state === "ended") && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            {state === "live"
              ? <span className="chip chip-accent"><span className="dot pulse" /> call in progress</span>
              : <span className="chip chip-neutral">call ended</span>}
            {state === "live" && <button className="btn btn-quiet" onClick={hangUp}>Hang up</button>}
          </div>

          <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {lines.map((l, i) => (
              <div key={i} style={{
                fontSize: 13, lineHeight: 1.5,
                padding: "7px 10px", borderRadius: "var(--r)",
                background: l.who === "agent" ? "var(--surface)" : "rgba(31,30,29,0.04)",
                alignSelf: l.who === "agent" ? "flex-start" : "flex-end",
                maxWidth: "92%",
              }}>
                <span className="overline" style={{ display: "block", marginBottom: 2 }}>
                  {l.who === "agent" ? "Baaki" : "Buyer"}
                </span>
                {l.text}
              </div>
            ))}
            {tools.map((t, i) => (
              <div key={`t${i}`} className="chip chip-accent" style={{ alignSelf: "flex-start" }}>
                ✓ {t.name.replace(/_/g, " ")} — {t.outcome}
              </div>
            ))}
          </div>

          {state === "live" && (
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <input className="input" placeholder="Or type instead…" value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendTyped()} />
              <button className="btn btn-ghost" onClick={sendTyped}>Send</button>
            </div>
          )}
        </>
      )}

      {err && <p style={{ fontSize: 12, color: "#b04a28", marginTop: 8 }}>{err}</p>}
    </div>
  );
}
