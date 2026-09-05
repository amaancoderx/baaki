# How much mishearing can it absorb?

Every other run in this repository hands the ledger the buyer's true intent.
That gives the policy perfect comprehension for free, which flatters the
behaviour it depends on most, believing a buyer and waiting, and hides its
most expensive failure: freezing outreach on a promise nobody made.

10 seeds, 800 invoices, 120-day horizon, 50/50 split.
The baseline arm ignores replies entirely, so mishearing cannot touch it,
which is what makes the delta readable.

| Parser | Baseline | Baaki | Δ pp | Misheard | Days frozen on a false promise | Opt-outs missed |
| --- | --- | --- | --- | --- | --- | --- |
| perfect comprehension | 83.76% | 86.80% | +3.04 | 0.0% | 0 | 0.0 |
| as observed in replies.md | 83.76% | 86.79% | +3.03 | 8.8% | 31 | 0.0 |
| false promise 5% | 83.76% | 86.79% | +3.03 | 10.2% | 68 | 0.0 |
| false promise 10% | 83.76% | 86.79% | +3.03 | 12.8% | 140 | 0.0 |
| false promise 20% | 83.76% | 86.79% | +3.03 | 17.9% | 290 | 0.0 |
| false promise 35% | 83.76% | 86.79% | +3.03 | 26.2% | 529 | 0.0 |
| missed promise 10% | 83.76% | 86.79% | +3.03 | 11.0% | 31 | 0.0 |
| missed promise 25% | 83.76% | 86.79% | +3.03 | 17.7% | 30 | 0.0 |
| missed promise 50% | 83.76% | 86.79% | +3.03 | 29.0% | 31 | 0.0 |
| intent flip 12.5% | 83.76% | 86.79% | +3.03 | 11.3% | 31 | 0.0 |
| intent flip 25.0% | 83.76% | 86.77% | +3.01 | 18.0% | 31 | 0.0 |
| missed opt-out 5% | 83.76% | 86.79% | +3.03 | 8.8% | 31 | 0.0 |
| missed opt-out 15% | 83.76% | 86.79% | +3.03 | 8.8% | 31 | 0.0 |

## What it costs to be wrong

Moving from perfect comprehension to the error profile observed in
`evals/replies.md` costs **0.01pp**, the difference between
3.04pp and 3.03pp. Every collection figure elsewhere in this
repository is measured at the top of that range and should be read as an
upper bound.

Baaki still beats the baseline at every false-promise rate tested, up to 35%. On the 40 replies in `evals/replies.md` the observed rate was roughly 2.5%.

## Missing an opt-out is not an accuracy point

A missed "stop" is the only route by which a real do-not-contact violation
can enter this system: every other guard is a pure function that cannot be
talked out of its answer, but a guard can only honour a flag it was told about.

- At 5%, **0.0 violations per run**, meaning buyers messaged after asking not to be.
- At 15%, **0.0 violations per run**, meaning buyers messaged after asking not to be.

This is why the number is reported on its own rather than folded into an
accuracy figure. 87.5% intent accuracy sounds acceptable; "we messaged
0 people who had asked us to stop" does not.

## The product change this argues for

A promise heard at low confidence should not freeze outreach for a week on
a guess. It should ask: one message, two buttons, "Friday 11 Sep tak, sahi
hai?" That converts an expensive silent failure into a cheap question, and it
is the change this table exists to justify. It is not built yet.
