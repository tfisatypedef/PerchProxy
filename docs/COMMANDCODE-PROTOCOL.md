# Command Code — hosted lane protocol spec

Reverse-engineered spec of the hosted ("subscription") API used by the
`command-code` CLI (npm `command-code`, version analyzed: **1.36.0**).
Companion to [`PROTOCOL.md`](PROTOCOL.md) (Perch AI).

> Same disclaimer as the Perch proxy: Command Code does not advertise a public
> inference API. Speaking its internal lane directly is outside its terms of
> service; usage bills against the account allowance. At your own risk.

Evidence: static analysis of `dist/cli.mjs` (minified bundle) plus live
probes on 2026-08-28 (whoami 200; generate envelope validated 200; free-lane
model pool returned retryable 503 during probing — event schema below is from
the CLI's own `consumeStream` parser, which is authoritative).

## 1. Base URLs

```
prod    https://api.commandcode.ai
staging https://staging-api.commandcode.ai
local   http://localhost:9090
```

Studio (auth + usage UI): `https://commandcode.ai` (staging:
`https://staging.commandcode.ai`). Telemetry (separate service):
`https://ingestion.claicode.com/v1/inference-events`.

## 2. Auth

- Login (`cmdc login`): browser opens
  `{studioBase}/studio/auth/cli?callback=http://localhost:5959/callback&state=...`;
  a loopback server receives `POST /callback` with JSON
  `{apiKey, state, userId, userName, keyName}`.
- Storage: `~/.commandcode/auth.json` (0600):
  `{apiKey, userId, userName, keyName, authenticatedAt}`.
- **Static, long-lived API key. No expiry, no refresh, no rotation.**
  Validated by `GET /alpha/whoami` (`{success, user:{id,name,email,userName}, org}`).
- The OAuth/PKCE + device-code machinery in the bundle is for third-party
  provider modules (Anthropic/Copilot/Codex), not for command-code auth.

### Request headers (hosted lane)

| Header | Value |
|---|---|
| `Authorization` | `Bearer <auth.json apiKey>` |
| `Content-Type` | `application/json` |
| `User-Agent` | `cli` |
| `x-cli-environment` | `prod` (api env name) |
| `x-command-code-version` | package version, e.g. `1.36.0` |
| `traceparent` | W3C trace header (optional, OTel) |
| `x-cmd-zdr` | `1` opt-in only |
| `x-cmd-provider-deepseek-internal` | opt-in only |

## 3. Inference endpoint

`POST {base}/alpha/generate` — newline-delimited JSON request and response
(**not** SSE `data:` framing). Verified live: the server returns
`application/json` 200 and streams NDJSON lines.

### Request body

```jsonc
{
  "config": {                       // required (400 otherwise)
    "workingDir": "C:\\...",        // string, required
    "date": "2026-08-28",           // string, required
    "environment": "cli",           // string, required
    "structure": [],                // array,  required
    "isGitRepo": false,             // boolean,required
    "currentBranch": "",            // string, required
    "mainBranch": "",               // string, required
    "gitStatus": "",                // string, required
    "recentCommits": []             // array,  required
  },
  "memory": "",                     // string, required (memory/taste notes; null OK)
  "taste": null,                    // optional
  "skills": null,                   // optional
  "permissionMode": "default",      // e.g. "default" | "plan" | "yolo" | "readonly"
  "threadId": "<uuid>",             // optional (undefined if not a valid uuid)
  "mode": "agent",                  // session mode ("agent", "plan", "output", "vision")
  "params": {
    "model": "minimax/minimax-m3-free",
    "messages": [ /* Anthropic-style, see §4 */ ],
    "tools":   [ /* {name, description, input_schema} */ ],
    "system":  "…",                 // string system prompt
    "max_tokens": 64000,            // CLI default (64e3)
    "stream": true,
    "temperature": 0.7,             // optional
    "reasoning_effort": "medium"    // optional, only if model supports thinking
  }
}
```

Validation errors are helpful 400s: `{"success":false,"error":{"code":
"BAD_REQUEST","message":"… Validation error: … at \"memory\" …"}}` — the HINT
enumerates every missing field, which is how the schema above was confirmed.

### Wire message format (Anthropic-style)

- `user` role: `content` is an array of blocks:
  - `{type:"text", text}`
  - `{type:"tool_result", tool_use_id, content:[{type:"text",text}|{type:"image",source}]}`
- `assistant` role: blocks `{type:"text",text}` and
  `{type:"tool_use", id, name, input}` (tool_use blocks replayed on follow-ups).

### Wire tool format

`{name, description, input_schema:{type:"object", properties, required}}`
(Anthropic tool schema — OpenAI `parameters` maps 1:1 to `input_schema`).

## 4. Response event stream (NDJSON)

Authoritative source: `consumeStream` in `cli.mjs`. Each line is a JSON event:

| Event | Fields | Meaning |
|---|---|---|
| `start` | – | first line of every stream |
| `text-delta` | `text` | assistant content delta |
| `reasoning-start` | – | begin reasoning block |
| `reasoning-delta` | `text` | reasoning delta |
| `reasoning-end` | – | end reasoning block |
| `tool-call` | `toolCallId`, `toolName`, `input` (or `args`), `providerExecuted?` | client tool invocation |
| `tool-result` | `toolCallId`, `toolName`, output fields | server-executed tool result |
| `finish` | `finishReason` (`"tool-calls"` \| `"length"` \| other→`end_turn`), `rawFinishReason`, `totalUsage:{inputTokens, outputTokens, inputTokenDetails:{cacheReadTokens, cacheWriteTokens}}`, `systemPromptTokens` | terminal success event |
| `error` | `error:{type, message, statusCode, isRetryable}` | mid-stream failure |
| `abort` | – | aborted |

Observed error shape (live): stream opens with `start`, then
`{"type":"error","error":{"type":"server_error","message":"Service temporarily
unavailable. Please try again shortly.","statusCode":503,"isRetryable":true}}`
— the free-lane model pool can 503 while the HTTP status is still 200. The CLI
retries retryable mid-stream errors internally.

## 5. Models

No hosted `/models` endpoint — the catalog is hardcoded in the client
(`vendor/model` ids, e.g. `minimax/minimax-m3-free`, `xai/grok-4.5`,
`meta/muse-spark-1.2`). Free-lane ids (from the client bundle):
`meta/muse-spark-1.1`, `meta/muse-spark-1.2`, `poolside/laguna-s-2.1-free`,
`inclusionai/ling-3.0-flash-free`, `minimax/minimax-m3-free`,
`minimax/minimax-m2.7-free` (list may drift with CLI versions).

## 6. Other hosted endpoints (same base, same auth)

`GET /alpha/whoami` · `POST /alpha/agent/generate` · `/alpha/billing/subscriptions`
· `/alpha/billing/credits` · `/alpha/usage/summary` · `/alpha/share/create|append|delete`
· `/alpha/fingerprint/record` · `/alpha/lifecycle-events` · `/alpha/namespaces`
· `/alpha/sandbox/start|stream` · `/alpha/web-search` · `/alpha/web-fetch`
· `/alpha/devrel-thread/*` · `/alpha/taste/*` · `/alpha/learn`.

## 7. BYOK lane (for reference)

`~/.commandcode/providers.json` defines custom providers: `{api:
"openai-completions" | "anthropic-messages", baseURL, apiKey: <"$ENV" |
"{env:VAR}" | "!command" reference only>, models: {id: {name?, contextWindow?,
reasoning?, ...}}, headers?, disabled?}`. **No `openai-responses` wire.** This
is how command-code itself can be pointed at perch-proxy (zero proxy changes):
define a provider with `baseURL: http://localhost:8787/v1`, key reference, and
the desired Perch model ids under `models`.

## 8. Proxy mapping (implemented in `src/commandcode.ts`)

- OpenAI `messages` → CC wire: system messages → `params.system` (joined);
  user text → `{type:"text"}` block; assistant text → text block; assistant
  `tool_calls` → `{type:"tool_use", id, name, input:<parsed JSON>}`;
  `role:"tool"` → user block `{type:"tool_result", tool_use_id, content:[text]}`.
- OpenAI tools → `{name, description, input_schema}`.
- Events → proxy-normalized events: `text-delta`→`answer_delta`,
  `reasoning-delta`→`reasoning_delta`, `tool-call`→`tool_use_end` (flat call),
  `finish`→`done` (text/toolCalls/usage aggregated, provider
  `command-code`), `error`→`error`/`__http_error` with status mapping.
- Non-streaming OpenAI requests run the stream to completion internally and
  aggregate (the lane is streaming-only as far as observed).
