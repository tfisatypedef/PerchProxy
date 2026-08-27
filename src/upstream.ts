import { getPerchAuth } from "./auth.js";
import { classifyUpstreamError, isRetryableStatus } from "./errors.js";

export const MODEL_CALL_PATH = "/api/perch-terminal/model-call";

export function baseUrl(): string {
  return (
    process.env.PERCH_MODEL_CALL_PROXY_URL?.trim() ||
    "https://app.perchai.app"
  ).replace(/\/+$/, "");
}

// Perch now requires official clients to first obtain a short-lived "turn
// ticket" from /api/perch-terminal/turn-ticket and send it as the
// `x-perch-turn-ticket` header on every /model-call request. Without it the
// backend rejects the call as direct API access (error code
// `perch_surface_required`). Mirror the CLI: fetch one ticket per turn,
// cache it, and only renew shortly before it expires. This also avoids
// hammering the ticket endpoint (which is itself turn-rate-limited).

export type TurnTicket = {
  token: string;
  ticketId: string;
  runId: string;
  expiresAt: number;
};

const TICKET_RENEW_WINDOW_MS = 30_000;
const TICKET_DEFAULT_TTL_MS = 5 * 60_000;

const turnTicketCache: {
  ticket: TurnTicket | null;
  accessToken: string | null;
  renewing: Promise<TurnTicket | null> | null;
} = { ticket: null, accessToken: null, renewing: null };

function parseTicketExpiry(value: unknown): number {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return Date.parse(value);
  }
  return Date.now() + TICKET_DEFAULT_TTL_MS;
}

async function fetchTurnTicket(accessToken: string): Promise<TurnTicket | null> {
  const res = await fetch(`${baseUrl()}/api/perch-terminal/turn-ticket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      "User-Agent": "perch-proxy/0.1",
    },
    body: JSON.stringify({ surface: "cli", profile: "standard" }),
  });
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as Record<string, unknown>;
    if (
      data.ok !== true ||
      typeof data.ticket !== "string" ||
      typeof data.ticketId !== "string" ||
      typeof data.runId !== "string"
    ) {
      return null;
    }
    return {
      token: data.ticket,
      ticketId: data.ticketId,
      runId: data.runId,
      expiresAt: parseTicketExpiry(data.expiresAt),
    };
  } catch {
    return null;
  }
}

async function getTurnTicket(
  accessToken: string | null,
  force = false,
): Promise<TurnTicket | null> {
  if (!accessToken) return null;
  const now = Date.now();
  if (
    !force &&
    turnTicketCache.ticket &&
    turnTicketCache.accessToken === accessToken &&
    turnTicketCache.ticket.expiresAt > now + TICKET_RENEW_WINDOW_MS
  ) {
    return turnTicketCache.ticket;
  }
  if (!turnTicketCache.renewing) {
    turnTicketCache.renewing = (async () => {
      const t = await fetchTurnTicket(accessToken);
      if (t) {
        turnTicketCache.ticket = t;
        turnTicketCache.accessToken = accessToken;
      }
      return t;
    })().finally(() => {
      turnTicketCache.renewing = null;
    });
  }
  const fresh = await turnTicketCache.renewing;
  // Fall back to the cached ticket if renewal failed and it is still valid.
  return (
    fresh ??
    (turnTicketCache.accessToken === accessToken &&
    turnTicketCache.ticket &&
    turnTicketCache.ticket.expiresAt > now
      ? turnTicketCache.ticket
      : null)
  );
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

function buildEnvelope(opts: PerchCallOptions, runId?: string | null): string {
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
    runId: runId ?? crypto.randomUUID(),
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
  turnTicket: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(stream ? { Accept: "text/event-stream" } : {}),
    "User-Agent": "perch-proxy/0.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (turnTicket) headers["x-perch-turn-ticket"] = turnTicket;
  return fetch(`${baseUrl()}${MODEL_CALL_PATH}`, {
    method: "POST",
    headers,
    body,
    signal,
  });
}

async function fetchWithRetry(
  opts: PerchCallOptions,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  let auth = await getPerchAuth();
  let ticket = await getTurnTicket(auth.token);
  let refreshedOnce = false;
  for (let attempt = 0; ; attempt++) {
    const body = buildEnvelope(opts, ticket?.runId ?? null);
    let res: Response;
    try {
      res = await doFetch(body, stream, auth.token, ticket?.token ?? null, signal);
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
        // The access token rotated; fetch a fresh turn ticket bound to it.
        ticket = await getTurnTicket(auth.token, true);
        await res.body?.cancel().catch(() => { });
        continue;
      }
      await res.body?.cancel().catch(() => { });
      const text = await safeText(res);
      throw Object.assign(
        new Error("Perch session expired. Run `perch login`."),
        classifyUpstreamError(401, text),
      );
    }
    if (!isRetryableStatus(res.status) || attempt >= MAX_ATTEMPTS - 1) {
      return res;
    }
    await res.body?.cancel().catch(() => { });
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
  const res = await fetchWithRetry(opts, false, signal);
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
  const res = await fetchWithRetry(opts, true, signal);
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
    for (; ;) {
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
        } catch { }
      }
    }
  } finally {
    await reader.cancel().catch(() => { });
    reader.releaseLock();
  }
}
