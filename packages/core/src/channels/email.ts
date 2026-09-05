/**
 * Inbound email, reduced to the sentence the buyer actually typed.
 *
 * An email reply arrives wrapped in everything email wraps things in: the
 * quoted thread below an "On ... wrote:" line, forwarded headers, a signature.
 * The model should read what the buyer wrote today, not the whole history of
 * the correspondence, so everything from the first quote marker down is cut.
 */

const QUOTE_MARKERS = [
  /^On .{0,120}wrote:\s*$/m,          // Gmail, Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}/mi,
  /^From:\s.+$/m,                      // Outlook top-posting header block
  /^_{10,}\s*$/m,
  /^>{1}\s?/m,                         // first quoted line
];

export function extractReplyText(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");

  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);

  // Signatures: the conventional delimiter, then obvious sign-offs.
  const sig = text.indexOf("\n-- \n");
  if (sig >= 0) text = text.slice(0, sig);

  return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
}

/** "Sharma Traders <accounts@sharma.in>" -> "accounts@sharma.in" */
export function extractAddress(from: string): string {
  const angled = /<([^>]+)>/.exec(from);
  return (angled ? angled[1]! : from).trim().toLowerCase();
}
