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

