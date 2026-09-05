# Voice bridge

Twilio Media Streams to Gemini Live, deployed next to Twilio.

The audio path is the only thing here. Every frame of a call crosses whatever
distance separates Twilio's media servers from this process, twice, so this
runs in `iad1` — Washington DC, beside Twilio's Ashburn media servers. Running
it on a laptop in India instead added roughly half a second of pure geography
to every turn, which is the difference between a conversation and a walkie
talkie.

The ledger stays on the merchant's machine. Tool calls — a promise recorded, a
dispute opened — travel back over HTTP to `BAAKI_API`. That hop is slow and it
does not matter: it happens a handful of times per call, never per audio frame.

Environment:

    GEMINI_API_KEY   the model
    BAAKI_API        public URL of the webhook service holding the ledger
    GEMINI_VOICE     prebuilt voice name, default Aoede
