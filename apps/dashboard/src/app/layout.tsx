import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Baaki",
  description: "Ledger, memory and guarded outreach on top of Razorpay Invoices.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <Link href="/" className="nav-brand">baaki<span>.</span></Link>
            <Link href="/" className="nav-link">Today</Link>
            <Link href="/new" className="nav-link">Naya invoice</Link>
            <Link href="/run" className="nav-link">Agent run</Link>
            <Link href="/audit" className="nav-link">Audit</Link>
            <div className="nav-right">
              <span className="chip chip-accent">
                <span className="dot pulse" style={{ background: "var(--accent-deep)" }} /> live
              </span>
            </div>
          </nav>
          <main style={{ flex: 1, paddingBlock: 32 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
