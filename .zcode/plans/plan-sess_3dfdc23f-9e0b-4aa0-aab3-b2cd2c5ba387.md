# Execute: command-code extension for reverseperch

Per your constraints: minimal upstream usage (never more than a handful of tiny requests), free lane only (`minimax/minimax-m3-free`), all progress logged in `plan.md`.

## Steps

1. **Header extraction from bundle (local, no network):** pin down exact header names/values the CLI sends (`x-cli-environment`, `x-command-code-version`, User-Agent) so requests mirror the client.
2. **Phase 1 live capture — 2 tiny requests total:**
   - `GET /alpha/whoami` with the `~/.commandcode/auth.json` key (no tokens billed) to validate key + headers.
   - One `POST /alpha/generate`, model `minimax/minimax-m3-free`, prompt "Say OK", `max_tokens: 16`, `stream: true` — to capture the response event schema.
3. **Phase 0 doc:** write `docs/COMMANDCODE-PROTOCOL.md` (endpoints, auth, envelope, stream schema, model registry, evidence).
4. **Phase 2 adapter:** new `src/commandcode.ts` emitting the same normalized event shape the server already consumes (`answer_delta`/`reasoning_delta`/`tool_use_end`/`done`/`error`), plus model routing in `server.ts` (`/v1/models` gains command-code ids, chat/completions + responses route to the new upstream by model id). No changes to the Perch path.
5. **Verify:** `npm run typecheck`, `npm test`, then ONE minimal live request through the proxy (free m3 model, "Say OK") to confirm end-to-end.
6. **Log:** append execution-log section to `plan.md` with evidence and token-spending accounting (every upstream request listed).

No Perch upstream calls; no changes to existing Perch behavior; auth.json key never printed.