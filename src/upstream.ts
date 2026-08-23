import { getPerchAuth } from "./auth.js";
import { classifyUpstreamError, isRetryableStatus } from "./errors.js";

export const MODEL_CALL_PATH = "/api/perch-terminal/model-call";

export function baseUrl(): string {
  return (
    process.env.PERCH_MODEL_CALL_PROXY_URL?.trim() ||
    "https://app.perchai.app"
  ).replace(/\/+$/, "");
}

export type PerchMessage = Record<string, unknown>;
export type PerchTool = { type: "function"; function: Record<string, unknown> };

export type PerchCallOptions = {
  messages: PerchMessage[];
  tools?: PerchTool[];
  toolChoice?: "auto" | "required" | "none";
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: unknown;
  manualModelOptionId?: string | null;
};

export type PerchEvent = Record<string, unknown> & { type: string };

function buildEnvelope(opts: PerchCallOptions): string {
  const {
    messages,
    tools,
    toolChoice,
    maxOutputTokens,
    temperature,
    responseFormat,
    manualModelOptionId,
  } = opts;
  return JSON.stringify({
    request: {
      lane: "chat",
      messages,
      tools: tools && tools.length ? tools : undefined,
      maxOutputTokens: maxOutputTokens ?? undefined,
      temperature: temperature ?? undefined,
      toolChoice,
      responseFormat,
      reasoning: null,
    },
    runId: crypto.randomUUID(),
    lane: "chat",
    strictManual: false,
    raceMode: null,
    preferredModelId: null,
    avoidModelIds: [],
    attribution: null,
    clientSurface: "cli",
    ...(manualModelOptionId
      ? { manualModelOptionId }
      : { manualModelOptionId: null }),
  });
}

const MAX_ATTEMPTS = Number(process.env.PERCH_PROXY_RETRIES?.trim() || "3");
const BACKOFF_BASE_MS = 350;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function backoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** attempt * (0.5 + Math.random());
}

async function doFetch(
  body: string,
  stream: boolean,
  token: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(stream ? { Accept: "text/event-stream" } : {}),
    "User-Agent": "perch-proxy/0.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl()}${MODEL_CALL_PATH}`, {
    method: "POST",
    headers,
    body,
    signal,
  });
}

async function fetchWithRetry(
  body: string,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  let auth = await getPerchAuth();
  let refreshedOnce = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(body, stream, auth.token, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= MAX_ATTEMPTS - 1) throw err;
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    if (res.status === 401) {
      if (!refreshedOnce) {
        refreshedOnce = true;
        auth = await getPerchAuth(true);
        if (!auth.token) {
          const err = classifyUpstreamError(401, '{"error":"Not signed in"}');
          Object.assign(err, {
            message:
              "No valid Perch session. Run `perch login` or set PERCH_TOKEN.",
          });
          throw Object.assign(new Error(err.message), err);
        }
        await res.body?.cancel().catch(() => {});
        continue;
      }
      await res.body?.cancel().catch(() => {});
      const text = await safeText(res);
      throw Object.assign(
        new Error("Perch session expired. Run `perch login`."),
        classifyUpstreamError(401, text),
      );
    }
    if (!isRetryableStatus(res.status) || attempt >= MAX_ATTEMPTS - 1) {
      return res;
    }
    await res.body?.cancel().catch(() => {});
    await sleep(backoffMs(attempt), signal);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function callNonStreaming(
  opts: PerchCallOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(buildEnvelope(opts), false, signal);
  const text = await safeText(res);
  if (!res.ok) throw Object.assign(new Error(text), classifyUpstreamError(res.status, text));
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { type: "done", ok: true, text, toolCalls: [], provider: "auto", model: "auto", durationMs: 0 };
  }
}

export async function* callStreaming(
  opts: PerchCallOptions,
  signal?: AbortSignal,
): AsyncGenerator<PerchEvent> {
  const res = await fetchWithRetry(buildEnvelope(opts), true, signal);
  if (!res.ok || !res.body) {
    const text = await safeText(res);
    yield {
      ...classifyUpstreamError(res.status, text),
      type: "__http_error",
    }
    return;
  }
  const reader = res.body.getReader();
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
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          yield JSON.parse(payload) as PerchEvent;
        } catch {}
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
