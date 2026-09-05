/**
 * What world a number came from.
 *
 * The simulator changed under the reports more than once: adding a human who
 * works the escalation queue moved the treated arm by ten points, and a
 * generated file written before that change describes a different world from
 * one written after. A panelist who reads two tables and gets two worlds stops
 * trusting both.
 *
 * Bump this whenever a change alters what a run produces. Every generated file
 * stamps it, so two files that disagree can be told apart from two files that
 * describe the same run.
 */
export const SIM_VERSION = "s4";

export const SIM_CHANGELOG: { version: string; change: string }[] = [
  { version: "s1", change: "Initial: personas, hazards, holdout, seeded arms." },
  { version: "s2", change: "Per-buyer RNG streams; the comparison became paired." },
  { version: "s3", change: "A broken promise stopped guaranteeing payment." },
  { version: "s4", change: "A person works the escalation queue; comprehension can be imperfect." },
];

/** One line for the top of every generated report. */
export function stamp(): string {
  const latest = SIM_CHANGELOG[SIM_CHANGELOG.length - 1]!;
  return `Simulator \`${SIM_VERSION}\`: ${latest.change}`;
}
