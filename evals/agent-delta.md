# What the case agent adds

Same seeds, same buyers, one difference: who answers the slow path.

- **Seeds:** 3 (`7919, 15838, 23757`)
- **Invoices per seed:** 400, 120-day horizon, 50/50 split
- **Live model calls:** 0 · **cache hits:** 2464
- Decisions are cached by a canonical case hash, so identical situations are asked once.

## It depends entirely on whether anyone works the queue

The agent escalates more often than the rules do. Whether that is caution
or abandonment depends on something outside the agent: what the merchant does
with the cases handed to them.

| Cases a person recovers | Rules collected | Agent collected | Δ pp | Rules t/₹1L | Agent t/₹1L | Messages saved |
| --- | --- | --- | --- | --- | --- | --- |
| 0% | 88.04% | 86.51% | -1.53 | 1.27 | 1.07 | 16% |
| 25% | 90.25% | 89.44% | -0.81 | 1.24 | 1.03 | 17% |
| 50% | 94.38% | 93.42% | -0.95 | 1.19 | 0.99 | 17% |
| 75% | 98.61% | 95.81% | -2.80 | 1.13 | 0.96 | 15% |

**The agent collects less money and sends fewer messages.** It does not overtake the rules on collection at any resolution rate tested, losing between 0.8 and 2.8 points. It also spends about 16% fewer messages to get there.

Which of those two numbers matters is a business question, not a
modelling one. A merchant paying per WhatsApp conversation and worried about
goodwill reads this differently from one who only counts recovered rupees.
The simulator cannot price goodwill, so it does not pretend to: both columns
are reported and neither is combined into a score.

Three seeds is a wide interval. Per-seed numbers, at 50% resolution:

| Seed | Rules | Agent | Δ pp | Violations |
| --- | --- | --- | --- | --- |
| 7919 | 96.17% | 94.03% | -2.14 | 0 |
| 15838 | 95.36% | 92.73% | -2.62 | 0 |
| 23757 | 91.60% | 93.51% | +1.91 | 0 |

## Per persona, at 50% resolution

| Persona | Rules | Agent | Δ pp |
| --- | --- | --- | --- |
| `chronic_late` | 91.8% | 91.0% | -0.8 |
| `disputer` | 89.2% | 85.5% | -3.7 |
| `ghost` | 71.3% | 74.7% | +3.3 |
| `partial_payer` | 77.5% | 76.7% | -0.8 |
| `promise_breaker` | 85.7% | 85.2% | -0.5 |
| `prompt_payer` | 98.6% | 98.6% | +0.0 |

The agent should show up where a case needs reading — `disputer`,
`promise_breaker`, `partial_payer` — and be near zero on `prompt_payer`, who
pays anyway, and `ghost`, who never says anything to read.

## What this measures, and what it cannot

The agent is more restrained than the rules in every run: it escalates
sooner and sends fewer messages. On this simulator that restraint costs
money, consistently and across every resolution rate tested. That is the
result, and it is not the one the product would prefer.

One caution about reading it as a verdict on the model. The rules were tuned
against these personas — the rung gaps, the silent-buyer cap and the touch
budget in policy p3 all came from ablations on this simulator. The agent was
not. A like-for-like comparison would tune both or neither.

The simulator's human is deliberately crude — one draw, one fixed delay, no
negotiation, no part payment, no relationship. A real collections call can do
things the model cannot represent. Treat the break-even as an order of
magnitude, not a threshold.

Zero guard violations at every resolution rate. Whatever the agent costs or
saves, it never sent something it should not have.
