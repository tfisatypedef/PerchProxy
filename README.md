# perch-proxy

A local, OpenAI-compatible API proxy for [Perch AI](https://perchai.app).
It exposes the models available in your Perch plan (GLM 5.x, DeepSeek V4,
Kimi K2.x, MiniMax M3, Qwen 3.x, Grok 4.3, Nemotron, Inkling, ...) through a
standard `/v1/chat/completions` endpoint so tools like
[opencode](https://opencode.ai), Aider, or Cline can use them.

```
harness (OpenAI format) ──> perch-proxy (localhost) ──> app.perchai.app ──> model
        <── OpenAI chunks / errors ── translation ── Perch SSE events ──┘
```

> ## ⚠️ Disclaimer — read before using
>
> Perch AI does **not** offer a public inference API. This proxy speaks the
> same internal endpoint that Perch's own desktop/CLI clients use, which is
> **outside Perch's terms of service**. Use at your own risk: your account may
> be suspended or terminated. All usage is billed against your Perch plan's
> included allowance exactly as it would be in their apps. This project is
> educational; the authors take no responsibility for account actions.

## How it works

- Reverse-engineered protocol spec: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Reads your existing Perch session from disk (`perch login` via CLI, or just
  being signed into Perch Desktop) and transparently refreshes tokens through
  Perch's auth provider when they expire.
- Translates OpenAI chat-completions requests to Perch's wire format and
  streams back proper OpenAI SSE chunks, including tool calls.
- Normalizes Perch errors into OpenAI's `{ error: { message, type, code } }`
  shape, retries transient upstream failures with backoff, and synthesizes
  `x-ratelimit-*` headers.

## Requirements

- Node.js 20+
- A signed-in Perch session on this machine (Perch Desktop app, or `npx perchai-cli login`)

## Setup

```bash
npm install
npm start          # serves http://localhost:8787/v1
```

Check readiness:

```bash
curl http://localhost:8787/healthz   # -> {"status":"ok"}
curl http://localhost:8787/readyz    # -> {"status":"ready", ...} once a session is found
```

Point your harness at `http://localhost:8787/v1`. Example for opencode
(`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "perch": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Perch Proxy",
      "options": {
        "baseURL": "http://localhost:8787/v1",
        "apiKey": "sk-noauth"
      },
      "models": {
        "auto": { "name": "Roost Auto" },
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" },
        "glm-5": { "name": "GLM 5" },
        "kimi-k2.5": { "name": "Kimi K2.5" }
      }
    }
  }
}
```

## Codex CLI

The proxy implements the OpenAI **Responses API** (`/v1/responses`) natively,
so Codex CLI works out of the box:

```toml
# ~/.codex/config.toml
[model_providers.perch]
name = "Perch Proxy"
base_url = "http://localhost:8787/v1"
env_key = "PERCH_DUMMY_KEY"   # any env var name; value is ignored

[profiles.perch]
model_provider = "perch"
model = "auto"
```

```powershell
$env:PERCH_DUMMY_KEY = "x"
codex --profile perch
```

Plain `wire_api = "chat"` providers against the same base URL also work.

## Models

`GET /v1/models` lists the registry. `model: "auto"` uses Perch's Roost
automatic routing; any other known id pins a specific model. Responses carry
a non-standard `perch_served: { provider, model }` field showing what
actually ran.

Pinned ids are mapped to Perch's internal option ids (e.g.
`glm-5.2` → `wandb-zai-org-glm-5-2`). Unknown model strings are passed
through verbatim as pin ids.

Starter tier (verified): `qwen-3.6`, `deepseek-v4-flash`, `kimi-k2.5`,
`glm-5`, `qwen3-coder`, `nemotron-super`, `minimax-m2`, `gemma-4-e2b`,
`gemma-4-31b`.

Pro tier (mapped, unverified): `glm-5.2`, `deepseek-v4-pro`, `kimi-k2.6`,
`kimi-k2.7-code`, `minimax-m3`, `nemotron-ultra`, `nemotron-3.5-lightning`,
`grok-4.3`, `qwen-3.7-plus`, `qwen-3.8-27b`, `deepseek-v4-flash-0731`,
`inkling`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PERCH_PROXY_PORT` | `8787` | listen port |
| `PERCH_PROXY_API_KEY` | none | if set, clients must send this bearer key |
| `PERCH_PROXY_RPM` | `60` | local rate-limit budget used for synthesized headers |
| `PERCH_PROXY_RETRIES` | `3` | attempts for retryable upstream failures |
| `PERCH_TOKEN` | – | bypass session file with an explicit bearer token |
| `PERCH_CLI_AUTH_DIR` | – | override session directory |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit tests (translator)
node --import tsx scripts/pin-check.ts <option-id> ...  # probe upstream pins
```

Project history and design decisions: [`plan.md`](plan.md).

## License

[MIT](LICENSE)
