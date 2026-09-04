import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LlmError, type JsonRequest, type Llm, type LlmUsage, type ToolCall,
  type ToolRequest, type ToolTurn,
} from "./types.js";

export interface GeminiOptions {
  apiKey: string;
  /**
   * Default is gemini-3.5-flash on the v1 endpoint. Plan §16.1 names
   * gemini-2.5-flash; that model now returns 404 for new API projects, and the
   * v1beta endpoint 404s for the 3.x line. Both were verified against this key.
   */
  model?: string;
  apiVersion?: "v1" | "v1beta";
  /** Disk cache directory. Set to null to disable caching entirely. */
  cacheDir?: string | null;
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Client-side pacing. Free-tier projects are capped per model per minute as
   * well as per day, and firing an eval loop flat out burns the budget on 429s
   * that never produced an answer.
   */
  minIntervalMs?: number;
  /**
   * Model names to fall through to when the current one is out of daily quota.
   * Each model has its own bucket, so a second name doubles a free-tier day.
   */
  fallbackModels?: string[];
}

const DEFAULT_MODEL = "gemini-3.5-flash";

/** Gemini's schema dialect wants uppercase type names. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "type" && typeof v === "string") out[k] = v.toUpperCase();
    else out[k] = toGeminiSchema(v);
  }
  return out;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

export function gemini(opts: GeminiOptions): Llm {
  const model = opts.model ?? DEFAULT_MODEL;
  const version = opts.apiVersion ?? "v1";
  const cacheDir = opts.cacheDir === null ? null : (opts.cacheDir ?? ".llm-cache");
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const minIntervalMs = opts.minIntervalMs ?? 1_500;
  const chain = [model, ...(opts.fallbackModels ?? [])];

  let lastCallAt = 0;
  /** Models known to be out of daily quota this process. Skipped, not retried. */
  const exhausted = new Set<string>();

  async function pace(): Promise<void> {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  }

  /** A per-day cap will not clear by waiting a few seconds; do not burn retries on it. */
  function isDailyExhaustion(body: string): boolean {
    return /PerDay|per day|free_tier_requests/i.test(body);
  }

  function retryDelayMs(body: string): number | null {
    const structured = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
    if (structured) return Math.ceil(Number(structured[1]) * 1000) + 500;
    const prose = /retry in ([\d.]+)s/i.exec(body);
    if (prose) return Math.ceil(Number(prose[1]) * 1000) + 500;
    return null;
  }

  const usage: LlmUsage = { requests: 0, promptTokens: 0, outputTokens: 0, cacheHits: 0, modelFallbacks: 0 };

  if (cacheDir && !existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

  const cachePath = (key: string) => join(cacheDir!, `${sha(key)}.json`);

  function readCache(key: string): unknown | null {
    if (!cacheDir) return null;
    const p = cachePath(key);
    if (!existsSync(p)) return null;
    usage.cacheHits += 1;
    return JSON.parse(readFileSync(p, "utf8"));
  }

  function writeCache(key: string, value: unknown): void {
    if (!cacheDir) return;
    writeFileSync(cachePath(key), JSON.stringify(value, null, 2));
  }

  async function callModel(
    modelName: string, body: unknown, cacheKey: string,
  ): Promise<Record<string, unknown>> {
    const url = `https://generativelanguage.googleapis.com/${version}/models/${modelName}:generateContent`;
    let lastErr: LlmError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await pace();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "x-goog-api-key": opts.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (res.status === 429 || res.status >= 500) {
          const text = await res.text();
          if (res.status === 429 && isDailyExhaustion(text)) {
            // Waiting will not help before the quota resets at midnight PT.
            exhausted.add(modelName);
            throw new LlmError(
              `daily quota exhausted for ${modelName}. Free-tier caps reset at midnight Pacific. ` +
              `Add fallbackModels, enable billing, or use a key from https://aistudio.google.com/apikey`,
              429, false,
            );
          }
          const waitMs = retryDelayMs(text)
            ?? Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 400), 32_000);
          lastErr = new LlmError(`${res.status}: ${text.slice(0, 200)}`, res.status, true);
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw lastErr;
        }

        if (res.status === 403) {
          throw new LlmError(
            `403 for ${modelName}: the project behind this API key is denied access to ` +
            `generateContent. Create a key at https://aistudio.google.com/apikey ` +
            `(standard keys begin with "AIza").`,
            403, false,
          );
        }

        if (!res.ok) {
          throw new LlmError(`${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, false);
        }

        const json = (await res.json()) as Record<string, unknown>;
        usage.requests += 1;
        const um = json.usageMetadata as Record<string, number> | undefined;
        if (um) {
          usage.promptTokens += um.promptTokenCount ?? 0;
          usage.outputTokens += um.candidatesTokenCount ?? 0;
        }
        writeCache(cacheKey, json);
        return json;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof LlmError && !e.retryable) throw e;
        lastErr = e instanceof LlmError ? e : new LlmError(String(e), undefined, true);
        if (attempt >= maxRetries) throw lastErr;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }
    throw lastErr ?? new LlmError("exhausted retries");
  }

  /**
   * Cache first, then each model in the chain. A model that reported a daily
   * cap is skipped for the rest of the process rather than retried per call.
   */
  async function call(body: unknown, cacheKey: string): Promise<Record<string, unknown>> {
    const cached = readCache(cacheKey);
    if (cached) return cached as Record<string, unknown>;

    let lastErr: unknown = null;
    for (const m of chain) {
      if (exhausted.has(m)) continue;
      try {
        return await callModel(m, body, cacheKey);
      } catch (e) {
        lastErr = e;
        const quotaOut = e instanceof LlmError && e.status === 429;
        if (!quotaOut) throw e;
        usage.modelFallbacks += 1;
      }
    }
    throw lastErr ?? new LlmError(`every model exhausted: ${chain.join(", ")}`);
  }

  /** Thinking models emit thought parts; only text parts are the answer. */
  function textOf(json: Record<string, unknown>): string {
    const cands = json.candidates as { content?: { parts?: Record<string, unknown>[] } }[] | undefined;
    const parts = cands?.[0]?.content?.parts ?? [];
    return parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("");
  }

  function callsOf(json: Record<string, unknown>): ToolCall[] {
    const cands = json.candidates as { content?: { parts?: Record<string, unknown>[] } }[] | undefined;
    const parts = cands?.[0]?.content?.parts ?? [];
    return parts
      .filter((p) => p.functionCall)
      .map((p) => {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        return { name: fc.name, args: fc.args ?? {} };
      });
  }

  return {
    name: `gemini:${model}`,

    async json<T>(req: JsonRequest): Promise<T> {
      const body = {
        ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents: [{ parts: [{ text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature ?? 0,
          maxOutputTokens: req.maxOutputTokens ?? 2048,
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(req.schema),
        },
      };
      const key = req.cacheKey ?? JSON.stringify(body);
      const json = await call(body, key);
      const text = textOf(json);
      if (!text.trim()) {
        const fr = (json.candidates as { finishReason?: string }[] | undefined)?.[0]?.finishReason;
        throw new LlmError(`empty response (finishReason: ${fr ?? "unknown"})`);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new LlmError(`model returned non-JSON: ${text.slice(0, 200)}`);
      }
    },

    async tools(req: ToolRequest): Promise<ToolTurn> {
      const contents: Record<string, unknown>[] = [{ role: "user", parts: [{ text: req.prompt }] }];
      for (const h of req.history ?? []) {
        contents.push({ role: "model", parts: [{ functionCall: { name: h.call.name, args: h.call.args } }] });
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name: h.call.name, response: { result: h.result } } }],
        });
      }
      const body = {
        ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents,
        tools: [{
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.parameters),
          })),
        }],
        generationConfig: {
          temperature: req.temperature ?? 0,
          maxOutputTokens: req.maxOutputTokens ?? 2048,
        },
      };
      const key = req.cacheKey ?? JSON.stringify(body);
      const json = await call(body, key);
      return { calls: callsOf(json), text: textOf(json) };
    },

    usage: () => ({ ...usage }),
  };
}
