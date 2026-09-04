# Policy

Every knob, what it does, and where its value came from. Defaults live in
`DEFAULT_POLICY` in `packages/core/src/types.ts`, policy version `p3`.

| Field | Default | Why this value |
| --- | --- | --- |
| `contactWindow` | 09:00–18:00 IST, `IN-KA` holidays | Merchant policy, not statute. Sundays and listed holidays are excluded. |
| `maxTouches` | 5 | Hard ceiling. Measurement shows the 5th rarely fires; `maxTouches: 4` scores identically. |
| `minGapDays` | 3 | Floor beneath every rung gap. A guard, not a schedule. |
| `campaignDays` | 90 | After this only `escalate_to_human` or `stop` are permitted. |
| `ladder` | `pre_due → whatsapp → whatsapp+reissue → owner_whatsapp → human` | From plan §9. |
| `rungGapDays` | `[0, 10, 10, 14, 18]` | **Measured.** At `[0,3,7,11,14]` the ladder put 3 touches inside every persona's 7-day over-contact window: ~26 complaints and ~23 opt-outs per 1200 invoices. At these gaps both are zero and collection is higher. |
| `preDueDays` | 3 | From plan §4.1. **Measures net-negative** — see the caveat below. |
| `escalateAfterSilentDays` | 14 | Silence past this with touches remaining routes to judgment. |
| `disputeStaleDays` | 3 | A dispute open longer than this routes to judgment. |
| `minParseConfidence` | 0.6 | Reply parses below this go to a human. Buttons are always 1.0. |
| `silentBackoffAfterTouches` | 2 | Two touches with zero replies widens the gap. |
| `silentBackoffMultiplier` | 2 | Doubles the required gap for a buyer who has never replied. |
| `silentTouchCap` | 4 | **Measured.** A buyer who has ignored this many messages goes to a human rather than getting another. Raising it to 99 collects marginally more but spends 0.5 more touches per invoice. |

## The pre-due caveat

`preDueDays: 3` is the one default not supported by measurement. Removing the
pre-due rung raises the delta over baseline and saves roughly 0.4 touches per
invoice.

It ships on anyway, and the reason is a limitation of the model rather than a
belief about the rung. The simulator represents a nudge as something that
multiplies the payment hazard on an invoice that is already heading for late. It
has no way to represent a pre-due reminder causing an invoice to be paid on time
in the first place, which is the entire argument for sending one. Measuring a
mechanism the model cannot express and then acting on the result would be worse
than leaving it alone.

Set `preDueDays: 0` to disable it. The measured difference is in
`evals/report.md` §2b.

## What the guards do not do

The contact window is merchant policy. Nothing here is a statutory requirement,
and the code does not claim otherwise. The statutory levers — MSMED interest,
43B(h) — are in `docs/STRETCH.md` and would sit behind Udyam eligibility and an
explicit approval.
