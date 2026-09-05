# Deployment

Nothing runs on a developer machine. Three pieces, in two places, for one
reason each.

## Where things run, and why

| Piece | Host | Why there |
| --- | --- | --- |
| Dashboard, API, webhooks | Vercel `iad1` | Next to Twilio and Razorpay's US endpoints |
| Ledger, policy, contacts | Upstash Redis | A serverless function has an ephemeral disk and no shared state between instances |
| Voice bridge | Fly `iad` | Needs a process that stays alive holding two sockets at once |

**Vercel Functions cannot run Gemini Live.** A diagnostic route held an outbound
WebSocket to the Live API for 25 seconds from inside a function: the socket
reached `open` and then received nothing: no `setupComplete`, no error, no
close. Disabling permessage-deflate changed nothing. Gemini Live is full-duplex,
so the voice bridge has to live somewhere with a real process. That is the whole
reason for the second host.

## URLs

```
dashboard  https://baaki-llcadaxongmailcoms-projects.vercel.app
voice      https://baaki-voice.fly.dev
```

## Webhooks

Both are registered through APIs rather than dashboards, so they are
reproducible instead of clicked into existence.

**Razorpay.** `POST /v1/webhooks` with the events Baaki acts on. Note that
`virtual_account.credited` is rejected unless Smart Collect is enabled on the
account; it is a paid add-on and returns 404 on a plain test account.

**Meta.** Two calls, and both are needed:
```
POST /{app-id}/subscriptions      callback_url + verify_token + fields=messages
POST /{waba-id}/subscribed_apps   subscribes the WABA to the app
```
Registering only the first looks successful and delivers nothing.

Signatures are verified over the raw request bytes in both cases. Parsing and
re-serialising the JSON would reorder keys and change the digest.

## Environment

`.env.example` lists every key. The ones with sharp edges:

- **`WA_ACCESS_TOKEN`** must be a System User token with
  `whatsapp_business_messaging` and `whatsapp_business_management`, expiry
  Never. The tokens the API Setup page hands out expire in 24 hours and will
  die mid-demo.
- **`WA_APP_SECRET`** is what makes signature verification real. Without it the
  endpoint accepts anything claiming to be Meta.
- **`VOICE_MODE`**: `live` routes calls to the Fly bridge; `gather` falls back
  to Twilio's recogniser and text-to-speech, which runs anywhere but sounds
  synthetic and mishears Hindi.
- **`VOICE_BRIDGE`**: the Fly URL. Without it the answer route falls back to
  `gather` regardless of `VOICE_MODE`.

## Deploying

```bash
# dashboard + API + webhooks
vercel deploy --prod

# voice bridge
cd deploy/fly && fly deploy --remote-only
```

Vercel's root directory is `apps/dashboard` with a pnpm workspace install at
the repo root; the project settings carry this, not `vercel.json`.

Deployment protection must stay off. A webhook endpoint that answers 302 to a
signed delivery is not an endpoint.

## Templates

Three utility templates are submitted per WhatsApp account and reviewed by Meta,
usually within hours. Until they are approved the channel opens a conversation
with an approved template instead; once the buyer replies, the 24-hour session
window makes the real message sendable as free-form. Meta's review queue should
not be something the agent cannot work around.


## Inbound email

`POST /api/webhooks/email` reads buyer replies into the same pipeline as
WhatsApp. It accepts JSON (`from`, `subject`, `text`) or SendGrid-style
multipart form data, authenticated with `?token=EMAIL_INBOUND_TOKEN` since the
inbound-mail ecosystem has no one signature scheme.

To route a real mailbox at it, either works:

**Cloudflare Email Routing** (free, needs a domain on Cloudflare): route
`collections@yourdomain` to an Email Worker that POSTs the message to the
endpoint with the token.

**SendGrid Inbound Parse**: point the domain's MX at SendGrid and set the
Inbound Parse destination to the endpoint URL with the token.

Buyers are matched by sender address against the email on the invoice, and the
reply attaches to their earliest-due open invoice. Mail from an address not on
file is ignored rather than guessed at.


## Personalised outbound email

Set `RESEND_API_KEY` and `EMAIL_FROM` (an address on a domain verified with
Resend) and every follow-up email carries the same drafted text as the
WhatsApp, with the live link, from the merchant's own address. Unset, the
email leg falls back to Razorpay's branded reminder. The same domain, routed
through Cloudflare Email Routing, feeds replies back into
`/api/webhooks/email`, which is what closes the loop Razorpay's no-reply
address cannot.
