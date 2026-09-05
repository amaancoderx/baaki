# What broke, and what it cost

Real entries from building this. Each one is a thing that was wrong in the
repository at some point, how it was caught, and what changed.

---

## 1. A broken promise guaranteed payment, which inverted the persona book

**What was wrong.** The simulator modelled a promise the buyer did not intend to
keep as "pays on the promised date plus a slip". That is a scheduled payment. It
meant `promise_breaker` — a persona defined by a 25% promise-kept probability —
always paid, and paid on a known date.

**How it showed.** The first per-persona run had `promise_breaker` at 100%
collected with a DSO of 34 days, better than `prompt_payer` at 26 days and far
better than everyone else. A persona designed to be one of the worst payers was
the second best.

**Why it mattered.** Not cosmetic. The agent's central judgment call is whether
to wait on a promise. If breaking a promise still delivers money on a schedule,
waiting is always correct and the decision the product exists to make is free.

**Fix.** A promise now buys the buyer quiet, not the merchant money.
`scheduledPayOn` is set only when the buyer intends to keep; otherwise
`quietUntil` suppresses the hazard while they sit on their own date, and the
ordinary hazard resumes afterwards with nothing owed.
(`packages/sim/src/buyer.ts`)

---

## 2. A single global RNG made the whole experiment unpaired

**What was wrong.** One `Rng` instance served buyer creation, persona
assignment, invoice amounts, arm assignment, reply draws and payment hazards.
Any policy change altered how many draws were consumed, which shifted every
downstream draw.

**How it showed.** A per-persona table showed Baaki losing to Baseline on
`ghost` by 7.2 points and on `disputer` by 4.3. After splitting the streams and
changing nothing else, both flipped positive and the overall delta moved from
+1.0 to +3.3. The original "losses" were a different set of buyers, not a worse
policy.

**Why it mattered.** Every number in the report is a comparison between two
arms. If a policy edit silently reassigns who is a ghost and who is a prompt
payer, the comparison measures the reshuffle.

**Fix.** A setup stream for the ledger, and per-buyer `hazard` / `reply` / `text`
streams seeded from `(seed, buyerIndex, label)`. The hazard draw is taken every
invoice-day even when a promise already forces payment, so the payment stream
advances at the same rate under every policy.
(`packages/sim/src/rng.ts`)

---

## 3. An inbound promise silently un-escalated a case a human owned

**What was wrong.** `Ledger.recordReply` treated only `paid` and `closed` as
states the automated ladder may not pull an invoice out of. A promise or dispute
arriving after `escalate_to_human` flipped the substate to `promised` and handed
the case straight back to the machine.

**How it showed.** The invariant `sends zero touches after escalation to a human`
failed on `inv_200` with touch `t_1154`. Nothing in the unit tests caught it,
because each guard was correct in isolation — the ledger was moving the invoice
out from under them.

**Why it mattered.** This is the compliance claim. "Escalated to a human" has to
mean the machine has stopped, permanently, until a person says otherwise.

**Fix.** `human_hold` joined `paid` and `closed` in `AGENT_MAY_NOT_REOPEN`. The
reply is still recorded and audited so the owner sees it on the timeline, with an
entry saying explicitly that the invoice stays with the human.
(`packages/core/src/ledger.ts`)

---

## 4. The ladder's own cadence was tripping the over-contact penalty

**What was wrong.** `minGapDays: 3` with a five-rung ladder put three touches
inside a seven-day window. Every persona's `over_contact` block sets
`max_touches` at 1 or 2 over `window_days: 7`. The policy was walking straight
into the penalty on every case.

**How it showed.** 55 complaints and 26 do-not-contact events per 320 treated
invoices, against zero for a fixed reminder schedule, while collecting no more
money.

**Why it mattered.** The over-contact parameters are the simulator's opinion
about goodwill, and goodwill is the resource this product spends. A loop that
spends it faster than a dumb reminder schedule and collects the same amount is
worse than the thing it replaces.

**Fix.** Widening gaps per rung (`rungGapDays: [0,10,10,14,18]`), a gap
multiplier for buyers who have never replied, and a hard touch cap on silent
buyers that hands the case to a human instead of climbing. Complaints and
opt-outs both went to zero and collection went up.
(`packages/core/src/policy.ts`, `packages/core/src/types.ts`)

---

## 5. The sensitivity grid could not find a losing region, because it varied the wrong things

**What was wrong.** The grid from the plan varies owner-persona lift,
promise-kept probability, over-contact penalty and reply rate — 54 cells, all
probing reply-reading and restraint. Zero cells favoured Baseline.

**How it showed.** `0/54 grid cells favour Baseline` is not a good result. A
product that cannot be made to lose anywhere in a four-dimensional sweep is
usually being measured along dimensions that do not touch its actual mechanism.

**Why it mattered.** An ablation showed where the effect actually comes from:
removing link reissue alone dropped the seed win rate from 7/10 to 4/10. Baaki's
margin is mostly repairing dead payment links, and not one of the grid's four
axes changes how many links are dead.

**Fix.** Two axes added: `deadLinkRate` (0 or 0.4) and a `touchLiftScale` that
scales how much any touch moves the payment hazard. The losing region is now
real and reported.
(`packages/evals/src/report.ts`, `packages/sim/src/engine.ts`)

---

## 6. The headline effect shrank as the sample grew

**What was wrong.** Nothing in the code. A measurement error in how the first
result was read.

**How it showed.** At 400 invoices per seed the delta was +2.8pp. At 1200 it was
+1.2pp. At 2500 it was +0.6pp. The apparent effect was substantially small-sample
noise in the baseline arm, which holds only 20% of the invoices and had a
seed-to-seed standard deviation two to three times the treatment arm's.

**Why it mattered.** +2.8pp is a number you would put in a README. It would not
have survived contact with a larger run.

**Fix.** The headline is measured at a balanced 50/50 split with a 95% confidence
interval, and the 20% holdout a merchant would actually deploy is reported
separately with its wider interval. Both are in `evals/report.md` §2.

---

## 7. The whole agent layer was wired but never called

**What was wrong.** The simulator's `runSim` took an optional `slowDecider`.
Nothing ever passed one. The router faithfully computed that a case needed
judgment, and then this ran:

```ts
if (r.route === "slow" && opts.slowDecider) { ... } else { fastPath(c) }
```

**How it showed.** It did not show. Every test passed, the invariants held, the
report generated, and the README described a system with a case agent in it.
The question "how did you eval without an LLM API?" is what surfaced it.

Instrumenting the router during a run rather than after gave the size: **13,593
decisions across 5 seeds** were escalated to a case agent that did not exist and
silently fell back to rules. Separately, the simulator handed the ledger the
reply intent it had sampled, so **70% of inbound replies were free text that no
parser ever read** — the agent was scored with perfect comprehension it had not
earned.

**Why it mattered.** Not one published number was wrong, but the report did not
say which parts of the system produced them. A reader would reasonably have
assumed the model was in the loop.

**Fix.** The agent is built and bounded (`packages/core/src/agent/`), the parser
is built (`understand.ts`), the simulator takes a `replyParser` that feeds only
the parse to the ledger while keeping the sampled truth for scoring, and
`evals/report.md` opens with §0 stating exactly what is deterministic and what
is not. A model-in-the-loop run is in `evals/agentic-run.md`.

---

## 8. Gemini 3 rejected every multi-turn tool episode

**What was wrong.** The adapter rebuilt tool history from `{name, args}` when
feeding a prior call back to the model. Gemini 3.x issues each `functionCall`
with a `thoughtSignature` and rejects the call if it returns without one:

```
400: Function call is missing a thought_signature in functionCall parts.
```

**How it showed.** 5 of 29 episodes in the first agentic run ended in
`human-error`. The agent could decide immediately, but the moment it called a
read tool first and tried to continue, the next turn 400'd. Mean tool calls per
episode was 1.06 against a budget of 4 — the read tools were effectively dead.

**Why it mattered.** Reading the case before deciding is the entire argument for
having an agent rather than a rule. Failing closed to `escalate_to_human` meant
it was safe but useless.

**Fix.** `ToolCall` carries the provider's original part opaquely and replays it
verbatim. Errors went to 0 and mean tool calls per episode to 1.66.

---

## 9. The router re-escalated the same case every day

**What was wrong.** A free-text reply counted as handled only once a *touch*
postdated it. An agent that answered with `schedule_wait` sent nothing, so the
reply stayed forever unhandled.

**How it showed.** `inv_8` went to the case agent on four consecutive days and
produced the same `schedule_wait` each time, with the same reasoning, at full
model cost. "unhandled free-text reply" was the top escalation reason at 18 of
31.

**Why it mattered.** Every one of those is a paid call for a decision already
made, and the ~80/20 deterministic split the design claims was quietly false.

**Fix.** A reply is handled once any decision postdates it, including one that
sends nothing, and a promise in flight is checked before the reply rules. That
reason dropped from 18 to 1 and the fast/slow split settled at 94/6.

---

## 10. Twilio strips the query string from a Stream URL

**What was wrong.** `<Stream url="wss://host/media?invoice=inv_1">` looked
correct and Twilio connected happily. The invoice never arrived.

**How it showed.** As a transport error, which it was not. Twilio reported
31951 — "Stream - Protocol connection error" — and the server logged nothing at
all, which reads like a tunnel or TLS problem. Two tunnels were swapped out
chasing it. ngrok's request log settled it: `GET /media -> 101`, query string
gone. Twilio had connected fine; the socket simply arrived not knowing which
case it was for, threw, and closed.

**Fix.** The invoice travels as a `<Parameter>` and the session is built when
the `start` event names it.

---

## 11. Native-audio models reject an explicit language

**What was wrong.** `speechConfig.languageCode = "hi-IN"`, set to stop the model
drifting into English mid-sentence.

**How it showed.** The session opened, greeted the buyer, and died the moment
real audio arrived: `1007 The audio content type (CONTENT_TYPE_AUDIO) is not
supported for this model configuration`. The error names audio, and the cause
was a language field.

**Fix.** Removed it; language is steered from the system instruction. Also moved
from `realtimeInput.mediaChunks` to `realtimeInput.audio`.

---

## 12. She stopped mid-sentence, then repeated herself, then never hung up

Three separate faults that all sounded like one bad phone call.

**Stopped mid-sentence.** Gemini emits a whole phrase in one chunk; Twilio wants
a steady 20 ms mu-law frame and drops oversized payloads. A pacer now releases
audio at real-time rate.

**Repeated herself.** `START_SENSITIVITY_HIGH` treated phone-line noise as the
buyer speaking, so the model kept abandoning and restarting its turn. Lowered,
and the `interrupted` signal now clears queued audio so an abandoned turn is not
played out over her.

**Never hung up.** A recorded promise closed the socket on a fixed six-second
timer, which either clipped her goodbye or left the buyer on a silent line.
Hangup now waits for `turnComplete`.

---

## 13. Vercel Functions can open a WebSocket but never receive on it

**What was wrong.** Nothing, in the code. The voice bridge was deployed to
Vercel next to Twilio to cut roughly 500 ms of transcontinental latency.

**How it showed.** Calls connected and stayed silent. A diagnostic route held an
outbound socket to Gemini Live for 25 seconds from inside a function: it reached
`open`, then received nothing — no `setupComplete`, no error, no close.
Disabling permessage-deflate changed nothing.

**Why it mattered.** The turn-based fallback works anywhere but puts Twilio's
recogniser and text-to-speech either side of the model, and both are audibly
worse — synthetic voice, mangled Hindi. Real-time is the product.

**Fix.** The bridge runs on Fly in Ashburn. Serverless was the wrong shape for
something that has to hold two sockets open at once.

---

## 14. A template in review failed the whole nudge

**What was wrong.** Meta answers `#132001 Template name does not exist` for a
template still queued for review, and the send threw.

**How it showed.** The agent did everything right — spotted the expired payment
link, reissued it, wrote correct Hinglish, passed every guard — and the buyer
heard nothing, because a template was waiting in a queue.

**Fix.** The channel asks which templates are actually approved and opens the
conversation with one that is. Once the buyer replies, the 24-hour session
window makes the real message sendable as free-form. A review queue should not
be something the agent cannot work around.

---

## Still open

- **The pre-due nudge measures net-negative and is shipped anyway.** It spends a
  touch while the payment hazard is near zero. It stays on because the simulator
  models a nudge as something that accelerates payment and cannot represent a
  pre-due reminder preventing lateness at all. That is a limitation of the model,
  but it does mean the rung is currently unsupported by measurement.
- **Three WhatsApp templates are still in Meta review.** Cold outreach cannot
  carry the payment link in a template button until they clear.
- **The collection numbers are the rules layer, not the agent.** Scoring the
  case agent across 10 seeds is thousands of live calls. `evals/report.md` §0
  says so; `evals/agentic-run.md` covers the model in the loop at small scale.
- **The reply eval is author-written and cannot be quoted as accuracy.** The
  same person wrote the parser prompt and the cases. The 60 merchant-written
  replies plan §7 asks for do not exist yet.
- **Simulated rupees are authored rupees.** The persona parameters are a guess,
  written down and hidden from the agent, but a guess. What makes the result
  worth anything is that the guess is checked in, seeded, and published with the
  region where it loses.
