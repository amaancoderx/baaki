import type { Action, Decision } from "./types.js";

export interface GuardResult {
  name: string;
  pass: boolean;
  /** Present on failure. Fed back to the agent verbatim on its one retry. */
  detail?: string;
}

export interface AuditEntry {
  id: string;
  ts: number;
  invoiceId: string;
  actor: Decision["actor"];
  action: Action["kind"];
  params: Record<string, unknown>;
  rationale: string;
  guards: GuardResult[];
  policyVersion: string;
  /** Webhook ids, message ids, reply ids. Every entry carries at least one. */
  evidence: string[];
}

/**
 * Append-only. Nothing in this class mutates or removes an entry; the export
 * is the artefact a panel reads, so a rewrite path would defeat the point.
 */
export class AuditLog {
  #entries: AuditEntry[] = [];
  #seq = 0;

  append(e: Omit<AuditEntry, "id">): AuditEntry {
    if (!e.rationale || !e.rationale.trim()) {
      throw new Error(`audit entry for ${e.invoiceId} has no rationale`);
    }
    if (e.evidence.length === 0) {
      throw new Error(`audit entry for ${e.invoiceId} has no evidence link`);
    }
    const entry: AuditEntry = { id: `a_${++this.#seq}`, ...e };
    this.#entries.push(entry);
    return entry;
  }

  all(): readonly AuditEntry[] {
    return this.#entries;
  }

  forInvoice(invoiceId: string): AuditEntry[] {
    return this.#entries.filter((e) => e.invoiceId === invoiceId);
  }

  export(format: "json"): string;
  export(format: "csv"): string;
  export(format: "json" | "csv" = "json"): string {
    if (format === "json") return JSON.stringify(this.#entries, null, 2);

    const cols = [
      "id", "ts", "invoiceId", "actor", "action",
      "rationale", "guards", "policyVersion", "evidence", "params",
    ];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = this.#entries.map((e) =>
      [
        e.id,
        new Date(e.ts).toISOString(),
        e.invoiceId,
        e.actor,
        e.action,
        e.rationale,
        e.guards.map((g) => `${g.name}:${g.pass ? "pass" : "FAIL"}`).join(" "),
        e.policyVersion,
        e.evidence.join(" "),
        JSON.stringify(e.params),
      ].map((c) => esc(String(c))).join(","),
    );
    return [cols.join(","), ...rows].join("\n");
  }
}
