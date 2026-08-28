import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyUpstreamError } from "./errors.js";
import type { OpenAiChatRequest } from "./translate.js";

// Command Code hosted lane ("subscription" models, e.g. minimax-m3-free).
// Protocol: docs/COMMANDCODE-PROTOCOL.md. NDJSON in/out, static Bearer key
// from ~/.commandcode/auth.json, Anthropic-style wire messages.

export const CC_GENERATE_PATH = "/alpha/generate";
export const CC_DEFAULT_MAX_TOKENS = 64_000;

export function ccBaseUrl(): string {
  return (
    process.env.COMMANDCODE_API_BASE_URL?.trim() || "https://api.commandcode.ai"
  ).replace(/\/+$/, "");
}

export type CcAuth = {
  apiKey: string;
  userId: string | null;
  userName: string | null;
  source: string;
};

let ccAuthCache: { auth: CcAuth | null; checkedAt: number } | null = null;
const CC_AUTH_CACHE_MS = 2_000;

export async function getCcAuth(force = false): Promise<CcAuth | null> {
  const envKey = process.env.COMMANDCODE_API_KEY?.trim();
  if (envKey) return { apiKey: envKey, userId: null, userName: null, source: "env" };
  if (
    !force &&
    ccAuthCache &&
    Date.now() - ccAuthCache.checkedAt < CC_AUTH_CACHE_MS
  ) {
    return ccAuthCache.auth;
  }
  const dir =
    process.env.COMMANDCODE_AUTH_DIR?.trim() ||
    join(homedir(), ".commandcode");
  let auth: CcAuth | null = null;
  try {
    const raw = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as {
      apiKey?: unknown;
      userId?: unknown;
      userName?: unknown;
    };
    if (typeof raw.apiKey === "string" && raw.apiKey) {
      auth = {
        apiKey: raw.apiKey,
        userId: typeof raw.userId === "string" ? raw.userId : null,
        userName: typeof raw.userName === "string" ? raw.userName : null,
        source: dir,
      };
    }
  } catch {
    auth = null;
  }
  ccAuthCache = { auth, checkedAt: Date.now() };
  return auth;
}

export async function hasCcAuth(): Promise<boolean> {
  return (await getCcAuth()) !== null;
}

// ---- OpenAI -> Command Code wire translation -------------------------------

export type CcBlock = Record<string, unknown>;
export type CcMessage = { role: "user" | "assistant"; content: CcBlock[] };
export type CcTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type CcCallOptions = {
  model: string;
  system: string | null;
  messages: CcMessage[];
  tools: CcTool[] | null;
  maxOutputTokens: number | null;
  temperature: number | null;
};

function textBlock(text: string): CcBlock {
  return { type: "text", text };
}

function parseToolInput(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

export function toCcMessages(messages: unknown[]): {
  system: string | null;
  messages: CcMessage[];
} {
  const systemParts: string[] = [];
  const out: CcMessage[] = [];
  for (const m of messages) {
    const msg = m as {
      role?: unknown;
      content?: unknown;
      tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
      tool_call_id?: unknown;
    };
    if (typeof msg.role !== "string") continue;
    if (msg.role === "system" || msg.role === "developer") {
      const t = typeof msg.content === "string" ? msg.content : "";
      if (t) systemParts.push(t);
      continue;
    }
    if (msg.role === "tool") {
      const t = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(msg.tool_call_id ?? ""),
            content: [textBlock(t)],
          },
        ],
      });
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const blocks: CcBlock[] = [];
    if (typeof msg.content === "string" && msg.content) {
      blocks.push(textBlock(msg.content));
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const p = part as { type?: unknown; text?: unknown };
        if (p && p.type === "text" && typeof p.text === "string" && p.text) {
          blocks.push(textBlock(p.text));
        }
        // image and other part types are not supported on this lane (v1).
      }
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || typeof tc !== "object" || !tc.function) continue;
        blocks.push({
          type: "tool_use",
          id: String(tc.id ?? ""),
          name: String(tc.function.name ?? ""),
          input: parseToolInput(
            typeof tc.function.arguments === "string" ? tc.function.arguments : "",
          ),
        });
      }
    }
    if (blocks.length) out.push({ role: msg.role, content: blocks });
  }
  return { system: systemParts.join("\n\n") || null, messages: out };
}

export function toCcTools(tools: unknown): CcTool[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out: CcTool[] = [];
  for (const t of tools) {
    const fn = (t as { function?: Record<string, unknown> })?.function;
    if (!fn || typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema:
        (fn.parameters as Record<string, unknown> | undefined) ?? { type: "object" },
    });
  }
  return out.length ? out : null;
}

export function toCcOptions(req: OpenAiChatRequest, model: string): CcCallOptions {
  const { system, messages } = toCcMessages(req.messages);
  return {
    model,
    system,
    messages,
    tools: toCcTools(req.tools),
    maxOutputTokens: req.max_completion_tokens ?? req.max_tokens ?? null,
    temperature: req.temperature ?? null,
  };
}

export function buildCcBody(opts: CcCallOptions): string {
  return JSON.stringify({
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: "proxy",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: null,
    skills: null,
    permissionMode: "default",
    threadId: crypto.randomUUID(),
    mode: "agent",
    params: {
      model: opts.model,
      messages: opts.messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      max_tokens: opts.maxOutputTokens ?? CC_DEFAULT_MAX_TOKENS,
      stream: true,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    },
  });
}

// ---- Event normalization (same shapes the Perch upstream emits) ------------

export type CcEvent = Record<string, unknown> & { type: string };

type FlatCall = { id: string; name: string; arguments: string };

function normalizeCcToolCall(raw: unknown): FlatCall | null {
  if (!raw || typeof raw !== "object") return null;
  const tc = raw as {
    toolCallId?: unknown;
    toolName?: unknown;
    input?: unknown;
    args?: unknown;
  };
  const name = typeof tc.toolName === "string" ? tc.toolName : "";
  if (!name) return null;
  const input = tc.input ?? tc.args;
  const args =
    typeof input === "string" ? input : JSON.stringify(input ?? {});
  return {
    id: typeof tc.toolCallId === "string" && tc.toolCallId
      ? tc.toolCallId
      : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    name,
    arguments: args,
  };
}

function usageFromFinish(totalUsage: unknown): Record<string, number> | null {
  if (!totalUsage || typeof totalUsage !== "object") return null;
  const u = totalUsage as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    inputTokenDetails?: { cacheReadTokens?: unknown; cacheWriteTokens?: unknown };
  };
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const pt = num(u.inputTokens);
  const ct = num(u.outputTokens);
  return { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
}

async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as Record<string, unknown>;
        } catch {}
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchCc(
  opts: CcCallOptions,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${ccBaseUrl()}${CC_GENERATE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-cli-environment": "prod",
      "x-command-code-version": "1.36.0",
      "User-Agent": "cli",
    },
    body: buildCcBody(opts),
    signal,
  });
}

export async function* callStreamingCc(
  opts: CcCallOptions,
  signal?: AbortSignal,
): AsyncGenerator<CcEvent> {
  const auth = await getCcAuth();
  if (!auth) {
    yield {
      ...classifyUpstreamError(
        401,
        "No Command Code key. Run `cmdc login` or set COMMANDCODE_API_KEY.",
      ),
      type: "__http_error",
    };
    return;
  }
  let res: Response;
  try {
    res = await fetchCc(opts, auth.apiKey, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw err;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    yield { ...classifyUpstreamError(res.status, text), type: "__http_error" };
    return;
  }

  let text = "";
  const calls: FlatCall[] = [];
  let usage: Record<string, number> | null = null;
  let finished = false;
  for await (const ev of parseNdjson(res.body)) {
    const type = ev.type;
    if (type === "text-delta") {
      const t = typeof ev.text === "string" ? ev.text : "";
      if (t) {
        text += t;
        yield { type: "answer_delta", text: t };
      }
    } else if (type === "reasoning-delta") {
      const t = typeof ev.text === "string" ? ev.text : "";
      if (t) yield { type: "reasoning_delta", text: t };
    } else if (type === "tool-call") {
      const call = normalizeCcToolCall(ev);
      if (call) {
        calls.push(call);
        yield { type: "tool_use_end", toolCalls: [call] };
      }
    } else if (type === "finish") {
      finished = true;
      usage = usageFromFinish(ev.totalUsage);
      yield {
        type: "done",
        ok: true,
        text,
        toolCalls: calls,
        provider: "command-code",
        model: opts.model,
        durationMs: 0,
        ...(usage ? { usage } : {}),
      };
      return;
    } else if (type === "error") {
      const e = (ev.error ?? {}) as {
        message?: unknown;
        statusCode?: unknown;
      };
      const status =
        typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600
          ? e.statusCode
          : 502;
      const message =
        typeof e.message === "string" && e.message
          ? e.message
          : "Command Code stream error";
      yield {
        ...classifyUpstreamError(status, JSON.stringify({ error: message })),
        type: "error",
      };
      return;
    }
    // start / reasoning-start / reasoning-end / abort / tool-result: ignored
  }
  if (!finished) {
    yield {
      ...classifyUpstreamError(
        502,
        "Command Code stream ended before finish event",
      ),
      type: "error",
    };
  }
}

export async function callNonStreamingCc(
  opts: CcCallOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let done: Record<string, unknown> | null = null;
  let lastError: CcEvent | null = null;
  for await (const ev of callStreamingCc(opts, signal)) {
    if (ev.type === "done") {
      done = ev;
      break;
    }
    if (ev.type === "__http_error" || ev.type === "error") {
      lastError = ev;
      break;
    }
  }
  if (done) return done;
  const e = lastError as (Error & { status?: number }) | null;
  throw Object.assign(
    new Error(e?.message ?? "Command Code call failed"),
    e ?? {},
  );
}
