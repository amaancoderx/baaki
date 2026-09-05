# Architecture

## The loop

```
Signals ──▶ Ledger ──▶ Decide ──▶ Guards ──▶ Act ──▶ Audit
   ▲                  (router)                        │
   │              fast path │ case agent              │
   └──── paid / expired / credited webhooks ──────────┘
```

One pass per invoice per day, plus a pass whenever a buyer replies. Each pass
ends in exactly one action and one audit entry.

## Packages

| Package | Holds |
| --- | --- |
| `packages/core` | ledger, memory, guards, router, fast-path policy, drafts, executor, audit |
| `packages/sim` | personas, hazard engine, RNG streams, reply renderer, snapshot generator |
| `packages/evals` | invariant suite over full runs, report generator, statistics |
| `apps/dashboard` | Next.js, Today and Case |

## Ledger

One record per invoice. State (`open → due → overdue`) is a function of the
calendar. Substate (`awaiting_reply | promised | disputed | human_hold | paid |
closed`) is a function of events.

Buyer memory is recomputed from the event log rather than incrementally patched,
so the numbers on screen always match the events beneath them. Money is paise as
an integer throughout; rupee floats do not survive arithmetic and the report
compares collected amounts across seeds.

Two sets matter:

- `TERMINAL` = `paid`, `closed`
- `AGENT_MAY_NOT_REOPEN` = `paid`, `closed`, `human_hold`

The second exists because an inbound promise must not hand a case back to the
machine after a person has taken it. See `docs/FAILURES.md` §3.

## Router

Deterministic and small. A case goes to the slow path only when it needs
judgment:

- an unhandled free-text reply
- a reply parsed below the confidence threshold
- a promise whose date passed without payment
- a dispute open longer than `disputeStaleDays`
- silence past the escalation threshold with touches remaining
- the next rung is `owner_whatsapp` or `human`

Everything else is the fast path. The split is measured, not asserted: the Today
screen labels each case `rules` or `case agent`, and the reason is on the card.

## Guards

Nine pure functions of `(case, action, now)`. They run at **execution** time, not
proposal time, so a decision made at 17:58 that arrives at 18:01 does not go out.

`stop_on_paid` · `do_not_contact` · `campaign_end` · `no_contact_while_held` ·
`contact_window` · `max_touches` · `min_gap_days` · `whatsapp_24h_window` ·
`draft_filter`

Every guard runs on every action, always. Short-circuiting on the first failure
would leave the audit trail with a partial picture, and completeness is the
point of the log.

Only outbound contact is gated. `schedule_wait`, `escalate_to_human` and `stop`
are always permitted, so a case can always reach a terminal state.

## Fast path

A pure function `policy(case) → action`. Given the same case file it returns the
same action, which is what makes the holdout comparison meaningful.

Rung gaps widen as the ladder climbs, and widen again for buyers who have never
replied. A buyer who has ignored `silentTouchCap` messages goes to a human
rather than getting another. All three came out of measurement. See
`docs/FAILURES.md` §4 and `evals/report.md` §2b.

## Case agent

`packages/core/src/agent/`. One bounded episode per escalated case.

- **Tools**: six write (`send_nudge`, `reissue_payment_path`, `schedule_wait`,
  `open_dispute`, `escalate_to_human`, `stop`) and four read (`get_invoice`,
  `get_buyer_history`, `get_touch_log`, `check_payment_status`).
- **Budget**: 4 tool calls, exactly one write action, 20 seconds.
- **One write** is enforced in the loop. Extra write calls are dropped and the
  drop is recorded in the trace.
- **Amounts are injected, never generated.** A draft naming a rupee figure that
  is not the outstanding balance has it rewritten before the action is formed.
- **Guard rejection** hands the violation text back verbatim for one retry, then
  the case goes to a human.
- **Every failure path ends at a human**: no tool call, budget spent on reads,
  timeout, or an API error all produce `escalate_to_human` with the reason.

The model never touches the ledger. It returns a tool call, which becomes an
`Action`, which goes through the same `runGuards` and `execute` path as a
fast-path decision. There is no privileged route.

## Reply understanding

`packages/core/src/understand.ts`. Free text in, `{intent, promiseDate,
disputeReason, confidence}` out, under a response schema.

Buttons never come through here, because their payload carries the meaning exactly,
which is most of why the ladder uses them. Roughly 30% of replies are buttons.

`normaliseParse` enforces what the schema cannot: a `promise` with no date, a
date already past, or a date beyond the campaign horizon is demoted to
`will_pay`. Acting on any of those would freeze outreach for a date the buyer
never gave.

## Audit

Append-only. Nothing mutates or removes an entry. Each carries actor, action,
params, rationale, every guard verdict, policy version, and at least one
evidence link. The constructor rejects an entry with no rationale or no
evidence, so the invariant is enforced at the write rather than tested after.

Export is JSON or CSV.

## Simulator

Buyer personas are rule-based parameter sets in
`packages/sim/src/personas.yaml`, hidden from the agent by construction: the
`CaseFile` type has no field that could carry them. The model's only role in the
simulator is rendering the surface text of a reply whose intent the rules already
sampled.

Randomness is split into a setup stream (buyers, personas, amounts, arm
assignment) and per-buyer `hazard` / `reply` / `text` streams. This keeps the
comparison paired: a policy edit cannot reshuffle who is which persona or which
arm they landed in. See `docs/FAILURES.md` §2.

## Voice

Two paths, and the difference is audible.

**Real-time** (`deploy/fly/server.ts`) runs Twilio Media Streams into Gemini Live.
The model hears the caller and answers in its own voice, so no speech
recognition or text-to-speech sits in between. mu-law 8k in, PCM 16k to the
model, 24k back, paced to 20 ms frames because Twilio drops oversized payloads.
Barge-in clears queued audio so an abandoned turn is not played over the buyer.

**Turn-based** (`packages/core/src/voice/gather.ts`) puts Twilio's recogniser and
text-to-speech either side of Gemini. Runs anywhere, needs no WebSocket, sounds
synthetic and mishears Hindi. It exists because real-time needs a host that runs
a persistent process, and it is what answers if the bridge is unreachable.

`VOICE_MODE` selects. Both use the same five in-call tools, the same ledger and
the same audit trail: a promise made on a call is the same object as a promise
made in a chat.

The tools are deliberately narrow: `record_promise`, `record_dispute`,
`send_payment_link_now`, `set_do_not_call`, `escalate_to_human`. A call is the
least reviewable channel there is, so the agent records what was said or hands
over. It does not argue a dispute, offer a discount, or claim a payment arrived.
Consent is the first thing said on every call.

## Storage

The ledger is one Redis key. It is small, read and written as a unit, and
keeping it whole is what keeps the append-only audit log consistent with the
invoices it describes. `RedisLedgerStore.update` is read-modify-write and not
transactional; that is acceptable for one merchant's book where deliveries are
seconds apart, and a busier one wants per-invoice keys and a WATCH.

`LedgerStoreLike` lets the same runtime serve a laptop and a serverless
function: the file store is synchronous, Redis is not, and callers await either.

## Dashboard

`apps/dashboard/data/snapshot.json` is emitted by
`packages/sim/src/snapshot.ts`, which freezes a real run at a chosen day. The
proposals on the Today screen are computed by the real `route()`, `fastPath()`
and `runGuards()` against the frozen ledger. Nothing in the JSON is authored by
hand.

Regenerate with:

```
pnpm snapshot
```
