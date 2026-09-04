import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The merchant's buyer book. Synthetic by default so the app has something to
 * bill on first run, but a real contact can be added and is treated no
 * differently — a live WhatsApp number is just a contact whose `sendable` flag
 * is set because it has been registered as a test recipient with Meta.
 */
export interface Contact {
  id: string;
  name: string;
  /** E.164, no plus. Meta and Twilio both want it this way. */
  phone: string;
  email?: string;
  gstin?: string;
  city: string;
  /** Typical terms for this buyer, in days. Prefills the invoice form. */
  termDays: number;
  language: "en" | "hi" | "hinglish";
  /** True when this number can actually receive WhatsApp from the test number. */
  sendable: boolean;
  notes?: string;
}

const FIRMS: [string, string, number][] = [
  ["Sharma Traders", "Ludhiana", 30],
  ["Krishna Enterprises", "Surat", 45],
  ["Patel Textiles", "Ahmedabad", 60],
  ["Mehta & Sons", "Mumbai", 30],
  ["Annapurna Distributors", "Pune", 21],
  ["Verma Industries", "Kanpur", 45],
  ["Lakshmi Agencies", "Coimbatore", 30],
  ["Gupta Steel", "Raipur", 60],
  ["Rathi Polymers", "Vadodara", 45],
  ["Sundaram Fasteners Co", "Chennai", 30],
  ["Bhatia Electricals", "Delhi", 21],
  ["Naidu Packaging", "Hyderabad", 45],
  ["Iyer Chemicals", "Kochi", 30],
  ["Desai Marbles", "Udaipur", 60],
  ["Agarwal Paper Mart", "Jaipur", 30],
  ["Reddy Hardware", "Vijayawada", 21],
];

/** Deterministic, so the same contact list appears on every machine. */
export function syntheticContacts(): Contact[] {
  return FIRMS.map(([name, city, termDays], i) => ({
    id: `c_${String(i + 1).padStart(3, "0")}`,
    name,
    phone: `9199${String(100000 + i * 7919).slice(0, 6)}${String(i).padStart(2, "0")}`,
    email: `accounts@${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
    gstin: `${27 + (i % 9)}AAACB${String(1000 + i)}A1Z${i % 10}`,
    city,
    termDays,
    language: i % 3 === 0 ? "en" : "hinglish",
    sendable: false,
    notes: "Synthetic contact. WhatsApp will not deliver to this number.",
  }));
}

export interface ContactBook {
  contacts: Contact[];
}

export function loadContacts(path: string): Contact[] {
  if (!existsSync(path)) {
    const seeded: ContactBook = { contacts: syntheticContacts() };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(seeded, null, 2));
    return seeded.contacts;
  }
  return (JSON.parse(readFileSync(path, "utf8")) as ContactBook).contacts;
}

export function saveContacts(path: string, contacts: Contact[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ contacts }, null, 2));
}

export function upsertContact(path: string, c: Contact): Contact[] {
  const all = loadContacts(path);
  const i = all.findIndex((x) => x.id === c.id || x.phone === c.phone);
  if (i >= 0) all[i] = { ...all[i]!, ...c };
  else all.push(c);
  saveContacts(path, all);
  return all;
}
