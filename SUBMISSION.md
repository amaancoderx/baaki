# Baaki AI — Submission Answers

## Project Name / Title

Baaki AI

## Project Objectives / What does it solve?

Indian SMEs get paid in around 73 days. Chasing payments means remembering who promised what date, whose payment link expired, when you last reminded someone, and who needs an actual phone call. Nobody running a small business has time for this, so invoices just sit.

Baaki does the chasing. You create an invoice on top of Razorpay and it takes over. It sends the invoice on email and WhatsApp, reminds on WhatsApp + email + SMS, and if the buyer goes quiet it calls them and talks in Hindi. If the buyer says "parso tak kar dunga" on the call, it records that as a promise, sends a WhatsApp confirming the date with the payment link, and stops all reminders till that date passes. If they raise a dispute, everything stops and a human takes over. When they pay, the Razorpay webhook closes the case. No one marks anything paid by hand.

The AI decides, but hard-coded guards get the final say: no messages outside 9am-6pm, no messages on Sundays or holidays, max 5 messages per invoice, only 1 call in an invoice's lifetime, permanent do-not-contact. Every single action gets logged with the reason and proof. The reminder gaps are 10-18 days because when I tested tighter gaps, complaints went up and collections didn't.

Right now it works in Hindi, Hinglish and English, because that's what I could actually test on real calls. But nothing in the design is tied to Hindi. The buyer's language is already a field on every contact, the models underneath handle Tamil, Telugu, Bengali, Marathi and the rest, and the message drafts are just per-language templates. So taking Baaki to a Surat trader in Gujarati or a Coimbatore distributor in Tamil is config and testing, not a rebuild. A collections agent that speaks the buyer's own language is the whole point in a country with this many of them.

## GitHub Repository URL

https://github.com/amaancoderx/baaki

## 5-min Pitch Video Link

https://youtu.be/Pfg7jszBXTA

Live app: https://baaki-ai.vercel.app

## Build Challenges & Technical Obstacles

Voice was the hardest part. The call needs one server holding Twilio's audio stream and Gemini Live's websocket at the same time, and Vercel functions simply never receive frames on an outbound websocket. Wasted hours before writing a test that proved it, then moved just the voice piece to Fly.io.

Calls kept going silent after the greeting. I was guessing for a while, then added logging for how loud the audio reaching Gemini actually was. Speech was arriving fine, the model just wasn't responding. Turned out the "-latest" model alias was landing on different backends each call and some of them ignore live audio. Pinned an exact model version and it stopped. Also learned phone audio is really quiet, so I boost it 4x before sending it to the model instead of making the speech detector more sensitive, because a sensitive detector kept treating line noise as the buyer interrupting.

My demo fast-forwards the calendar so a 3 week collection story fits in 5 minutes, and that broke things in ways I didn't expect. Buyer says "Monday" on a call and it saved a date that was already in the past on the demo calendar. WhatsApp's 24 hour reply window was being checked against the fake clock so real replies from an hour ago looked 2 weeks old. Had to be strict about it: dates the buyer speaks use the ledger's calendar, provider rules like the 24hr window use the real clock.

Payments went missing twice. I paid a test invoice and the dashboard did nothing. First time: the Razorpay webhook was registered with a different secret than my server checks, so every real delivery failed signature verification. Caught it by hand-signing a fake event with my secret, which passed, meaning the endpoint was fine and the subscription wasn't. Second time: when a link expires we issue a fresh one, and that overwrote the stored Razorpay id, so paying the older link matched nothing. Now every reissued invoice carries my invoice id in its notes so payment on any version of the link finds the right case.

Also the audit log was unreadable at first. It re-wrote "waiting" every single day, so one invoice had 60 nearly identical rows. And when a guard blocked something it wasn't logged at all, which meant the blocked case retried the same action every day forever. Now decisions only get written when something changes, and a guard refusal is itself a logged event.

There's a FAILURES.md in the repo with 14 of these, including the embarrassing ones.
