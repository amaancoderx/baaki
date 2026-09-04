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

## Still open

- **The pre-due nudge measures net-negative and is shipped anyway.** It spends a
  touch while the payment hazard is near zero. It stays on because the simulator
  models a nudge as something that accelerates payment and cannot represent a
  pre-due reminder preventing lateness at all. That is a limitation of the model,
  but it does mean the rung is currently unsupported by measurement.
- **Simulated rupees are authored rupees.** The persona parameters are a guess,
  written down and hidden from the agent, but a guess. What makes the result
  worth anything is that the guess is checked in, seeded, and published with the
  region where it loses.
