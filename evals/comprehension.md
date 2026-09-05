# How much mishearing can it absorb?

> Simulator `s4`: A person works the escalation queue; comprehension can be imperfect.

Every other run in this repository hands the ledger the buyer's true intent.
That gives the policy perfect comprehension for free, which flatters the
behaviour it depends on most, believing a buyer and waiting, and hides its
most expensive failure: freezing outreach on a promise nobody made.

10 seeds, 800 invoices, 120-day horizon, 50/50 split.
The baseline arm ignores replies entirely, so mishearing cannot touch it,
which is what makes the delta readable.

| Parser | Baaki | Δ pp | Misheard | Days frozen on a false promise | Touches | Opt-outs missed |
| --- | --- | --- | --- | --- | --- | --- |
| perfect comprehension | 86.33% | +2.86 | 0.0% | 0 | 925 | 0.0 |
| as observed in replies.md | 86.33% | +2.92 | 9.0% | 32 | 922 | 0.0 |
| false promise 5% | 86.33% | +2.92 | 10.2% | 66 | 923 | 0.0 |
| false promise 10% | 86.33% | +2.92 | 12.7% | 136 | 923 | 0.0 |
| false promise 20% | 86.33% | +2.92 | 17.8% | 280 | 923 | 0.0 |
| false promise 35% | 86.33% | +2.92 | 25.2% | 490 | 923 | 0.0 |
| missed promise 10% | 86.33% | +2.92 | 11.3% | 32 | 922 | 0.0 |
| missed promise 25% | 86.33% | +2.92 | 17.9% | 32 | 922 | 0.0 |
| missed promise 50% | 86.33% | +2.92 | 28.7% | 31 | 922 | 0.0 |
| intent flip 12.5% | 86.28% | +2.87 | 11.2% | 31 | 920 | 0.0 |
| intent flip 25.0% | 86.24% | +2.83 | 17.9% | 31 | 914 | 0.0 |
| missed opt-out 5% | 86.33% | +2.92 | 9.2% | 32 | 923 | 0.6 |
| missed opt-out 15% | 86.33% | +2.92 | 9.4% | 32 | 924 | 1.9 |

The baseline column is omitted because it cannot move: that arm ignores
replies entirely, so there is nothing for it to mishear.

## Mishearing costs almost nothing here, and the reason matters

At a 35% false-promise rate the parser invents 490 days of frozen
outreach per run and collection moves by 0.06pp. That looks like the model is
not wired in. It is: misheard replies rise from 0.0% to 25.2% and promises
recorded rise by roughly a third.

The mechanism is that the policy was not going to send anything during
those windows anyway. Touches move from 925 to 923, a handful,
across 800 invoices. Sticky decisions and 10-to-18 day rung gaps mean a
week-long freeze usually overlaps a period of deliberate silence.

So this is not evidence that comprehension does not matter. It is evidence
that **restraint is a hedge against being wrong**: a policy that messages
rarely has little exposure to freezing when it should not. A more aggressive
ladder would pay much more for the same parser.

Every collection figure elsewhere in this repository assumes perfect
comprehension. On this evidence that assumption is worth about
0.06pp, which is small, but it is small because of the policy,
not because parsing is easy.

## Missing an opt-out is not an accuracy point

A missed "stop" is the only route by which a real do-not-contact violation
can enter this system: every other guard is a pure function that cannot be
talked out of its answer, but a guard can only honour a flag it was told about.

- At 5%, **0.6 violations per run**, meaning buyers messaged after asking not to be.
- At 15%, **1.9 violations per run**, meaning buyers messaged after asking not to be.

This is why it is reported on its own rather than folded into an accuracy
figure. "87.5% intent accuracy" sounds acceptable in a way that "we messaged
people who had asked us to stop" does not.


This class was untestable until recently. The only route to an opt-out was
the over-contact penalty, and the shipped rung gaps never trigger it, so no
buyer ever opted out and the count was zero for want of a chance to fail
rather than through safety. Buyers now opt out unprompted at a low rate.

## The product change this argues for

A promise heard at low confidence should not freeze outreach for a week on
a guess. It should ask: one message, two buttons, "Friday 11 Sep tak, sahi
hai?" That converts an expensive silent failure into a cheap question, and it
is the change this table exists to justify. It is not built yet.
