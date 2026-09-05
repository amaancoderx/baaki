import type { Metadata } from "next";
import Link from "next/link";
import { Assistant } from "@/components/Assistant";
import "./globals.css";

export const metadata: Metadata = {
  title: "Baaki",
  description: "Ledger, memory and guarded outreach on top of Razorpay Invoices.",
};

/** Nav order follows the workflow: see the book, add to it, run it, audit it. */
const NAV = [
  { href: "/", label: "Invoices" },
  { href: "/new", label: "New invoice" },
  { href: "/run", label: "Run agent" },
  { href: "/audit", label: "Audit" },
  { href: "/demo", label: "Demo run" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <Link href="/" className="nav-brand">baaki<span>.</span></Link>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="nav-link">{n.label}</Link>
            ))}
            <div className="nav-right">
              <span className="chip chip-accent">
                <span className="dot pulse" style={{ background: "var(--accent-deep)" }} /> live
              </span>
            </div>
          </nav>
          <main style={{ flex: 1, paddingBlock: 32 }}>{children}</main>
          <Assistant />
        </div>
      </body>
    </html>
  );
}
