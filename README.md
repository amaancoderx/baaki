# Baaki

Baaki adds a promise-and-dispute ledger, buyer memory, and guarded outreach on
top of Razorpay Invoices, Payment Links and Smart Collect.

Track 03 · AI Revenue Recovery · Razorpay AI Buildathon.

---

## Measured result

500-1200 invoices per run, 10 seeds, balanced 50/50 split against a fixed
reminder schedule. Full method and per-seed numbers in
[`evals/report.md`](evals/report.md).

| Metric | Baseline (fixed reminders) | Baaki | Delta |
| --- | --- | --- | --- |
| Collected at horizon (% of billed) | 84.3 ± 1.3% | 86.4 ± 1.4% | **+2.1pp** |
| Collected by day 60 | 66.9 ± 1.9% | 70.3 ± 2.9% | +3.4pp |
| Collected by day 30 | 30.3 ± 1.6% | 28.9 ± 1.7% | **−1.5pp** |
| DSO (days, issue to settlement) | 53.8 ± 1.7 | 53.7 ± 1.8 | −0.0 |
| Touches per ₹1L collected | 1.25 ± 0.04 | 1.30 ± 0.05 | **+0.05** |
| Complaints | 0.0 | 0.0 | = |
| Do-not-contact events | 0.0 | 0.0 | = |
| **Guard violations** | 0 | **0** | = |

**Headline: +2.13pp collected, 95% CI [0.81, 3.45], winning 8 of 10 seeds.**

Three things in that table are worth reading before the good number:

- **Baaki is slower in the first 30 days.** It waits on promises and spaces its
  reminders wider, and both cost early days. It wins from day 60 onward.
- **It spends more touches per rupee**, not fewer.
- **The effect is small.** Roughly two points of collected receivables against a
  reminder schedule, not a transformation. At the 20% holdout a merchant would
  actually deploy, a single run cannot distinguish it from zero
  ([report §2](evals/report.md)).

The untreated ledger, with nobody contacted at all, settles at **74.2 ± 1.8 days**
DSO, against the ~73-day figure commonly cited for Indian SME receivables. The
persona hazards were set by hand against that number; the calibration is
reproducible with `pnpm sim:calibrate`.

## Where it loses

16 of 144 cells in the sensitivity grid favour the baseline. **Every one of them
has a promise-kept probability of 0.25.** When a promise means nothing, the days
spent honouring one are never repaid, and the most valuable thing the loop does,
believing a buyer and waiting, becomes its most expensive habit.

That is necessary but not sufficient. It has to combine with the loop having
nothing else to sell: either no payment link ever expires, so there is nothing
for reissue to repair, or a touch does not move payment at all.

Notably absent: **not one losing cell has a reduced reply rate.** Scarce replies
were expected to be a losing condition and are not.

An ablation ([report §2b](evals/report.md)) shows where the margin actually comes
from. Removing link reissue alone drops the seed win rate from 7/10 to 4/10.
40% of invoices carry a payment link that expires before it is needed, and a
nudge without a live link does nothing. **Repairing the payment path before
speaking is most of what Baaki does better than a reminder schedule.**

## How it works

```
Signals ──▶ Ledger ──▶ Decide ──▶ Guards ──▶ Act ──▶ Audit
   ▲                  (router)                        │
   │              fast path │ case agent              │
   └──── paid / expired / credited webhooks ──────────┘
```

Every Razorpay Invoice or Payment Link a merchant sends, Baaki watches. It keeps
a ledger of who owes what and for how long, and a small memory of how each buyer
behaves. Once a day it decides one bounded action per open invoice. Most days
that is a rule: not due yet, wait for the promised date, paid so close. When a
buyer has replied in free text, promised, disputed, or gone quiet past a
threshold, the case needs judgment and routes to a case agent.

A deterministic guard layer then decides whether the step is allowed: contact
window, holidays, touch budget, promise or dispute in flight, do-not-contact,
campaign end. **Guards run at execution time, not proposal time**: a decision
made at 17:58 that arrives at 18:01 does not go out.

More in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Every policy knob and
where its value came from is in [`docs/POLICY.md`](docs/POLICY.md).

## Where the model is, and where it is not

| Job | Who does it | Evidence |
| --- | --- | --- |
| Prioritising, aging, memory, ladder position | arithmetic | `evals/report.md` |
| Deciding the routine ~94% of cases | rules, one pure function | `packages/core/src/policy.ts` |
| Reading free-text replies | model, strict JSON schema | `evals/replies.md` |
| Deciding the ~6% that need judgment | model, six write tools | `evals/agentic-run.md` |
| Allowing or refusing any of it | guards, pure functions | `packages/evals/src/invariants.test.ts` |

**The collection numbers above are the deterministic layer only.** Scoring the
case agent across 10 seeds would be thousands of live model calls, and those
figures are meant to be reproducible without an API key. `evals/report.md` §0
states this rather than leaving it to be assumed.

A model-in-the-loop run is measured separately in `evals/agentic-run.md`: 29
escalated cases decided by the agent, 0 guard violations, 0 failed episodes,
mean 1.66 tool calls against a budget of 4.

### The agent is bounded in code, not in the prompt

One episode per case: at most 4 tool calls, exactly one write action, 20-second
budget. If the model emits two write calls the first is taken and the rest are
dropped and recorded. If it spends its budget reading without deciding, the case
goes to a human. If it names a rupee figure that is not the outstanding balance,
the figure is rewritten before the message can reach a buyer. If a guard refuses
its action, the violation goes back verbatim for exactly one retry, and then the
case goes to a human.

Twelve tests in `packages/core/src/agent/agent.test.ts` hold those bounds, all
against a fake model so they need no network.

## Guarantees, as tests

`packages/evals/src/invariants.test.ts` runs over full simulated runs, not
fixtures. The test names are the stopping rules:

```
✓ sends no touch outside 09:00-18:00 IST
✓ sends no touch on a holiday or a Sunday
✓ never exceeds maxTouches on any invoice
✓ never sends two touches closer than minGapDays
✓ sends zero touches while a promise is in flight
✓ sends zero touches while a dispute is open
✓ sends zero touches after escalation to a human
✓ sends zero touches after do_not_contact is set
✓ sends zero touches after the invoice is paid in full
✓ sends no free-form WhatsApp outside the 24-hour session window
✓ reaches a terminal state on every campaign by its end date
✓ gives every audit entry a rationale and at least one evidence link
✓ records a guard verdict on every touch it logged
```

56 tests, all passing. One of them caught a real compliance bug: an inbound
promise was silently un-escalating a case a human already owned
([`docs/FAILURES.md`](docs/FAILURES.md) §3).

## Live

Nothing runs on a developer machine.

| | |
| --- | --- |
| Dashboard, API, webhooks | `https://baaki-llcadaxongmailcoms-projects.vercel.app` |
| Voice bridge | `https://baaki-voice.fly.dev` |
| Ledger, policy, contacts | Upstash Redis |

Verified end to end against a real Indian mobile:

- **Razorpay** issues the invoice and the payment link; a signed
  `payment_link.paid` closes the case with the event id as audit evidence.
- **The agent** noticed the payment link had expired, reissued it before
  speaking, and wrote the nudge itself.
- **WhatsApp** delivered it. The reply, *"Me monday tak payment krta hu"*,
  was read as a promise for 2026-09-07 at 0.95 confidence, and
  outreach froze. The next tick routed to the fast path with reason
  `promise still in flight` and sent nothing.
- **Voice**: a real call in Hindi. *"agle hafte Tuesday"* became a promise for
  2026-09-15, next week's Tuesday rather than this week's, then she said goodbye and
  hung up.

Deployment, and why the voice bridge lives on a different host, is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Running it

```bash
pnpm install
pnpm test              # guards + invariants over full runs
pnpm sim               # arms comparison, printed
pnpm sim:calibrate     # untreated DSO against the ~73-day figure
pnpm evals:report      # regenerates evals/report.md (~20 min, no API key needed)

# these need GEMINI_API_KEY in .env
pnpm evals:replies     # reply understanding, scored and cached
pnpm evals:agentic     # small run with the model in the loop end to end

pnpm snapshot          # freeze a run for the dashboard
pnpm dev               # Today and Case at localhost:3000
```

## Why the simulator is worth anything

The buyer model is rule-based with parameters hidden from the agent, checked in
at [`packages/sim/src/personas.yaml`](packages/sim/src/personas.yaml). The
`CaseFile` type the decider receives has no field that could carry them. A
language model's only role in the simulator is rendering the surface text of a
reply whose intent the rules already sampled, so the agent cannot win by writing
messages a model happens to like. It wins by repairing payment paths, reading
replies, and exercising restraint.

Randomness is split into a setup stream and per-buyer hazard, reply and text
streams. A policy change cannot reshuffle who is which persona or which arm they
landed in. Before that split, a per-persona table showed two personas losing that
were in fact winning; the "losses" were a different set of buyers
([`docs/FAILURES.md`](docs/FAILURES.md) §2).

Simulated rupees are still authored rupees. What makes the result defensible is
that the authorship is written down, hidden from the agent, seeded, and published
together with the region where it loses.

## What broke

[`docs/FAILURES.md`](docs/FAILURES.md) holds fourteen real entries. A modelling bug
that made the worst-paying persona the second-best. A headline effect that shrank
from +2.8pp to +0.6pp when the sample grew. An entire agent layer that was wired
but never called. Twilio silently dropping the query string from a stream URL,
reported as a transport error. And Vercel Functions opening an outbound WebSocket
that never delivers a frame, which is why the voice bridge runs somewhere else.

## What is not built

[`docs/STRETCH.md`](docs/STRETCH.md) lists them, one line each. The WhatsApp channel and
the Razorpay adapter are the next two, and the 60 merchant-written replies plan
§7 asks for are the missing evidence. Nothing in this repository is a stub: a
feature that is not finished does not exist in code.
