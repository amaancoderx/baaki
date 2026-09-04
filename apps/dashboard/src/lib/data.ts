import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./types";

let cached: Snapshot | null = null;

export function loadSnapshot(): Snapshot {
  if (cached) return cached;
  const p = join(process.cwd(), "data", "snapshot.json");
  cached = JSON.parse(readFileSync(p, "utf8")) as Snapshot;
  return cached;
}
