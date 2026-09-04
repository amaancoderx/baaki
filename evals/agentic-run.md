# Agentic run

Model in the loop end to end. Seed 2018, 12 invoices, 55 days, 161s wall clock.

- Router: **421 fast / 29 slow** (6.4% went to the agent)
- Live model calls: **31** (23 served from cache, 0 model fallbacks)
- Tokens: 74,261 in, 1,337 out
- Guard violations: **0**

## Why the router escalated

| Reason | Count |
| --- | --- |
| silent past escalation threshold | 15 |
| promise broken | 6 |
| next rung is owner_whatsapp | 6 |
| unhandled free-text reply | 1 |
| next rung is human | 1 |

## What the agent chose

| Action | Count |
| --- | --- |
| `schedule_wait` | 17 |
| `send_nudge` | 9 |
| `escalate_to_human` | 3 |

Mean tool calls per episode: 1.66 (budget 4). Guard retries: 2. Extra write calls dropped: 0.

| Episode outcome | Count |
| --- | --- |
| decided | 27 |
| retried-then-decided | 2 |

## Reply understanding, in the loop

6 free-text replies parsed. Intent correct on **6/6** (100.0%).
Promise dates exact on **5/5**.

## Sample episodes

**inv_1, 2025-09-29** → `send_nudge`  
tools: check_payment_status → send_nudge  
> Agent chose to send a routine message at 3 days overdue.

**inv_3, 2025-10-01** → `escalate_to_human`  
tools: escalate_to_human  
> Agent handed the case to a person: Buyer has disputed the invoice because the GST number is incorrect. This requires the merchant to correct the GST details and reissue the invoice.

**inv_1, 2025-10-10** → `schedule_wait`  
tools: schedule_wait  
> Agent chose to wait until 2025-10-13: Last message was sent on 2025-10-09 (13 days overdue). To respect the 3-day gap policy, we must wait until 2025-10-13 (Monday) before taking further action.

**inv_2, 2025-10-10** → `send_nudge`  
tools: send_nudge  
> Agent chose to send a routine message at 14 days overdue.

**inv_1, 2025-10-11** → `schedule_wait`  
tools: get_touch_log → get_invoice → check_payment_status → schedule_wait  
> Agent chose to wait until 2025-10-13: Today is Saturday (weekend). Waiting until Monday, 2025-10-13, which is the next working day, to proceed with the owner persona nudge.

**inv_2, 2025-10-11** → `schedule_wait`  
tools: schedule_wait  
> Agent chose to wait until 2025-10-13: Respecting the 3-day minimum gap between messages and waiting for a working day (Monday, Oct 13).
