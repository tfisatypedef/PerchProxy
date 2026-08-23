import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getPerchAuth } from "./auth.js";
import { openAiErrorBody } from "./errors.js";
import { rateLimitHeaders, take } from "./ratelimit.js";
import {
  fromDoneEvent,
  toPerchOptions,
  type OpenAiChatRequest,
} from "./translate.js";
import { callNonStreaming, callStreaming } from "./upstream.js";

const PORT = Number(process.env.PERCH_PROXY_PORT?.trim() || "8787");
const LOCAL_KEY = process.env.PERCH_PROXY_API_KEY?.trim() || "";

const MODEL_LIST: Record<string, string> = {
  auto: "Roost automatic routing",
  "qwen-3.6": "Qwen 3.6",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "kimi-k2.5": "Kimi K2.5",
  "glm-5": "GLM 5",
  "qwen3-coder": "Qwen3 Coder",
  "nemotron-super": "Nemotron Super",
  "minimax-m2": "MiniMax M2",
  "gemma-4-e2b": "Gemma 4 E2B",
  "gemma-4-31b": "Gemma 4 31B",
  "glm-5.2": "GLM 5.2 (Pro)",
  "deepseek-v4-pro": "DeepSeek V4 Pro (Pro)",
  "kimi-k2.6": "Kimi K2.6 (Pro)",
  "kimi-k2.7-code": "Kimi K2.7 Code (Pro)",
  "minimax-m3": "MiniMax M3 (Pro)",
  "nemotron-ultra": "Nemotron Ultra (Pro)",
  "nemotron-3.5-lightning": "Nemotron 3.5 Lightning (Pro)",
  "grok-4.3": "Grok 4.3 (Pro)",
  "qwen-3.7-plus": "Qwen 3.7 Plus (Pro)",
  "qwen-3.8-27b": "Qwen 3.8 27B (Pro)",
  "deepseek-v4-flash-0731": "DeepSeek V4 Flash 0731 (Pro)",
  inkling: "Inkling (Pro)",
};

const app = new Hono();

app.use("*", async (c, next) => {
  if (!LOCAL_KEY) return next();
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${LOCAL_KEY}`) {
    return c.json(
      {
        error: {
          message: "Invalid proxy API key",
          type: "authentication_error",
          code: null,
        },
      },
      401,
    );
  }
  await next();
});

app.get("/healthz", (c) => c.json({ status: "ok" }));

app.get("/readyz", async (c) => {
  const auth = await getPerchAuth();
  if (auth.token) return c.json({ status: "ready", source: auth.source });
  return c.json(
    {
      status: "not_ready",
      reason: `No Perch session (${auth.source}). Run \`perch login\` or set PERCH_TOKEN.`,
    },
    503,
  );
});

app.get("/v1/models", async (c) => {
  const auth = await getPerchAuth();
  if (!auth.token) {
    return c.json(
      {
        error: {
          message: "No Perch session. Run `perch login`.",
          type: "authentication_error",
          code: null,
        },
      },
      401,
    );
  }
  return c.json({
    object: "list",
    data: Object.entries(MODEL_LIST).map(([id, label]) => ({
      id,
      object: "model",
      created: 0,
      owned_by: id === "auto" ? "perch-roost" : "perch",
      meta: { description: label },
    })),
  });
});

async function requireSession(): Promise<Error | null> {
  const auth = await getPerchAuth();
  return auth.token
    ? null
    : new Error(
        "No Perch session. Run `perch login`, or set PERCH_TOKEN.",
      );
}

app.post("/v1/chat/completions", async (c) => {
  const sessionErr = await requireSession();
  if (sessionErr) {
    return c.json(openAiErrorBody(sessionErr), 401);
  }

  let req: OpenAiChatRequest;
  try {
    req = (await c.req.json()) as OpenAiChatRequest;
  } catch {
    return c.json(
      openAiErrorBody(new Error("Invalid JSON body")),
      400,
    );
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return c.json(
      openAiErrorBody(new Error("`messages` must be a non-empty array")),
      400,
    );
  }

  const perchOpts = toPerchOptions(req);
  const bucket = take("global");
  const modelId = req.model ?? "auto";

  if (!req.stream) {
    try {
      const done = await callNonStreaming(perchOpts, c.req.raw.signal);
      const result = fromDoneEvent(done);
      const message: Record<string, unknown> = {
        role: "assistant",
        content: result.text || null,
      };
      if (result.toolCalls.length) message.tool_calls = result.toolCalls;
      const payload = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        perch_served: { provider: result.provider, model: result.model },
        choices: [
          {
            index: 0,
            message,
            finish_reason: result.toolCalls.length ? "tool_calls" : "stop",
          },
        ],
        usage:
          result.usage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
      };
      const res = c.json(payload, 200);
      for (const [k, v] of Object.entries(rateLimitHeaders(bucket, false))) {
        res.headers.set(k, v);
      }
      return res;
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = (
        e.status && e.status >= 400 && e.status < 600 ? e.status : 502
      ) as ContentfulStatusCode;
      return c.json(openAiErrorBody(err as Error), status);
    }
  }

  return streamSSE(c, async (sse) => {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunkBase = { id, object: "chat.completion.chunk", created, model: modelId };

    const sendChunk = (delta: Record<string, unknown>, finish?: string) =>
      sse.writeSSE({
        data: JSON.stringify({
          ...chunkBase,
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        }),
      });

    try {
      await sendChunk({ role: "assistant" });
      let usage: Record<string, number> | null = null;
      let emittedToolCalls = false;

      for await (const ev of callStreaming(perchOpts, c.req.raw.signal)) {
        if (ev.type === "__http_error") {
          const body = openAiErrorBody(ev as unknown as Error & { type: string });
          await sse.writeSSE({ data: JSON.stringify(body) });
          return;
        }
        if (ev.type === "answer_delta" && typeof ev.text === "string") {
          await sendChunk({ content: ev.text });
        } else if (
          ev.type === "reasoning_delta" &&
          typeof ev.text === "string"
        ) {
          await sendChunk({ reasoning_content: ev.text });
        } else if (ev.type === "tool_use_end") {
          const calls = fromDoneEvent({ toolCalls: ev.toolCalls }).toolCalls;
          for (let i = 0; i < calls.length; i++) {
            await sendChunk({
              tool_calls: [
                {
                  index: i,
                  id: calls[i].id,
                  type: "function",
                  function: { name: calls[i].function.name, arguments: calls[i].function.arguments },
                },
              ],
            });
          }
          emittedToolCalls = emittedToolCalls || calls.length > 0;
        } else if (ev.type === "done") {
          if (ev.ok === false) {
            const body = openAiErrorBody(
              Object.assign(new Error(String(ev.error ?? "Model call failed")), {
                type: "api_error",
              }),
            );
            await sse.writeSSE({ data: JSON.stringify(body) });
            return;
          }
          const result = fromDoneEvent(ev);
          usage = result.usage;
          if (!emittedToolCalls && result.toolCalls.length) {
            for (let i = 0; i < result.toolCalls.length; i++) {
              const tc = result.toolCalls[i];
              await sendChunk({
                tool_calls: [
                  { index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } },
                ],
              });
            }
            emittedToolCalls = true;
          }
          await sendChunk({}, result.toolCalls.length ? "tool_calls" : "stop");
          if (usage) {
            await sse.writeSSE({
              data: JSON.stringify({
                ...chunkBase,
                choices: [],
                usage,
              }),
            });
          }
          return;
        } else if (ev.type === "error") {
          const body = openAiErrorBody(
            Object.assign(new Error(String(ev.message ?? "Stream error")), { type: "api_error" }),
          );
          await sse.writeSSE({ data: JSON.stringify(body) });
          return;
        }
      }
      await sendChunk({}, "stop");
    } catch (err) {
      if (!c.req.raw.signal.aborted) {
        await sse
          .writeSSE({ data: JSON.stringify(openAiErrorBody(err as Error)) })
          .catch(() => {});
      }
    }
  });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`perch-proxy listening on http://localhost:${info.port}/v1`);
});
