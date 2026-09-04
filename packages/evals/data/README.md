# Eval data

## `replies_author_written.jsonl`

Written by the repository author, not by merchants. **This is not the
hand-labelled set plan §7 asks for**, and its score must never be quoted as
reply-understanding accuracy: the same person wrote the parser prompt and these
cases, so it measures self-consistency as much as capability.

It exists to catch regressions and to make the harness runnable today.

## `replies_hand_labelled.jsonl` — not yet written

The real set. 60 replies in the Hinglish and English buyers actually use, with
labels, written by people who run small businesses. Plan §7: ask two or three
of them to write ten each.

Same JSONL shape. Drop the file in and `pnpm evals:replies` picks it up and
reports it separately.

## Format

```json
{"id":"r001","text":"...","today":"2025-10-30","label":{"intent":"promise","promise_date":"2025-10-31"},"note":"why this one is here"}
```

`intent` is one of `will_pay`, `promise`, `dispute`, `already_paid`, `partial`,
`stop`, `unclear`. `promise_date` is present only for `promise`.
