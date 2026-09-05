# Baaki AI

<p>
  <a href="https://baaki-ai.vercel.app"><img src="https://img.shields.io/badge/Live_App-baaki--ai.vercel.app-0e5e54?style=for-the-badge" alt="Live app"></a>
  <a href="https://youtu.be/Pfg7jszBXTA"><img src="https://img.shields.io/badge/Demo_Video-YouTube-cc0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Demo video"></a>
  <a href="https://amaankhan.xyz"><img src="https://img.shields.io/badge/Built_by-Amaan_Khan-1c1b16?style=for-the-badge" alt="Portfolio"></a>
</p>

**Baaki** (Hindi: "what remains to be paid") is an autonomous receivables agent for Indian businesses, built on top of Razorpay. You raise an invoice; Baaki delivers it, follows up on WhatsApp, email and SMS, places a real phone call in Hindi when messages stop working, understands what the buyer says back, and closes the case when the money lands. Every step it takes is written to an append-only audit trail with the reason it was taken and the evidence behind it.

The agent decides. A deterministic guard layer decides whether the agent is allowed.

**[Watch the demo](https://youtu.be/Pfg7jszBXTA)**: one invoice's whole life on the demo clock, from being raised to the buyer actually paying, with every message, email and phone call really sent along the way.

| | |
| --- | --- |
| Live app | https://baaki-ai.vercel.app |
| Demo video (5 min) | https://youtu.be/Pfg7jszBXTA |
| Built by | [Amaan Khan](https://amaankhan.xyz) |

## How it works

```
Razorpay / WhatsApp / Twilio webhooks
              |
              v
   Ledger (append-only, Redis)
              |
              v
   Router: does this case need judgement?
      |                    |
   fast path            case agent
   (pure rules)         (Gemini, bounded)
      |                    |
      +--------+-----------+
               v
        Guard layer (9 pure functions)
               v
     Act: WhatsApp / email / SMS / call
               v
        Audit entry: action, reason, evidence
```

Once a day, and on every webhook, Baaki looks at each open invoice and takes exactly one action. Most days that action is to wait, and waiting is recorded as a decision with its reason. Cases that need judgement, because a buyer wrote something, a promise broke, or someone went quiet, route to the case agent. Everything else is settled by rules.

### The life of an invoice

1. **Issue.** A real Razorpay invoice is created. Razorpay emails it, the WhatsApp goes out the same moment, and neither counts against the message budget: delivering the bill is not a reminder.
2. **Chase.** Follow-ups ride three channels at once: Baaki's WhatsApp with drafted Hinglish text, plus Razorpay's own email and SMS for the same invoice. One decision, one touch against the budget, three envelopes.
3. **Call.** When messages stop returning information (a buyer silent past a threshold, or a promise passed with nothing said) the agent places a real phone call and speaks Hindi. It takes consent first, resolves spoken dates ("parso", "agle hafte Tuesday") against the calendar, records the buyer's exact words, and never negotiates: a discount request is handed to a person.
Replies are read wherever they arrive. A WhatsApp lands through Meta's webhook; an email reply lands through `/api/webhooks/email`, gets its quoted thread stripped, and rides the same pipeline: the model reads it, a promise freezes outreach, a dispute stops it, an opt-out is permanent. SMS stays send-only by design, since Indian transactional SMS rides sender ids that cannot receive replies.

4. **Promise.** A date agreed out loud is immediately confirmed in writing on WhatsApp with a live payment link, and outreach freezes until the day after it. A broken promise wakes the ladder back up.
5. **Paid.** Only Razorpay may say money moved. A signed webhook credits the payment, whichever generation of the link was paid, and the case closes itself.

## Where the AI is

| Job | Who does it |
| --- | --- |
| Reading free-text replies (WhatsApp and email) in Hindi, Hinglish and English | Gemini, strict JSON schema |
| Deciding cases that need judgement | Gemini case agent, function calling |
| Live phone conversations | Gemini Live, native audio, full duplex |
| Explaining the book to the merchant | "Ask Baaki AI" chat, grounded in the ledger |
| Routing, aging, ladders, budgets | pure functions, no model |
| Allowing or refusing any action | guards, pure functions |

### The case agent is bounded in code, not in the prompt

One episode per case: at most 4 tool calls, exactly one write action, a 20 second budget. Two write calls and the first wins, the rest are dropped and recorded. Budget spent without deciding and the case goes to a person. A rupee figure that is not the outstanding balance is rewritten before it can reach a buyer. A guard refusal goes back verbatim for exactly one retry, then the case goes to a person.

### Agent tools

Write tools on a case: `send_nudge`, `reissue_payment_path`, `schedule_wait`, `open_dispute`, `escalate_to_human`, `stop`.

In-call voice tools: `record_promise`, `record_dispute`, `send_payment_link_now`, `set_do_not_call`, `escalate_to_human`. A call is the least reviewable channel there is, so its tools are deliberately narrow: record what the buyer said, or hand the call to a person.

## The guards

Nine pure functions run at execution time, not proposal time, on every action:

contact window (09:00 to 18:00 IST, holidays, Sundays) · calling window (tighter: 10:00 to 18:00) · do-not-contact (permanent, covers messages and calls) · unreachable buyers (sample data is never messaged or dialled) · touch budget · minimum gaps · frozen cases (promise in flight, dispute open, held by a person) · call budget (one call per invoice lifetime, a second must be earned by an ignored message) · draft filter (no legal or threatening language before the final rung)

A refused action is itself written to the audit trail with which guard refused it.

## Stack

| Layer | Tech |
| --- | --- |
| Payments, invoices, webhooks | Razorpay (Invoices API, signed webhooks) |
| Messaging | WhatsApp Cloud API (Meta), Razorpay email + SMS notify |
| Voice | Twilio Media Streams ↔ Gemini Live, bridged on Fly.io |
| Reasoning | Gemini (case agent, reply understanding, merchant chat) |
| App | Next.js on Vercel, TypeScript ESM monorepo (pnpm) |
| State | Upstash Redis: single-document ledger, locks, idempotency keys |

The voice bridge lives on Fly.io because it must hold two sockets open at once (Twilio audio in, Gemini Live out), and a serverless function cannot receive frames on an outbound WebSocket.

## Running it

```bash
pnpm install
pnpm test          # 94 tests: guards, agent bounds, policy, locks
pnpm dev           # dashboard at localhost:3000
```

Environment (see `.env.example`): `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`, `WA_PHONE_NUMBER_ID` / `WA_ACCESS_TOKEN` / `WA_APP_SECRET`, `GEMINI_API_KEY`, `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`, and Upstash `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Webhooks need a public URL; deploy, or tunnel with `pnpm tunnel`.

The voice bridge deploys separately: `cd deploy/fly && flyctl deploy`.

## The demo screen

`/demo` runs the whole life of one invoice in minutes. The only simulated thing is the calendar: every jump runs a real decision pass, the WhatsApp and email and SMS really send, the call really rings, the guards see the moved date rather than being switched off, and the ending is you paying a real Razorpay test link and the webhook closing the case on screen. Successful runs stay on the main dashboard as history; resetting removes unfinished rehearsals.

## Screens

**Invoices**: the book, with recovered totals and each invoice's full journey. **New invoice**: pick a buyer, set amount, terms and the rules the agent must stay inside. **Demo run**: the living timeline. Plus **Ask Baaki AI**, a Hinglish chat grounded in the ledger that can explain any decision but cannot act.

## More

`docs/ARCHITECTURE.md` for the decision loop in detail, `docs/POLICY.md` for every knob and where its value came from, `docs/FAILURES.md` for what broke while building this and how each was found, `docs/DEPLOYMENT.md` for the topology.
