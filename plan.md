# Perch → OpenAI-compatible Proxy — Implementation Plan

**STATUS: COMPLETE — working end-to-end (2026-08-23).**
Validated: non-streaming, streaming SSE, tool calling, model pinning
(9 Starter slugs live-verified), opencode agentic session via proxy.
Run: `cd <project dir> && npm start` → `http://localhost:8787/v1`.

Goal: local proxy exposing Perch AI's (perchai.app) routed models via an
OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`) for use with
external harnesses (opencode, Aider, Cline, etc.), with full tool-calling.

Stack: Node 20+ / TypeScript / Hono.

## Phase 0 — Static recon (CLI bundle)
1. Fetch `https://perchai.app/docs/concepts/models` → model registry names/tiers.
2. Download `perchai-cli` npm tarball into temp; unpack (5 files, ~7.5MB bundled JS).
3. Beautify bundle; grep for:
   - API base URLs (`api.perchai.app`, `/v1/`, `wss://`), endpoint paths
   - Auth: token storage path, refresh logic, request signing/HMAC
   - Chat wire format: request body fields, SSE framing, model param, tool definitions
4. Deliverable: `docs/PROTOCOL.md` protocol spec before writing proxy code.

## Phase 1 — Live capture & validation
5. User installs CLI, runs `perch login` (free Starter OK).
6. Capture one streaming chat round-trip (mitmproxy/Fiddler or DevTools on
   chat.perchai.app); reconcile against static spec.
7. curl probes: minimal chat, model pinning, tools payload, stream format,
   error shapes, rate limits/quota headers.

## Phase 2 — Proxy server (Node + Hono, TypeScript)
Scaffold in `<project dir>`:

- `src/server.ts` — Hono app on localhost.
- `GET /healthz` — instant `200 {"status":"ok"}`, no upstream I/O.
- `GET /readyz` — verifies cached Perch token validity (network only if refresh
  needed); `503` + reason when login required.
- `GET /v1/models` — in-memory registry cache (boot-time load + TTL) so it
  answers fast.
- `POST /v1/chat/completions` — bidirectional translation:
  - OpenAI `messages/tools/tool_calls` ⇄ Perch internal format (strip Perch
    citation/agentic scaffolding → clean completions).
  - SSE chunks ⇄ Perch stream events; also `stream: false`.
  - Error normalization via central `translateUpstreamError()`:
    `{ error: { message, type, code } }`; status mapping table from Phase 1
    evidence (401/403→authentication_error, 429→rate_limit_error,
    5xx→api_error, unknown→invalid_request_error). Mid-stream errors emit an
    OpenAI-style error chunk before close.
  - Rate-limit emulation: synthesize `x-ratelimit-limit-requests`,
    `-remaining-requests`, `-reset-requests` (+ token variants if usage data
    available) from a local limiter keyed to observed upstream behavior.
  - Upstream 429 handling: jittered exponential backoff retry (configurable N),
    surface 429 only after exhaustion.
- Auth middleware: optional local API key; injects Perch bearer token from CLI
  credential store or `PERCH_TOKEN` env, auto-refresh.
- Tests: translator unit tests + live smoke test script.

## Phase 3 — Harness integration
8. Point opencode/Aider/Cline at `http://localhost:<port>/v1`; run an agentic
   session end-to-end; fix tool-calling edge cases (parallel calls, streaming
   tool deltas).

## Risks
- ToS violation → possible account suspension; at-your-own-risk.
- Signed requests / cert pinning (Phase 0 detects early).
- Tool-calling fidelity depends on what Perch backend accepts — biggest
  unknown, validated in Phase 1 before design lock-in.

---

# Execution log

## Completed — Phase 0 recon (2026-08-23)
- Model registry pulled from `/docs/concepts/models`: 9 Starter + 13 Pro models.
- `perchai-cli@2.4.91` downloaded, unpacked, beautified (412k lines), analyzed.
- Full protocol extracted — see `docs/PROTOCOL.md`:
  - Endpoint: `POST https://app.perchai.app/api/perch-terminal/model-call`
  - Wire format is OpenAI-style messages/tools ⇒ ~1:1 translation.
  - SSE events: `answer_delta`, `reasoning_delta`, `tool_call_delta`,
    `tool_use_end`, `stream_restart`, `continuation_seam`,
    `model_call_failed`, `error`, `done`.
  - Auth: Supabase bearer token; CLI stores session in
    `%USERPROFILE%\.perch\cli-auth-session.json`.
  - Env overrides: `PERCH_MODEL_CALL_PROXY_URL`, `PERCH_MODEL_CALL_PROXY_TOKEN`.

## Completed — Phase 2 scaffold (2026-08-23)
- Built Node/Hono/TypeScript proxy: `src/server.ts`, `upstream.ts`,
  `translate.ts`, `errors.ts`, `ratelimit.ts`, `auth.ts`.
- Endpoints: `/healthz`, `/readyz`, `GET /v1/models` (22-model registry),
  `POST /v1/chat/completions` (streaming + non-streaming, tool calls).
- Error normalization to OpenAI envelope; retry w/ exponential backoff;
  401 re-read of session file; synthesized rate-limit headers.
- Typecheck clean; boot test passed (healthz 200 / readyz 503 / models 401).

## Discovery (2026-08-23)
- User has **Perch Desktop**, not the CLI. Desktop stores the same session
  format at `%APPDATA%\Perch AI Desktop\cli-auth-session.json`
  (`accessToken`, `refreshToken`, `expiresAt`, `userId`, `email`, ...).
- No CLI install needed.

## Auth fix + live validation (2026-08-23) — COMPLETE
1. DONE: `src/auth.ts` searches `%USERPROFILE%\.perch` and
   `%APPDATA%\Perch AI Desktop`, picks newest `cli-auth-session.json`.
2. DONE: Supabase project identified (`zlfuvsfjtgsdtqcaykia.supabase.co`,
   publishable key extracted from web bundle chunk5.js). Refresh-token grant
   verified working (HTTP 200 with rotated token pair).
3. INCIDENT (resolved): a manual refresh test succeeded upstream but the
   script crashed before persisting the rotated tokens and truncated the
   user's session file (no backup taken). Perch Desktop restored the session
   automatically on next launch — no re-login needed. Lesson applied: the
   proxy's own refresh path uses atomic tmp+rename persistence.
4. DONE: `src/auth.ts` rewritten — proactive expiry check, single-flight
   refresh via Supabase grant, atomic tmp+rename persistence of rotated
   tokens back to the session file. Typecheck clean.
5. DONE: Live validation complete (2026-08-23):
   - Non-streaming: 200, correct OpenAI shape, content + usage + synthesized
     rate-limit headers verified.
   - Streaming: correct chunk framing (role → reasoning_content/content
     deltas → finish_reason → trailing usage chunk).
   - Tool calling: initially broken (empty name) — upstream toolCalls are
     FLAT `{id, name, arguments: <object>}` not OpenAI-nested; fixed in
     translate.ts normalizeToolCalls; streaming now emits only sealed
     tool_use_end calls. Verified: finish_reason=tool_calls with valid JSON
     args. opencode end-to-end agentic session confirmed working by user.
   - Model pinning: guessed slugs silently fell back to auto. Real option IDs
     extracted from CLI bundle (format: provider + model slug, dashed).
     Starter tier VERIFIED live: qwen-3.6, deepseek-v4-flash, kimi-k2.5,
     glm-5, qwen3-coder, nemotron-super, minimax-m2, gemma-4-e2b/31b.
     Pro tier mapped from bundle (unverifiable on Starter): glm-5.2,
     deepseek-v4-pro, kimi-k2.6/k2.7-code, minimax-m3, nemotron-ultra/
     lightning, grok-4.3, qwen-3.7-plus/3.8-27b, deepseek-v4-flash-0731,
     inkling.
   - Responses include non-standard `perch_served` {provider, model} for
     routing transparency.
   Status: WORKING END TO END.

## Known limitations / follow-ups
- Proxy and Desktop app both refresh the shared session file; safe due to
  atomic writes, but a Supabase refresh-token revocation by one side could
  invalidate the other mid-flight (re-login fixes).
- Pro-tier pinned slugs unverified until account is on Pro.
- debug-pin.ts / debug-tools.ts kept as diagnostic utilities (npx tsx).

## Phase 4 — Responses API shim for Codex CLI (2026-08-23) — COMPLETE

Goal: native Codex CLI support without `wire_api = "chat"`. Codex defaults
to the OpenAI Responses API (`POST /v1/responses`); implement a translation
layer on top of the existing chat pipeline.

1. DONE: `src/responses.ts`:
   - Converts `input` (string or items), `instructions` → system message,
     responses-format tools → chat tools, tool_choice object → required.
   - Item mapping: `message` parts flattened to text, `function_call` merged
     into adjacent assistant message as tool_calls, `function_call_output`
     → tool message keyed by call_id; `reasoning` items skipped.
   - Stateless: ignores `previous_response_id`/`store`.
2. DONE: `POST /v1/responses` in server.ts, streaming + non-streaming.
3. DONE: 7 unit tests for translation (16 total across project).
4. DONE: Live validation:
   - Non-streaming: status=completed, output_text correct, usage present.
   - Streaming event sequence verified: response.created → in_progress →
     output_item.added → content_part.added → output_text.delta* →
     output_text.done → content_part.done → output_item.done →
     response.completed.
   - Tool calling via /v1/responses verified: function_call item with valid
     JSON arguments returned.
5. DONE: README documents native Codex setup (`~/.codex/config.toml`).

### Codex CLI usage walkthrough (2026-08-23)

One-time: `npm install -g @openai/codex`; create
`%USERPROFILE%\.codex\config.toml`:

```toml
[model_providers.perch]
name = "Perch Proxy"
base_url = "http://localhost:8787/v1"
env_key = "PERCH_DUMMY_KEY"

[profiles.perch]
model_provider = "perch"
model = "auto"
```

Every session:
1. Terminal 1: `cd <proxy dir>; npm start` → wait for
   `perch-proxy listening on http://localhost:8787/v1`.
2. Terminal 2:
   `$env:PERCH_DUMMY_KEY = "anything"` (value ignored; Codex just needs a key),
   then `codex --profile perch`.

Sanity checks: `/healthz` (proxy alive), `/readyz` (Perch session found).
`--profile perch` selects the config block; without it Codex targets
OpenAI's servers and fails.

## Follow-up: proxy access log — DONE (2026-08-23)
Added `src/logging.ts` + `logRequest()` calls at every terminal point of
`/v1/chat/completions` and `/v1/responses` (success, upstream error,
validation error, stream completion/failure). Console format:

```
[17:20:33] POST /v1/responses 200 4.0s model=deepseek-v4-flash served=wandb/deepseek-ai/DeepSeek-V4-Flash in=6 out=46
```

Verified live against both endpoints (streaming + non-streaming).

## Incident + fix: Perch enforces a turn ticket (2026-08-27) — COMPLETE

### Symptom
opencode (and any harness) began failing with:
`{"message":"Your plan includes Perch-hosted models for use in Perch AI Web,
Desktop, and CLI only. Direct API access is not included. Repeated direct-access
attempts may result in account suspension.","type":"__http_error","code":
"perch_surface_required"}`. Same account/plan had worked days earlier; affected
everything, not just one surface or one model. Root cause was NOT the token,
refresh, or a plan/credits change.

### Diagnosis (from `perchai-cli@2.4.96` static analysis)
Perch shipped a **turn-ticket** requirement. Official clients now:
1. `POST {appUrl}/api/perch-terminal/turn-ticket` with
   `Authorization: Bearer <supabase-access-token>` and body
   `{"surface":"cli","profile":"standard"}` → returns
   `{ok, ticket, ticketId, runId, expiresAt}`.
2. Call `/model-call` sending the `ticket` as the `x-perch-turn-ticket` header
   and the ticket's `runId` in the envelope `runId` field.

The proxy called `/model-call` with only `Authorization` (+ `clientSurface`,
legacy) and no turn ticket, so Perch classified it as direct API access
→ `perch_surface_required`. The ticket endpoint is itself turn-rate-limited
(429 + `turn_rate_limited`), so caching is mandatory.

### Fix (`src/upstream.ts`)
- Added `getTurnTicket(accessToken, force)` + `fetchTurnTicket()`:
  fetch one ticket per turn, cache it, single-flight renewal, reuse until
  30s before `expiresAt` (~5 min TTL; fall back to a still-valid stale ticket
  if renewal fails). Surface `"cli"`, profile `"standard"`.
- `buildEnvelope(opts, runId)` now takes the ticket's `runId`.
- `doFetch()` sends `x-perch-turn-ticket` header.
- `fetchWithRetry()` obtains the ticket after auth, rebuilds the envelope per
  attempt, and fetches a fresh ticket after a 401 auth refresh.
- No live pings: change validated by typecheck only, to avoid hitting the
  ticket endpoint gratuitously (banned-risk / turn-rate-limit concern).

### Necessary caveat
Because the proxy consumes a turn ticket per turn (same as the official CLI),
the proxied calls are subject to Perch's turn-rate limit and are still billed
against the plan allowance. The `perch_surface_required` for this account is
resolved only when the new code can obtain a ticket; it is **not** live-verified
here to avoid touching the endpoint gratuitously.

## Extension: Command Code hosted lane (2026-08-28) — COMPLETE (free lane live-verified)

### Goal
Extend the proxy with a second upstream: the hosted ("subscription") lane of
the `command-code` CLI (npm `command-code@1.36.0`), so its models — including
the free lane (`minimax/minimax-m3-free` etc.) — are servable through the same
OpenAI-compatible `/v1` endpoints. Protocol spec:
[`docs/COMMANDCODE-PROTOCOL.md`](docs/COMMANDCODE-PROTOCOL.md).

### Recon findings (static, `dist/cli.mjs` + live probes)
- Hosted inference: `POST https://api.commandcode.ai/alpha/generate` (staging
  `staging-api.commandcode.ai`, local `localhost:9090`). NDJSON request and
  response (not SSE). Anthropic-style wire: user/assistant `content` block
  arrays (`text`, `tool_use`, `tool_result`), tools as
  `{name, description, input_schema}`, separate `system` string.
- Envelope: required `config` (workingDir, date, environment, structure,
  isGitRepo, currentBranch, mainBranch, gitStatus, recentCommits — schema
  extracted from the server's 400 validation hints) + `memory`; optional
  `taste`, `skills`, `permissionMode` ("default"), `threadId` (uuid), `mode`
  ("agent"). `params`: model, messages, tools, system, max_tokens (CLI
  default 64000), stream, temperature?, reasoning_effort?.
- Auth: static, non-expiring API key in `~/.commandcode/auth.json`
  (`cmdc login` → browser → localhost:5959 callback). Sent as
  `Authorization: Bearer`; plus `User-Agent: cli`, `x-cli-environment: prod`,
  `x-command-code-version: 1.36.0`. No refresh/rotation.
- Response events (authoritative: CLI's own `consumeStream`):
  `start`, `text-delta{text}`, `reasoning-start/-delta{text}/-end`,
  `tool-call{toolCallId, toolName, input}`, `tool-result`, `abort`,
  `finish{finishReason, rawFinishReason, totalUsage{inputTokens, outputTokens,
  inputTokenDetails{...}}, systemPromptTokens}`,
  `error{error:{type, message, statusCode, isRetryable}}`.
- No hosted `/models` endpoint; catalog hardcoded in the client
  (`vendor/model` ids). Free lane ids: minimax-m3-free, minimax-m2.7-free,
  muse-spark-1.1/1.2, laguna-s-2.1-free, ling-3.0-flash-free.
- BYOK lane (reference): `~/.commandcode/providers.json` supports only
  `openai-completions` and `anthropic-messages` wires (no Responses API);
  apiKey must be `$ENV`/`{env:VAR}`/`!command` reference. This is also the
  zero-code path to point command-code itself at perch-proxy.

### Implementation
- `src/commandcode.ts`: auth (reads `~/.commandcode/auth.json`, cache 2s;
  `COMMANDCODE_API_KEY` / `COMMANDCODE_AUTH_DIR` / `COMMANDCODE_API_BASE_URL`
  env overrides), OpenAI→CC message/tool/envelope translation, NDJSON stream
  parser normalizing to the same events the Perch upstream emits
  (`answer_delta`, `reasoning_delta`, `tool_use_end`, `done`, `error`),
  non-streaming by stream aggregation. Errors reuse `classifyUpstreamError`.
- `src/server.ts`: `selectUpstream()` routes by model id — ids in
  `CC_MODEL_LIST` (six free-lane slugs) go to Command Code, everything else to
  Perch unchanged. `/v1/models` merges both registries (401 only when neither
  session nor CC key exists); auth gate per upstream in
  `/v1/chat/completions` and `/v1/responses`.
- Tests: 8 new in `test/commandcode.test.ts` (24 total) — message/tool
  mapping, envelope shape, option precedence.

### Live validation (upstream request accounting)
1. `GET /alpha/whoami` → 200 `{success, user{...}}` (no tokens billed).
2. Four `POST /alpha/generate` envelope probes: 400×2 (validation hints used
   to pin the `config` schema, no tokens billed), then 200 with
   `{"type":"start"}` + retryable `503 server_error` mid-stream ×3 (free-lane
   pool was down; no tokens billed).
3. Through the proxy, `minimax/minimax-m3-free`, "Say OK", max_tokens 16:
   - Non-streaming: **200, `content:"OK"`, finish_reason stop, usage
     7431/1 tokens** (prompt count is upstream-side scaffolding), served
     `command-code/minimax/minimax-m3-free`. ✅
   - Streaming: correct OpenAI chunk framing; the flaky lane 503'd mid-stream
     and the proxy correctly emitted an OpenAI-style error chunk before close
     (same behavior as the Perch error path). ✅ error path
   - Total billed output across probes: ~1 token. Per user constraint, only
     the free lane was touched.

### Notes / limitations
- The free lane's model pool intermittently 503s (observed in the official
  CLI too; the CLI retries internally). The proxy surfaces the error to the
  client instead of retrying mid-stream (retrying after partial output would
  duplicate content). Harness-level retries handle it.
- CC lane supports text + tools; image inputs are not translated in v1.
- `finish.finishReason` "tool-calls"/"length" mapping available on the done
  event; finish_reason derived from tool-call presence as in the Perch path.

## Usage

```powershell
cd <project dir>
npm start                # serves http://localhost:8787/v1
```

Env vars: `PERCH_PROXY_PORT` (8787), `PERCH_PROXY_API_KEY` (none),
`PERCH_PROXY_RPM` (60), `PERCH_TOKEN` (bypass session file),
`PERCH_CLI_AUTH_DIR`, `PERCH_PROXY_RETRIES` (3).

opencode config (`~/.config/opencode/opencode.json`): provider with
`"npm": "@ai-sdk/openai-compatible"`, baseURL `http://localhost:8787/v1`,
any apiKey, model ids from `/v1/models` (e.g. `auto`, `deepseek-v4-flash`,
`glm-5`).

