# Baaki — where things stand

Track 03 · AI Revenue Recovery · Razorpay AI Buildathon
Generated from the repository and the deployed system, not from memory.

---

## 1. What it is, in one paragraph

Baaki is a program a Razorpay merchant plugs into their account. Every Invoice
or Payment Link they send, it watches. It keeps a ledger of who owes what and
for how long, and a small memory of how each buyer behaves. Once a day, and
whenever a buyer replies, it decides **one bounded action** per open invoice.
Most days that is a rule: not due yet, wait for the promised date, paid so
close. When a buyer replies in free text, breaks a promise, disputes, or goes
quiet past a threshold, a Gemini case agent reads the whole story and picks the
next step with a written reason. A deterministic guard layer then decides
whether that step is allowed at all. Money lands in Razorpay, the webhook says
paid, Baaki stops. Every action, its reason and its evidence sit in an
append-only audit log.

---

## 2. Running in production

Nothing runs on a developer machine.

| Piece | Host | Why there |
| --- | --- | --- |
| Dashboard, API, webhooks | Vercel `iad1` | Next to Twilio and Razorpay's US endpoints |
| Ledger, policy, contacts | Upstash Redis | Serverless has an ephemeral disk and no shared state |
| Voice bridge | Fly `iad` | Needs a live process holding two sockets at once |

```
dashboard  https://baaki-llcadaxongmailcoms-projects.vercel.app
voice      https://baaki-voice.fly.dev
```

### Verified end to end, on a real Indian mobile

**WhatsApp round trip**

```
Razorpay invoice raised, payment link expires 28 Jul
  → agent notices the dead link and reissues before speaking
  → WhatsApp delivered to a real phone
  → buyer: "Me monday tak payment krta hu"
  → Gemini: promise, 2026-09-07, confidence 0.95
  → ledger: promised, outreach frozen
  → next tick: fast path, "promise still in flight", 0 messages sent
```

**Voice call**

```
outbound call, Gemini native audio, Hindi
  → consent line first, always
  → buyer: "agle hafte Tuesday"
  → record_promise → 2026-09-15  (next week's Tuesday, not this week's)
  → she says goodbye, call ends cleanly
```

**Razorpay webhook** — a signed `payment_link.paid` closes the case and records
the Razorpay event id as audit evidence. A tampered signature is refused.

---

## 3. What is built

| Component | State |
| --- | --- |
| Ledger, buyer memory, append-only audit | done |
| Nine guards, run at execution time | done, 30 unit tests |
| Router + fast-path policy | done |
| Rule-based buyer simulator, 6 personas | done |
| Case agent, 6 write + 4 read tools | done, 12 tests |
| Reply understanding (Gemini, strict JSON) | done |
| Razorpay adapter | done |
| WhatsApp Cloud API channel | done |
| Voice: Gemini Live real-time | done |
| Voice: turn-based fallback | done |
| Dashboard: Today, Case, New invoice, Agent run | done |
| Redis-backed store | done |

**56 tests passing.** 11 commits.

---

## 4. The evals — what they measure and what they do not

There are **three** evals because there are three different questions. They are
reported separately on purpose; merging them would let a favourable assumption
in one inflate the number in another.

### 4.1 `evals/report.md` — is the policy worth running?

**No AI in these numbers.** Scoring the case agent across 10 seeds would be
roughly **745,920 live model calls**, and the collection figures are meant to be
reproducible by anyone with the repo and no API key.

The setup is an A/B test on simulated buyers:

- 6 buyer personas with hidden parameters (`packages/sim/src/personas.yaml`),
  never visible to the agent — the `CaseFile` type has no field that could
  carry them
- 1,200 invoices per seed, 10 seeds, 120-day horizon
- Half get **Baseline**: fixed reminders at due, +7, +14, replies ignored —
  what a reminder schedule does today
- Half get **Baaki**: the full guarded loop
- Both halves draw from the same seeded buyers, each with their own RNG stream,
  so a policy change cannot reshuffle who is who

**Result**

| Metric | Baseline | Baaki | Delta |
| --- | --- | --- | --- |
| Collected at horizon | 84.3 ± 1.3% | 86.4 ± 1.4% | **+2.1pp** |
| Collected by day 60 | 66.9 ± 1.9% | 70.3 ± 2.9% | +3.4pp |
| Collected by day 30 | 30.3 ± 1.6% | 28.9 ± 1.7% | **−1.5pp** |
| Touches per ₹1L collected | 1.25 ± 0.04 | 1.30 ± 0.05 | **+0.05** |
| Complaints / opt-outs | 0 | 0 | — |
| **Guard violations** | 0 | **0** | — |

**Headline: +2.13pp, 95% CI [0.81, 3.45], winning 8 of 10 seeds.**

Two of those rows are worse for Baaki and are printed at the same size as the
good one. It is slower over the first month because it waits on promises, and
it spends more messages per rupee, not fewer.

**Calibration.** An untreated ledger — nobody contacted at all — settles at
**74.2 ± 1.8 days** DSO against the ~73-day figure commonly cited for Indian
SME receivables. The persona hazards were set by hand against that number and
the calibration is reproducible.

### 4.2 What each part of the loop is actually worth

Removing one component at a time:

| Variant | Collected | Delta | Touches/inv | Complaints |
| --- | --- | --- | --- | --- |
| Full policy (p3) | 86.4% | +2.13pp | 2.31 | 0.0 |
| **No link reissue** | 85.8% | **+1.49pp** | 2.32 | 0.0 |
| No pre-due nudge | 86.4% | +2.11pp | 2.13 | 0.0 |
| No silent backoff or cap | 86.3% | +2.03pp | 2.38 | 0.0 |
| Narrow rung gaps | 86.0% | +1.72pp | 2.62 | **16.7** |
| maxTouches 3 | 85.3% | +0.98pp | 2.01 | 0.0 |

**Most of the effect is link repair, not clever reply-reading.** 40% of invoices
carry a payment link that expires before it is needed, and a nudge without a
live link does nothing at all. That is a boring mechanism, and being able to
name it is worth more than a larger number nobody can explain.

The narrow-gaps row is the other finding: the same collection, but 16.7
complaints and 13.5 opt-outs per run. Goodwill is the resource this product
spends.

### 4.3 Per buyer type

| Persona | Baseline | Baaki | Delta |
| --- | --- | --- | --- |
| `partial_payer` | 65.9% | 72.1% | **+6.2** |
| `disputer` | 79.9% | 83.7% | +3.8 |
| `promise_breaker` | 82.4% | 85.1% | +2.7 |
| `chronic_late` | 90.0% | 92.1% | +2.1 |
| `prompt_payer` | 97.0% | 98.4% | +1.4 |
| `ghost` | 62.6% | 59.2% | **−3.4** |

It loses to `ghost` — buyers who never reply and punish contact. Baaki sends
them 3.11 messages against the baseline's 2.73 and collects less for it.

### 4.4 Where it loses, published

144 sensitivity cells across six dimensions. **16 favour the baseline**, and
they share one condition:

> **Every losing cell has a promise-kept probability of 0.25.** When a promise
> means nothing, the days spent honouring one are never repaid, and the single
> most valuable thing the loop does — believing a buyer and waiting — becomes
> its most expensive habit.

That alone is not enough. It has to combine with the loop having nothing else to
sell: no payment link ever dies, or a touch does not move payment at all.

**What does not appear:** not one losing cell has a reduced reply rate. Scarce
replies were expected to be a losing condition and are not.

### 4.5 `evals/replies.md` — can it read Hinglish?

40 replies, scored against Gemini with a strict response schema.

| | |
| --- | --- |
| Intent accuracy | 87.5% (35/40) |
| **Promise-date exact match** | **100% (9/9)** |
| Mean confidence when right vs wrong | 0.90 vs 0.77 |

Promise dates are the number that matters: that is the input to freezing
outreach. "Friday", "month end", "15 tarikh", "parso" all resolved correctly
against the right weekday.

**This number cannot be quoted as accuracy.** The same person wrote the parser
prompt and the test cases, so it measures self-consistency and catches
regressions. The file says so rather than presenting 87.5% as evidence.

### 4.6 `evals/agentic-run.md` — does the agent actually work?

A small run with the model in the loop end to end:

| | |
| --- | --- |
| Router split | 421 fast / 29 slow (6.4% to the agent) |
| Live model calls | 31 |
| Mean tool calls per episode | 1.66 (budget 4) |
| Guard retries recovered | 2 |
| **Guard violations** | **0** |
| **Failed episodes** | **0** |

### 4.7 The gap, stated plainly

`report.md` §0 says it outright:

- **74,592 decisions** were escalated to the case agent across those runs and
  fell through to the rules
- **71% of replies were free text**, and the simulator hands the ledger the
  correct intent — so those runs give Baaki **perfect comprehension for free**

Real parsing makes mistakes and they are not free: hearing a promise that was
never made freezes outreach until a date the buyer never gave. The ablation
suggests the assumption is not propping up the result much, since most of the
gain is link repair — but that is an argument, not a measurement.

---

## 5. Guarantees, as tests

`packages/evals/src/invariants.test.ts` runs over full simulated runs, not
fixtures. The test names are the stopping rules:

```
✓ sends no touch outside 09:00–18:00 IST
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

One of these caught a real compliance bug: an inbound promise was silently
un-escalating a case a human already owned.

---

## 6. Bugs found by building it

14 written up in `docs/FAILURES.md`. The ones that changed conclusions:

1. **A broken promise guaranteed payment** — inverted the persona book. The
   worst-paying persona was scoring second best.
2. **A single global RNG made the experiment unpaired.** Two personas looked
   like losses; after splitting the streams both flipped positive. The "losses"
   were a different set of buyers.
3. **An inbound promise un-escalated a human-owned case** — caught by an
   invariant, invisible to every unit test.
4. **The ladder's own cadence tripped the over-contact penalty** — 55 complaints
   and 26 opt-outs while collecting no more money.
5. **The headline effect shrank from +2.8pp to +0.6pp** as the sample grew. The
   first number was small-sample noise and would have gone in the README.
6. **An entire agent layer was wired but never called.** The router escalated
   13,593 decisions to a case agent that did not exist and silently fell back to
   rules. Every test passed.
7. **Twilio strips the query string from a `<Stream>` URL** and reports the
   result as a transport error. Two tunnels were swapped chasing it.
8. **Vercel Functions open an outbound WebSocket and never receive a frame.**
   Proven with a 25-second diagnostic. That is why voice runs on Fly.

---

## 7. Not done

- **The 60 merchant-written replies from plan §7.** Until they exist there is no
  honest reply-understanding accuracy number. This is the cheapest remaining
  fix: three people who run small businesses writing ten each.
- **40 hand-written case files** to score the agent's decisions rather than only
  observe them.
- **Three WhatsApp templates are in Meta's review queue.** A fallback keeps the
  system working, but cold outreach cannot carry the payment link in a template
  button until they clear.
- **Smart Collect virtual accounts** — returns 404 on a plain Razorpay test
  account; it is a paid add-on. Payment links are the collection path.
- **The 5-minute video** (plan §14).

---

## 8. Reproducing any of it

```bash
pnpm install
pnpm test              # 56 tests: guards, agent bounds, invariants
pnpm sim               # arms comparison, printed
pnpm sim:calibrate     # untreated DSO against the ~73-day figure
pnpm evals:report      # regenerates evals/report.md — no API key needed

# these need GEMINI_API_KEY
pnpm evals:replies     # reply understanding, cached
pnpm evals:agentic     # small run with the model in the loop
```
