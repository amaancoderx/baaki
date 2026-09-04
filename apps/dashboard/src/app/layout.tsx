import type { Metadata } from "next";
import Link from "next/link";
import { loadSnapshot } from "@/lib/data";
import { formatDate } from "@/lib/format";
import "./globals.css";

export const metadata: Metadata = {
  title: "Baaki",
  description: "Ledger, memory and guarded outreach on top of Razorpay Invoices.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const snap = loadSnapshot();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <Link href="/" className="nav-brand">baaki<span>.</span></Link>
            <Link href="/" className="nav-link active">Today</Link>
            <div className="nav-right">
              <span className="chip chip-neutral"><span className="dot pulse" style={{ background: "var(--accent)" }} /> sim · seed {snap.seed}</span>
              <span className="nav-date">Ledger as of {formatDate(snap.date)}</span>
            </div>
          </nav>
          <main style={{ flex: 1, paddingBlock: 32 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
