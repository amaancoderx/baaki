import type { Llm, JsonRequest, LlmUsage, ToolRequest, ToolTurn } from "./types.js";

/**
 * Deterministic stand-in. Tests and headless sim runs use this so nothing in
 * CI depends on a network, a quota, or a model's mood.
 */
export interface FakeOptions {
  /** Answer JSON requests by matching the prompt. First match wins. */
  json?: { match: RegExp; reply: unknown }[];
  /** Answer tool requests the same way. */
  tools?: { match: RegExp; reply: ToolTurn }[];
  fallbackJson?: unknown;
  fallbackTool?: ToolTurn;
}

export function fakeLlm(opts: FakeOptions = {}): Llm {
  const usage: LlmUsage = { requests: 0, promptTokens: 0, outputTokens: 0, cacheHits: 0, modelFallbacks: 0 };
  return {
    name: "fake",
    async json<T>(req: JsonRequest): Promise<T> {
      usage.requests += 1;
      const hit = opts.json?.find((r) => r.match.test(req.prompt));
      if (hit) return hit.reply as T;
      if (opts.fallbackJson !== undefined) return opts.fallbackJson as T;
      throw new Error(`fakeLlm: no json rule matched: ${req.prompt.slice(0, 80)}`);
    },
    async tools(req: ToolRequest): Promise<ToolTurn> {
      usage.requests += 1;
      const hit = opts.tools?.find((r) => r.match.test(req.prompt));
      if (hit) return hit.reply;
      if (opts.fallbackTool) return opts.fallbackTool;
      throw new Error(`fakeLlm: no tool rule matched: ${req.prompt.slice(0, 80)}`);
    },
    usage: () => ({ ...usage }),
  };
}
