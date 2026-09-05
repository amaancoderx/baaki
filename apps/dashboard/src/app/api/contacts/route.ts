import { contacts, json, store } from "@/lib/server";
import type { Contact } from "@baaki/core";

export const dynamic = "force-dynamic";

export async function GET() {
  return json({ contacts: await contacts() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<Contact>;
  if (!body.name || !body.phone) return json({ error: "name and phone are required" }, 400);

  const all = await contacts();
  const contact: Contact = {
    id: body.id ?? `c_live_${Date.now().toString(36)}`,
    name: body.name,
    phone: body.phone.replace(/\D/g, ""),
    email: body.email,
    city: body.city ?? "—",
    termDays: body.termDays ?? 30,
    language: body.language ?? "hinglish",
    sendable: body.sendable ?? true,
    notes: body.notes ?? "Added from the dashboard.",
  };
  const i = all.findIndex((c) => c.id === contact.id || c.phone === contact.phone);
  if (i >= 0) all[i] = { ...all[i]!, ...contact }; else all.push(contact);
  await store().saveContacts(all);
  return json({ contacts: all, contact });
}
