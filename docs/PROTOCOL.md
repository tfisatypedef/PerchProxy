# Perch AI internal protocol — reverse-engineered spec

Source: static analysis of `perchai-cli@2.4.91` (`dist/perch.mjs`) plus live
validation through a working proxy, 2026-08-23.

## Overview

- There is **no public API**. The CLI's own system prompt states "there is no
  api.perchai.app". Everything goes through the web app backend at
  `https://app.perchai.app`.
- The single model-inference endpoint is:

  ```
  POST https://app.perchai.app/api/perch-terminal/model-call
  ```

  Base URL can be overridden via env `PERCH_MODEL_CALL_PROXY_URL`; bearer
  token via `PERCH_MODEL_CALL_PROXY_TOKEN`.
- Auth is Supabase (auth-js, PKCE browser login). Session persisted at:
  - `%USERPROFILE%\.perch\cli-auth-session.json` (override dir:
    `PERCH_CLI_AUTH_DIR`)
  - Perch Desktop (Electron) writes the same file format to
    `%APPDATA%\Perch AI Desktop\cli-auth-session.json` with keys:
    `version, appUrl, accessToken, refreshToken, expiresAt (unix s),
    userId, email, updatedAt`
  - macOS also mirrors into Keychain service `app.perchai.cli-auth`,
    account `default`.
- Token refresh is a plain Supabase grant — verified working:
  ```
  POST https://<project>.supabase.co/auth/v1/token?grant_type=refresh_token
  apikey: <publishable key>   Content-Type: application/json
  {"refresh_token": "..."}
  ```
  Response rotates BOTH access and refresh tokens; persist them or the old
  refresh token becomes unusable.
- On HTTP 401 the CLI re-syncs the session and retries once.
- Retry policy in CLI: up to 3 attempts, initial backoff 350ms doubling,
  retrying 408/425/5xx/network errors.

## Request

```jsonc
POST /api/perch-terminal/model-call
Headers:
  Content-Type: application/json
  Accept: text/event-stream        // when streaming
  Authorization: Bearer <supabase-access-token>   // may be absent for anon?

Body:
{
  "request": {
    "lane": "chat",                // task lane id
    "messages": [ /* OpenAI Chat Completions style */ ],
    "tools": [ /* OpenAI function tools */ ],
    "maxOutputTokens": 3000,
    "temperature": 0.7,
    "toolChoice": "auto" | "required" | "none",
    "responseFormat": { "type": "json_object" }?,   // optional
    "reasoning": null
  },
  "runId": "<uuid-ish>",
  "lane": "chat",
  "strictManual": false,
  "raceMode": null,
  "preferredModelId": null,
  "avoidModelIds": [],
  "attribution": null,
  "clientSurface": "cli",
  "manualModelOptionId": null       // pinned model option id, or null = Roost auto
}
```

### Message format (OpenAI-compatible)

Confirmed from the CLI's own provider adapters, which translate FROM this
internal format TO Anthropic/OpenAI:

- `{ role: "system"|"user"|"assistant"|"tool", content: string | blocks }`
- Content blocks: `{ type: "text", text }`, `{ type: "image_url", image_url: { url } }`
  (data: base64 or https URLs)
- Assistant tool calls: `tool_calls: [{ id, function: { name, arguments: "json-string" } }]`
- Tool results: `{ role: "tool", tool_call_id, content }`
- Tools: `[ { type: "function", function: { name, description, parameters } } ]`

Translation to upstream providers is nearly lossless ⇒ proxy translation is ~1:1.

## Response

Non-streaming: JSON result object (same shape as the final `done` event).
Streaming: SSE, `data: <json>\n\n` events:

| type                | fields                                   | meaning |
|---------------------|------------------------------------------|---------|
| `answer_delta`      | `text`                                   | output text chunk |
| `reasoning_delta`   | `text`                                   | reasoning chunk |
| `tool_call_delta`   | `toolCalls: [...]` (cumulative, possibly unsealed/partial args) | streaming tool call progress |
| `tool_use_end`      | `toolCalls: [...]` (sealed)              | final tool calls for the turn |
| `stream_restart`    | `reason: "mid_tool_call_failover"`       | reset accumulated text/tools |
| `continuation_seam` | `at`                                     | continuation boundary |
| `model_call_failed` | `provider, modelId, lane, error, errorCategory` | upstream failure notice |
| `error`             | `message`                                | fatal stream error |
| `done`              | `ok, text, toolCalls, provider, model, durationMs, usage{...}, debug{...}` | terminal success |

### Tool call item shape (validated live)

Upstream tool calls are **flat**, not OpenAI-nested:

```jsonc
{
  "id": "functions.get_weather:0",
  "name": "get_weather",
  "arguments": { "city": "Tokyo" },      // already-parsed object
  "sealed": true,                        // false while args stream in
  "argumentParseStatus": "parsed_ok",    // or "parse_failed"
  "requiredArguments": ["city"],
  "rawArgumentsText": " {\"city\": \"Tokyo\"} "
}
```

The `done` event also carries Anthropic-style content blocks:
`content: [{ type: "tool_use", id, name, input }]`.

Error codes seen: `provider_not_configured`, `api_error`, `timeout`,
`parse_error`, `usage_limit_reached`, `starter_model_blocked`,
`promo_overflow_decision`.

HTTP error body: `{ "error": "...", "errorCode"?: "..." }`.
429 = usage limit reached. 403 + "Upgrade to Pro" = starter_model_blocked
(premium model pinned on Starter plan).

## Models

Pinning uses `manualModelOptionId`. Option ids are `<provider>-<model slug>`
lowercased with `/`, `.`, `_` → `-` (e.g. `Cl("wandb", "zai-org/GLM-5.2")`
→ `wandb-zai-org-glm-5-2`). Verified live on Starter (served model echoed
back in the `done` event):

| Friendly name | option id | served as |
|---|---|---|
| Qwen 3.6 | `wandb-qwen3-6-35b-a3b` | `Qwen/Qwen3.6-35B-A3B` |
| DeepSeek V4 Flash | `wandb-deepseek-ai-deepseek-v4-flash` | `deepseek-ai/DeepSeek-V4-Flash` |
| Kimi K2.5 | `bedrock-mantle-moonshotai-kimi-k2-5` | `moonshotai.kimi-k2.5` |
| GLM 5 | `bedrock-mantle-zai-glm-5` | `zai.glm-5` |
| Qwen3 Coder | `bedrock-mantle-qwen-qwen3-coder-480b-a35b-instruct` | `qwen.qwen3-coder-480b-a35b-instruct` |
| Nemotron Super | `bedrock-mantle-nvidia-nemotron-super-3-120b` | `nvidia.nemotron-super-3-120b` |
| MiniMax M2 | `bedrock-mantle-minimax-minimax-m2` | `minimax.minimax-m2` |
| Gemma 4 E2B / 31B | `bedrock-mantle-google-gemma-4-e2b` / `...gemma-4-31b` | same pattern |

Pro tier (mapped from bundle, unverified on Starter): `wandb-zai-org-glm-5-2`
(GLM 5.2), `wandb-deepseek-ai-deepseek-v4-pro`, `wandb-kimi-k2-6`,
`wandb-kimi-k2-7-code`, `wandb-minimax-m3`,
`wandb-nvidia-nvidia-nemotron-3-ultra-550b-a55b`,
`wandb-nvidia-nvidia-nemotron-3-5-lightning-30b-a3b`,
`bedrock-mantle-xai-grok-4-3`,
`fireworks-accounts-fireworks-models-qwen3p7-plus`,
`fireworks-accounts-fireworks-models-inkling`,
`wandb-deepseek-ai-deepseek-v4-flash-0731`.

Invalid/plan-blocked pins do NOT error — the server silently falls back to
Roost auto routing. Always compare `done.model` against what you pinned.

Auto routing (`manualModelOptionId: null`) currently favored
`moonshotai/Kimi-K2.6` via provider `wandb` in testing.

## Usage metering

Server-side per-user dollar metering against published list rates
(Starter $20/mo included, Pro $150/mo). No per-request rate-limit headers
observed in the client code — proxy must synthesize them locally.
