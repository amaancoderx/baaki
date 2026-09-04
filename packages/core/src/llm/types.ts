/**
 * The model boundary. Everything that talks to an LLM goes through this, so
 * evals can run against a fake and the sim can run headless without a network.
 */

export interface JsonRequest {
  system?: string;
  prompt: string;
  /** JSON Schema in Gemini's OpenAPI dialect (types uppercased). */
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Stable key for the response cache. Same key, same answer, no second call. */
  cacheKey?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /**
   * The provider's original part, replayed verbatim when this call is fed back
   * as history. Gemini 3.x rejects a functionCall that comes back without the
   * thoughtSignature it was issued with, so a reconstructed {name, args} is not
   * good enough. Opaque on purpose: nothing outside the adapter reads it.
   */
  raw?: unknown;
}

export interface ToolTurn {
  /** Model's tool calls this turn. Empty when it chose to answer in text. */
  calls: ToolCall[];
  text: string;
}

export interface ToolRequest {
  system?: string;
  prompt: string;
  tools: ToolDeclaration[];
  /** Prior turns: each tool call and the result fed back. */
  history?: { call: ToolCall; result: unknown }[];
  temperature?: number;
  maxOutputTokens?: number;
  cacheKey?: string;
}

export interface LlmUsage {
  requests: number;
  promptTokens: number;
  outputTokens: number;
  cacheHits: number;
  /** Times a model was out of daily quota and the next in the chain was used. */
  modelFallbacks: number;
}

export interface Llm {
  readonly name: string;
  json<T>(req: JsonRequest): Promise<T>;
  tools(req: ToolRequest): Promise<ToolTurn>;
  usage(): LlmUsage;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = "LlmError";
  }
}
