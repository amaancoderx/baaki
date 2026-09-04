import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface OverContact {
  window_days: number;
  max_touches: number;
  hazard_penalty: number;
  complaint_prob: number;
  dnc_prob: number;
}

export interface Persona {
  weight: number;
  label: string;
  pay_hazard_by_day: number[];
  pre_due_hazard: number;
  post_dispute_hazard?: number;
  post_partial_hazard_scale?: number;
  touch_lift: { whatsapp: number; email: number; owner_persona: number };
  reply_prob: { whatsapp: number; email: number };
  promise_prob_given_reply: number;
  promise_keep_prob: number;
  promise_slip_days: { mean: number; sd: number };
  dispute_prob_first_touch: number;
  partial_first_fraction: number;
  over_contact: OverContact;
  holiday_touch_penalty: number;
  dead_link_touch_effect: number;
  hour_effect: { best: [number, number]; multiplier_off_peak: number };
}

export interface PersonaFile {
  meta: {
    dispute_resolution_days: number;
    touch_lift_days: number;
    reply_delay_days: number[];
  };
  personas: Record<string, Persona>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

let cached: PersonaFile | null = null;

export function loadPersonas(path = join(HERE, "personas.yaml")): PersonaFile {
  if (cached && path === join(HERE, "personas.yaml")) return cached;
  const f = parse(readFileSync(path, "utf8")) as PersonaFile;
  const total = Object.values(f.personas).reduce((s, p) => s + p.weight, 0);
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`persona weights sum to ${total}, expected 1`);
  }
  if (path === join(HERE, "personas.yaml")) cached = f;
  return f;
}

/** Overdue bucket index for pay_hazard_by_day: [0-7, 8-14, 15-30, 31-60, 61+]. */
export function hazardBucket(daysOverdue: number): number {
  if (daysOverdue <= 7) return 0;
  if (daysOverdue <= 14) return 1;
  if (daysOverdue <= 30) return 2;
  if (daysOverdue <= 60) return 3;
  return 4;
}
