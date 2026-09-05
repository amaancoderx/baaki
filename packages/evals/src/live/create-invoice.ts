/**
 * One invoice, end to end, against live Razorpay test mode.
 * Usage: tsx packages/evals/src/live/create-invoice.ts [contactId] [amountRupees] [termDays]
 */
import {
  Baaki, DEFAULT_POLICY, LedgerStore, formatINR, gemini, loadContacts, razorpay,
  rupees, systemClock, whatsapp,
} from "@baaki/core";

const contactId = process.argv[2] ?? "c_001";
const amount = rupees(Number(process.argv[3] ?? 180000));
const termDays = Number(process.argv[4] ?? 25);

const contacts = loadContacts("data/contacts.json");
const contact = contacts.find((c) => c.id === contactId);
if (!contact) {
  console.error(`no contact ${contactId}. Available: ${contacts.slice(0, 5).map((c) => `${c.id}=${c.name}`).join(", ")}…`);
  process.exit(1);
}

const rzp = razorpay({
  keyId: process.env.RAZORPAY_KEY_ID!,
  keySecret: process.env.RAZORPAY_KEY_SECRET!,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
});

const wa = process.env.WA_ACCESS_TOKEN
  ? whatsapp({
      phoneNumberId: process.env.WA_PHONE_NUMBER_ID!,
      accessToken: process.env.WA_ACCESS_TOKEN!,
      appSecret: process.env.WA_APP_SECRET,
      verifyToken: process.env.WA_VERIFY_TOKEN,
      dryRun: !contact.sendable,
    })
  : undefined;

const baaki = new Baaki({
  store: new LedgerStore("data/ledger.json"),
  policy: DEFAULT_POLICY,
  razorpay: rzp,
  whatsapp: wa,
  llm: process.env.GEMINI_API_KEY
    ? gemini({ apiKey: process.env.GEMINI_API_KEY, cacheDir: ".llm-cache", minIntervalMs: 2500 })
    : undefined,
  clock: systemClock(),
});

console.log(`Creating invoice for ${contact.name} (${contact.city}): ${formatINR(amount)}, net ${termDays}\n`);

const out = await baaki.createInvoice({
  contact,
  amount,
  description: `Supply against PO for ${contact.name}`,
  termDays,
  // Deliberately short: the link dies before the invoice is chased, which is
  // the 40% case the ablation showed carries most of Baaki's value.
  linkValidDays: Math.max(3, Math.round(termDays * 0.4)),
  createVirtualAccount: true,
});

console.log("Ledger invoice   :", out.invoice.id);
console.log("Due              :", out.invoice.dueOn, `(link expires ${out.invoice.linkExpiresOn})`);
console.log("Campaign ends    :", out.invoice.campaignEndsOn);
console.log("Razorpay customer:", out.razorpay?.customerId);
console.log("Payment link     :", out.razorpay?.paymentLinkId, out.razorpay?.shortUrl);
if (out.razorpay?.virtualAccount) {
  const va = out.razorpay.virtualAccount;
  console.log("Smart Collect VA :", va.id, va.account ? `${va.account} / ${va.ifsc}` : "", va.vpa ?? "");
} else {
  console.log("Smart Collect VA : not created (may not be enabled on this test account)");
}
console.log(`\nPay it here to fire a real webhook:\n  ${out.razorpay?.shortUrl}`);
