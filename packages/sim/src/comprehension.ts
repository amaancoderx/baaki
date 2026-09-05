import { addDays, type CivilDate, type ReplyIntent } from "@baaki/core";
import type { Rng } from "./rng.js";

/**
 * What the merchant *hears*, as opposed to what the buyer *said*.
 *
 * Without this the simulator hands the ledger the sampled truth, so every run
 * gives the policy perfect comprehension for free. That flatters the one
 * behaviour the product depends on most — believing a buyer and waiting — and
 * hides its most expensive failure: freezing outreach on a promise that was
 * never made, until a date the buyer never gave.
 *
 * The parameters are the merchant's parser, not the buyer's disposition, so
 * they apply uniformly across personas. Defaults are fitted to the observed
 * behaviour in evals/replies.md.
 */

export interface ComprehensionParams {
  /** Any intent read as some other intent. */
  pIntentFlip: number;
  /** A non-promise heard as a promise, with an invented date. */
  pFalsePromise: number;
  /** A real promise heard as something vaguer, so outreach is not frozen. */
  pMissedPromise: number;
  /** A promise heard, with the date wrong by a few days. */
  pDateError: number;
  /**
   * An opt-out heard as something else. The only route by which a real
   * do-not-contact violation can enter the system, so it is reported
   * separately rather than folded into an accuracy figure.
   */
  pMissedStop: number;
  /** Below this the parse is treated as unusable and the case goes to a human. */
  threshold: number;
}

/** Perfect comprehension: the behaviour before this module existed. */
export const PERFECT: ComprehensionParams = {
  pIntentFlip: 0, pFalsePromise: 0, pMissedPromise: 0,
  pDateError: 0, pMissedStop: 0, threshold: 0,
};

/**
 * Fitted to evals/replies.md: 87.5% intent accuracy over 40 author-written
 * cases, one false promise ("kal ya parso" read as a firm date), one missed
 * partial, no missed stops. Small denominators, so these are the right order of
 * magnitude rather than measured rates — which is why the sweep exists.
 */
export const OBSERVED: ComprehensionParams = {
  pIntentFlip: 0.075,
  pFalsePromise: 0.025,
  pMissedPromise: 0.05,
  pDateError: 0.05,
  pMissedStop: 0.0,
  threshold: 0,
};

const OTHER_INTENTS: ReplyIntent[] = ["will_pay", "promise", "dispute", "already_paid", "partial", "unclear"];

export interface TrueReply {
  intent: ReplyIntent;
  promiseDate?: CivilDate;
  disputeReason?: string;
}

export interface HeardReply {
  intent: ReplyIntent;
  promiseDate?: CivilDate;
  disputeReason?: string;
  confidence: number;
  /** True when what was heard differs from what was said. */
  misheard: boolean;
  kind: "correct" | "false_promise" | "missed_promise" | "date_error" | "intent_flip" | "missed_stop";
}

/**
 * One draw per reply, from a stream of its own so a change to the parser model
 * cannot shift the buyer's behaviour underneath it.
 */
export function hear(
  truth: TrueReply, p: ComprehensionParams, rng: Rng, today: CivilDate,
): HeardReply {
  const conf = (right: boolean) =>
    // Fitted to the observed 0.90 correct / 0.77 wrong split. Confidence is a
    // weak signal in practice: it separates the two populations, but not
    // cleanly enough to threshold without losing good parses too.
    right ? 0.78 + rng.float() * 0.20 : 0.55 + rng.float() * 0.35;

  // Opt-out first: getting this wrong is a compliance failure, not an accuracy
  // point, and it must not be reachable through the generic flip path.
  if (truth.intent === "stop") {
    if (rng.bool(p.pMissedStop)) {
      return { intent: "unclear", confidence: conf(false), misheard: true, kind: "missed_stop" };
    }
    return { intent: "stop", confidence: 1, misheard: false, kind: "correct" };
  }

  if (truth.intent === "promise") {
    if (rng.bool(p.pMissedPromise)) {
      return { intent: "will_pay", confidence: conf(false), misheard: true, kind: "missed_promise" };
    }
    if (rng.bool(p.pDateError)) {
      // Wrong by a few days in either direction, never zero.
      const shift = rng.int(1, 8) * (rng.bool(0.5) ? 1 : -1);
      const moved = addDays(truth.promiseDate ?? today, shift);
      return {
        intent: "promise",
        promiseDate: moved < today ? addDays(today, 1) : moved,
        confidence: conf(false), misheard: true, kind: "date_error",
      };
    }
    return { ...truth, confidence: conf(true), misheard: false, kind: "correct" };
  }

  // A promise that was never made. The expensive one: outreach freezes until a
  // date nobody committed to.
  if (rng.bool(p.pFalsePromise)) {
    return {
      intent: "promise",
      promiseDate: addDays(today, rng.int(2, 8)),
      confidence: conf(false), misheard: true, kind: "false_promise",
    };
  }

  if (rng.bool(p.pIntentFlip)) {
    const options = OTHER_INTENTS.filter((i) => i !== truth.intent && i !== "promise");
    return {
      intent: rng.pick(options), confidence: conf(false), misheard: true, kind: "intent_flip",
    };
  }

  return { ...truth, confidence: conf(true), misheard: false, kind: "correct" };
}
