# What the case agent adds

Same seeds, same buyers, one difference: who answers the slow path.

- **Seeds:** 3 (`7919, 15838, 23757`)
- **Invoices per seed:** 400, 120-day horizon, 50/50 split
- **Live model calls:** 255 · **cache hits:** 368
- Decisions are cached by a canonical case hash, so identical situations are asked once.

## Per seed

| Seed | Rules collected | Agent collected | Δ pp | Rules t/₹1L | Agent t/₹1L | Violations |
| --- | --- | --- | --- | --- | --- | --- |
| 7919 | 87.70% | 86.04% | -1.66 | 1.24 | 1.01 | 0 |
| 15838 | 90.11% | 89.27% | -0.85 | 1.23 | 1.08 | 0 |
| 23757 | 86.30% | 84.23% | -2.07 | 1.35 | 1.10 | 0 |

**Mean delta: -1.53pp across 3 seeds.** Three seeds is a wide interval; the per-seed numbers above are the honest view.

## Per persona

| Persona | Rules | Agent | Δ pp |
| --- | --- | --- | --- |
| `chronic_late` | 90.5% | 89.3% | -1.2 |
| `disputer` | 83.8% | 82.0% | -1.8 |
| `ghost` | 63.9% | 63.9% | +0.0 |
| `partial_payer` | 71.5% | 68.1% | -3.4 |
| `promise_breaker` | 80.7% | 81.8% | +1.1 |
| `prompt_payer` | 98.6% | 98.3% | -0.3 |

The agent should show up where a case needs reading — `disputer`,
`promise_breaker`, `partial_payer` — and be near zero on `prompt_payer`, who
pays anyway, and `ghost`, who never says anything to read.

## Reading a delta of about zero

A small delta is a result, not a failure. It would say the rules already
capture most of the value and the agent's job is the minority of cases the
rules cannot parse — done with zero guard violations. That is a defensible
position and a more honest one than an unmeasured claim.
