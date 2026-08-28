import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getPerchAuth } from "./auth.js";
import { openAiErrorBody } from "./errors.js";
import { logRequest, type RequestLogMeta } from "./logging.js";
import { rateLimitHeaders, take } from "./ratelimit.js";
import {
  fromDoneEvent,
  toPerchOptions,
  type OpenAiChatRequest,
} from "./translate.js";
import { callNonStreaming, callStreaming, type PerchCallOptions, type PerchEvent } from "./upstream.js";
import {
  callNonStreamingCc,
  callStreamingCc,
  getCcAuth,
  toCcOptions,
  type CcCallOptions,
} from "./commandcode.js";
import {
  buildResponseObject,
  responsesToChat,
  type ResponsesRequest,
} from "./responses.js";

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

// Command Code hosted-lane models (docs/COMMANDCODE-PROTOCOL.md). Routed by
// id — anything not in this list goes to the Perch upstream as before.
const CC_MODEL_LIST: Record<string, string> = {
  "minimax/minimax-m3-free": "MiniMax M3 (Command Code free)",
  "minimax/minimax-m2.7-free": "MiniMax M2.7 (Command Code free)",
  "meta/muse-spark-1.1": "Muse Spark 1.1 (Command Code free)",
  "meta/muse-spark-1.2": "Muse Spark 1.2 (Command Code free)",
  "poolside/laguna-s-2.1-free": "Laguna S 2.1 (Command Code free)",
  "inclusionai/ling-3.0-flash-free": "Ling 3.0 Flash (Command Code free)",
};

function isCommandCodeModel(model?: string): boolean {
  return !!model && model in CC_MODEL_LIST;
}

type AnyUpstreamOpts = PerchCallOptions | CcCallOptions;
type NonStreamingFn = (
  opts: AnyUpstreamOpts,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;
type StreamingFn = (
  opts: AnyUpstreamOpts,
  signal?: AbortSignal,
) => AsyncGenerator<PerchEvent>;

function selectUpstream(model: string): {
  cc: boolean;
  nonStreaming: NonStreamingFn;
  streaming: StreamingFn;
} {
  if (isCommandCodeModel(model)) {
    return {
      cc: true,
      nonStreaming: callNonStreamingCc as unknown as NonStreamingFn,
      streaming: callStreamingCc as unknown as StreamingFn,
    };
  }
  return {
    cc: false,
    nonStreaming: callNonStreaming as unknown as NonStreamingFn,
    streaming: callStreaming as unknown as StreamingFn,
  };
}

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
  const [auth, ccAuth] = await Promise.all([getPerchAuth(), getCcAuth()]);
  if (!auth.token && !ccAuth) {
    return c.json(
      {
        error: {
          message: "No Perch session (`perch login`) and no Command Code key (`cmdc login`).",
          type: "authentication_error",
          code: null,
        },
      },
      401,
    );
  }
  const data = Object.entries(MODEL_LIST).map(([id, label]) => ({
    id,
    object: "model",
    created: 0,
    owned_by: id === "auto" ? "perch-roost" : "perch",
    meta: { description: label },
  }));
  if (ccAuth) {
    data.push(
      ...Object.entries(CC_MODEL_LIST).map(([id, label]) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "command-code",
        meta: { description: label },
      })),
    );
  }
  return c.json({ object: "list", data });
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
  const startedAt = Date.now();

  let req: OpenAiChatRequest;
  try {
    req = (await c.req.json()) as OpenAiChatRequest;
  } catch {
    logRequest(c, 400, startedAt, { error: "invalid JSON" });
    return c.json(
      openAiErrorBody(new Error("Invalid JSON body")),
      400,
    );
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    logRequest(c, 400, startedAt, { error: "empty messages" });
    return c.json(
      openAiErrorBody(new Error("`messages` must be a non-empty array")),
      400,
    );
  }

  const modelId = req.model ?? "auto";
  const upstream = selectUpstream(modelId);

  if (upstream.cc) {
    if (!(await getCcAuth())) {
      const msg = "No Command Code key. Run `cmdc login` or set COMMANDCODE_API_KEY.";
      logRequest(c, 401, startedAt, { error: msg });
      return c.json(openAiErrorBody(new Error(msg)), 401);
    }
  } else {
    const sessionErr = await requireSession();
    if (sessionErr) {
      logRequest(c, 401, startedAt, { error: sessionErr.message });
      return c.json(openAiErrorBody(sessionErr), 401);
    }
  }

  const perchOpts = toPerchOptions(req);
  const upstreamOpts: AnyUpstreamOpts = upstream.cc
    ? toCcOptions(req, modelId)
    : perchOpts;
  const bucket = take("global");

  if (!req.stream) {
    try {
      const done = await upstream.nonStreaming(upstreamOpts, c.req.raw.signal);
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
      logRequest(c, 200, startedAt, {
        model: modelId,
        served: `${result.provider}/${result.model}`,
        input_tokens: (result.usage ?? {}).prompt_tokens ?? 0,
        output_tokens: (result.usage ?? {}).completion_tokens ?? 0,
      });
      return res;
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = (
        e.status && e.status >= 400 && e.status < 600 ? e.status : 502
      ) as ContentfulStatusCode;
      logRequest(c, status, startedAt, { model: modelId, error: e.message });
      return c.json(openAiErrorBody(err as Error), status);
    }
  }

  return streamSSE(c, async (sse) => {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunkBase = { id, object: "chat.completion.chunk", created, model: modelId };
    const streamMeta: RequestLogMeta = { model: modelId };

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

      for await (const ev of upstream.streaming(upstreamOpts, c.req.raw.signal)) {
        if (ev.type === "__http_error") {
          streamMeta.error = String((ev as { message?: string }).message ?? "upstream error");
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
          streamMeta.served = `${result.provider}/${result.model}`;
          streamMeta.input_tokens = usage?.prompt_tokens;
          streamMeta.output_tokens = usage?.completion_tokens;
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
      streamMeta.error = (err as Error).message;
      if (!c.req.raw.signal.aborted) {
        await sse
          .writeSSE({ data: JSON.stringify(openAiErrorBody(err as Error)) })
          .catch(() => {});
      }
    } finally {
      logRequest(c, streamMeta.error ? 502 : 200, startedAt, streamMeta);
    }
  });
});

app.post("/v1/responses", async (c) => {
  const startedAt = Date.now();

  let req: ResponsesRequest;
  try {
    req = (await c.req.json()) as ResponsesRequest;
  } catch {
    logRequest(c, 400, startedAt, { error: "invalid JSON" });
    return c.json({ error: { message: "Invalid JSON body" } }, 400);
  }

  const chatReq = responsesToChat(req);
  if (!Array.isArray(chatReq.messages) || chatReq.messages.length === 0) {
    logRequest(c, 400, startedAt, { error: "empty input" });
    return c.json(
      { error: { message: "`input` must be a string or a non-empty array" } },
      400,
    );
  }

  const modelId = req.model ?? "auto";
  const upstream = selectUpstream(modelId);

  if (upstream.cc) {
    if (!(await getCcAuth())) {
      const msg = "No Command Code key. Run `cmdc login` or set COMMANDCODE_API_KEY.";
      logRequest(c, 401, startedAt, { error: msg });
      return c.json({ error: { message: msg } }, 401);
    }
  } else {
    const sessionErr = await requireSession();
    if (sessionErr) {
      logRequest(c, 401, startedAt, { error: sessionErr.message });
      return c.json({ error: { message: sessionErr.message } }, 401);
    }
  }

  const bucket = take("global");
  const perchOpts = toPerchOptions(chatReq);
  const upstreamOpts: AnyUpstreamOpts = upstream.cc
    ? toCcOptions(chatReq, modelId)
    : perchOpts;

  if (!req.stream) {
    try {
      const done = await upstream.nonStreaming(upstreamOpts, c.req.raw.signal);
      const result = fromDoneEvent(done);
      logRequest(c, 200, startedAt, {
        model: modelId,
        served: `${result.provider}/${result.model}`,
        input_tokens: result.usage?.prompt_tokens ?? 0,
        output_tokens: result.usage?.completion_tokens ?? 0,
      });
      return c.json(
        buildResponseObject({
          model: modelId,
          text: result.text,
          toolCalls: result.toolCalls,
          usage: result.usage,
        }),
        200,
      );
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = (
        e.status && e.status >= 400 && e.status < 600 ? e.status : 502
      ) as ContentfulStatusCode;
      logRequest(c, status, startedAt, { model: modelId, error: e.message });
      return c.json(openAiErrorBody(err as Error), status);
    }
  }

  return streamSSE(c, async (sse) => {
    let responseId = "";
    let messageId = "";
    let outputIndex = -1;
    const streamMeta: RequestLogMeta = { model: modelId };
    const collectedText: string[] = [];
    const collectedCalls: Array<{
      itemIndex: number;
      callId: string;
      name: string;
      args: string;
      itemId: string;
    }> = [];
    let textClosed = false;

    const emit = (event: string, data: unknown) =>
      sse.writeSSE({ event, data: JSON.stringify(data) });

    try {
      responseId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      await emit("response.created", {
        response: { id: responseId, object: "response", status: "in_progress", model: modelId },
      });
      await emit("response.in_progress", {
        response: { id: responseId, status: "in_progress" },
      });

      const closeText = async () => {
        if (textClosed || !messageId) return;
        textClosed = true;
        await emit("response.output_text.done", {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: collectedText.join(""),
        });
        await emit("response.content_part.done", {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: collectedText.join(""), annotations: [] },
        });
        await emit("response.output_item.done", {
          output_index: 0,
          item: {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: collectedText.join(""), annotations: [] },
            ],
          },
        });
      };

      let finalUsage: Record<string, number> | null = null;

      for await (const ev of upstream.streaming(upstreamOpts, c.req.raw.signal)) {
        if (ev.type === "__http_error") {
          await sse.writeSSE({
            event: "response.failed",
            data: JSON.stringify({
              response: { id: responseId, status: "failed" },
              error: openAiErrorBody(ev as unknown as Error & { type: string }).error,
            }),
          });
          return;
        }
        if (ev.type === "answer_delta" && typeof ev.text === "string") {
          if (!messageId) {
            messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
            outputIndex += 1;
            await emit("response.output_item.added", {
              output_index: outputIndex,
              item: {
                type: "message",
                id: messageId,
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            });
            await emit("response.content_part.added", {
              item_id: messageId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
          }
          collectedText.push(ev.text);
          await emit("response.output_text.delta", {
            item_id: messageId,
            output_index: outputIndex,
            content_index: 0,
            delta: ev.text,
          });
        } else if (ev.type === "tool_use_end" || ev.type === "done") {
          if (ev.type === "tool_use_end") await closeText();
          if (ev.type !== "done") continue;
          const result = fromDoneEvent(ev);
          finalUsage = result.usage;
          streamMeta.served = `${result.provider}/${result.model}`;
          streamMeta.input_tokens = finalUsage?.prompt_tokens;
          streamMeta.output_tokens = finalUsage?.completion_tokens;
          await closeText();
          for (const tc of result.toolCalls) {
            outputIndex += 1;
            const itemId = `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
            await emit("response.output_item.added", {
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: itemId,
                call_id: tc.id,
                name: tc.function.name,
                arguments: "",
                status: "in_progress",
              },
            });
            await emit("response.function_call_arguments.delta", {
              item_id: itemId,
              output_index: outputIndex,
              delta: tc.function.arguments,
            });
            await emit("response.function_call_arguments.done", {
              item_id: itemId,
              output_index: outputIndex,
              arguments: tc.function.arguments,
            });
            await emit("response.output_item.done", {
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: itemId,
                call_id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
                status: "completed",
              },
            });
            collectedCalls.push({
              itemIndex: outputIndex,
              callId: tc.id,
              name: tc.function.name,
              args: tc.function.arguments,
              itemId,
            });
          }
          const responseObject = buildResponseObject({
            model: modelId,
            text: collectedText.join(""),
            toolCalls: collectedCalls.map((x) => ({
              id: x.callId,
              type: "function" as const,
              function: { name: x.name, arguments: x.args },
            })),
            usage: finalUsage,
          });
          responseObject.id = responseId;
          await emit("response.completed", { response: responseObject });
          return;
        } else if (ev.type === "error") {
          await sse.writeSSE({
            event: "response.failed",
            data: JSON.stringify({
              response: { id: responseId, status: "failed" },
              error: openAiErrorBody(
                Object.assign(new Error(String(ev.message ?? "Stream error")), {
                  type: "api_error",
                }),
              ).error,
            }),
          });
          return;
        }
      }
      await closeText();
      const responseObject = buildResponseObject({
        model: modelId,
        text: collectedText.join(""),
        toolCalls: [],
        usage: null,
      });
      responseObject.id = responseId;
      await emit("response.completed", { response: responseObject });
    } catch (err) {
      streamMeta.error = (err as Error).message;
      if (!c.req.raw.signal.aborted) {
        await sse
          .writeSSE({
            event: "response.failed",
            data: JSON.stringify({
              response: { id: responseId, status: "failed" },
              error: openAiErrorBody(err as Error).error,
            }),
          })
          .catch(() => {});
      }
    } finally {
      logRequest(c, streamMeta.error ? 502 : 200, startedAt, streamMeta);
    }
  });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`perch-proxy listening on http://localhost:${info.port}/v1`);
});
