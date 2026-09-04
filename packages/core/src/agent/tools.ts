import type { ToolDeclaration } from "../llm/types.js";

/**
 * Six write tools and four read tools, exactly as plan §4.1 specifies.
 *
 * The one-write-action rule is enforced in the episode loop, not described to
 * the model and hoped for. A model that emits two writes has its first taken
 * and the rest dropped, and the drop is recorded.
 */

export const READ_TOOLS: ToolDeclaration[] = [
  {
    name: "get_invoice",
    description: "Amounts, dates, current state and substate, and whether the payment link is still live.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_buyer_history",
    description: "This buyer's memory: average days late, promise-kept rate, dispute rate, replies per touch, language, do-not-contact flag.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_touch_log",
    description: "Every message sent on this invoice and every reply received, oldest first.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "check_payment_status",
    description: "Ask the payment provider directly whether money has landed. Use when the ledger looks stale.",
    parameters: { type: "object", properties: {} },
  },
];

export const WRITE_TOOLS: ToolDeclaration[] = [
  {
    name: "send_nudge",
    description:
      "Send one message to the buyer. Guards decide whether it may actually go out: contact window, touch budget, minimum gap, promise or dispute in flight, do-not-contact, and a forbidden-phrase filter.",
    parameters: {
      type: "object",
      properties: {
        persona: {
          type: "string",
          enum: ["accounts", "owner"],
          description: "Who it comes from. 'owner' is a rung up the ladder and is not for routine chasing.",
        },
        message: {
          type: "string",
          description:
            "The message body, in the buyer's language. State only amounts and dates you were given. Never invent a figure. No legal or threatening language.",
        },
        reissue_link_first: {
          type: "boolean",
          description: "True when the payment link has expired. A nudge without a live link does nothing.",
        },
      },
      required: ["persona", "message"],
    },
  },
  {
    name: "reissue_payment_path",
    description: "Cancel the expired invoice or link and create a fresh payment link. Always pair with a nudge in the same tick.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "schedule_wait",
    description: "Do nothing until a date. The correct action when a promise is in flight or contact would be premature.",
    parameters: {
      type: "object",
      properties: {
        until: { type: "string", description: "ISO date YYYY-MM-DD." },
        reason: { type: "string" },
      },
      required: ["until", "reason"],
    },
  },
  {
    name: "open_dispute",
    description: "Record that the buyer is contesting the invoice. Freezes outreach and notifies the merchant. No agent argues a dispute.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "The buyer's stated reason, in their words." } },
      required: ["reason"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Hand the case to a person. Use when the ladder is spent, when the case needs authority you do not have, or when you are not confident.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "stop",
    description: "Close the campaign. Use when the invoice is settled or there is nothing further to pursue.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

export const ALL_TOOLS: ToolDeclaration[] = [...READ_TOOLS, ...WRITE_TOOLS];
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));
export const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.name));
