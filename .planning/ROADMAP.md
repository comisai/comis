# Roadmap: Comis

## Milestones

- ✅ **v1.0 — Comis Observability & Troubleshooting** — Phases 1-8 (shipped 2026-05-25)
- ✅ **v1.1 — MCP Hardening** — Phases 1-5 (shipped 2026-05-26)
- 🚧 **v1.2 — MCP Hardening II** — Phases 1-5 (active)

---

<details>
<summary>✅ v1.0 — Comis Observability & Troubleshooting (Phases 1-8) — SHIPPED 2026-05-25</summary>

8/8 phases verified · 35 plans · 140 commits · 172 files · +24,423/-907 LOC · 54/54 requirements met.
Archive: `.planning/milestones/v1.0-ROADMAP.md` · `v1.0-REQUIREMENTS.md` · `v1.0-MILESTONE-AUDIT.md`

</details>

---

<details>
<summary>✅ v1.1 — MCP Hardening (Phases 1-5) — SHIPPED 2026-05-26</summary>

5/5 phases verified · 18 plans · 35 tasks. MCP integration made secure-by-default and self-healing: no plaintext credential reaches config or git, OAuth tokens refresh instead of expiring, remote transports stay stable, sub-agents fail fast with actionable errors.

Phases: SEC (secret-detection keystone) · STORE (zero-config secrets store) · CRED (MCP credential firewall & lifecycle) · MCPX (MCP transport resilience) · SUBA (sub-agent tool governance).

Archive: `.planning/milestones/v1.1-ROADMAP.md` · `v1.1-REQUIREMENTS.md` · `v1.1-MILESTONE-AUDIT.md` · `v1.1-phases/`

</details>

---

## 🚧 v1.2 — MCP Hardening II (Active)

**Milestone Goal:** Close the residual code gaps the 2026-05-26 Higgsfield MCP incident exposed that v1.1 did *not* cover — a session-killing signed-thinking-block regression, plaintext credentials leaking into `daemon.log` / workspace / chat delivery, MCP-connect ergonomics, and silent/false-`success` failure surfacing — and route every agent-obtained credential through one enforced out-of-workspace secure store.

**Source plan:** `HIGGSFIELD-MCP-FIX-PLAN.md` (Part B root-causes each `R#` to file:line with RED tests; Part D sequences the A→E rollout). Research validation: `.planning/research/SUMMARY.md`.

**Mode:** yolo
**Granularity:** coarse
**TDD:** yes — every change in `packages/*/src/**` lands RED first, then GREEN. No backward-compat shims (AGENTS.md §2.9). `pnpm validate` (build + test + lint:security + cycles) green per phase; coverage floors lines 90 / branches 85 / functions 90 on `packages/*/src/**/*.ts`.
**Phase numbers restart at 1** for this milestone (v1.0 was Phases 1-8, v1.1 was Phases 1-5, both archived).

**Requirement IDs** preserve the source plan's stable `R0–R10` identifiers verbatim (cross-referenced by tests, commits, and the plan's internal links). Each R# maps to exactly one phase per the plan's Part D, confirmed dependency-correct by research.

### Phases

- [x] **Phase 1: REGR — Critical regressions** - Re-wire the dead signed-thinking scrubber (R5), stop the `daemon.log` redaction bypass (R1), unify the secret-detection vocabulary with a parity guard (R0) (completed 2026-05-27)
- [ ] **Phase 2: EGRESS — Secret egress firewall + secure credential home** - Shared `secret-egress-guard` at 4 boundaries (R4); one enforced out-of-workspace credential home with `needs_reauth`/breaker (R8)
- [ ] **Phase 3: CONNECT — MCP connect correctness + delivery UX** - JSON-string `headers` coercion with self-correcting error (R2), honest `endReason` (R3), never drop auth links/codes (R9), kill the validation-misdiagnosis cascade (R10)
- [ ] **Phase 4: OAUTH — OAuth refresh robustness** - Thread discovery metadata into on-401 refresh + proactive pre-expiry refresh (R6)
- [ ] **Phase 5: SANDBOX — Sandbox ergonomics** - Quote-aware newlines, read-only curl/wget pipe targets, venv seeding — without weakening the path/egress boundary (R7)

## Phase Details

### Phase 1: REGR — Critical regressions
**Goal**: P0 session-killers and live leaks are closed — the always-on signed-thinking scrubber is re-wired into the context-engine pipeline, no plaintext credential reaches the persisted `daemon.log`, and the core keystone and observability text redactor share one explicit secret-prefix vocabulary guarded against drift.
**Depends on**: Nothing (first phase)
**Requirements**: R0, R1, R5
**Build order** (forced): R0 → {R1 ∥ R5}
**Success Criteria** (what must be TRUE):
  1. `looksLikeSecretValue("hf_<short>") === true` and `scanForSecrets({ k: "hfr_<short>" })` flags it — `hf_`/`hfr_` are explicit, length-independent entries in the `@comis/core` keystone's `PLAINTEXT_SECRET_PREFIXES` (not entropy-incidental); a RED test proves the pre-patch short value slips through (R0).
  2. A parity test fails if `@comis/observability` `patterns.ts` adds a secret prefix the `@comis/core` keystone lacks — keystone prefix coverage ⊇ observability prefix set, single-source drift guard (R0).
  3. A multi-target file-transport logger (mirroring the daemon) masks `Bearer hf_<44+>` appearing in `errorText`, `command`, `argsPreview`, `msg`, and `err.stack`; a `${HF_TOKEN}` env-ref passes through unmasked — verified on both the pm2 and direct-stdout paths (R1).
  4. A continuation-shaped history `[user, assistant(thinking+tool_use), toolResult]` has no signed `thinking` block after `transformContext` runs, so a resume after a `requiresConfirmation`/error never triggers the Anthropic 400 "thinking blocks … cannot be modified" (R5).
  5. A layer-membership-and-ordering test asserts `createSignatureReplayScrubber` is present in the built context-engine pipeline and ordered **after `thinkingCleaner`, before `signatureSurrogateGuard`** — the durability mechanism that catches future unwiring; the pre-patch pipeline fails this test (R5).
**Constraints / research corrections**:
  - **R1 = pipeline, not parallel target**: the regex value-redact stage is composed as a `targets[].pipeline` upstream transform (built with `pino-abstract-transport` `enablePipelining`), **not** a parallel `targets[]` entry (parallel targets each get the raw line). It rides the existing sanctioned `infra → observability` edge and reuses `redactSecretsInText`. Add `serializers.err` to scrub `err.message`/`err.stack`; sanitize the exec tool's raw `command`.
  - **R5 layer position is load-bearing**: push the layer between `thinkingCleaner` and `signatureSurrogateGuard` — not near the orphaned callback state at the bottom of `context-engine.ts`. This is a ~5-line re-wire of already-shipped, fully-tested code; do **not** upgrade `@anthropic-ai/sdk`.
  - **R0 before R1 + R4**: the shared prefix vocabulary is the prerequisite for both. No new detection regexes authored from scratch — only R0's curated-prefix additions behind the parity guard.
**Plans**: 3 plans
Plans:
**Wave 1**
- [x] 01-01-PLAN.md — R0: unify secret-detection vocabulary (add hf_/hfr_/r8_ to PLAINTEXT_SECRET_PREFIXES + parity drift guard)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-02-PLAN.md — R1: stop daemon.log plaintext credential leak (pipeline redact stage + serializers.err + exec command sanitize)
- [x] 01-03-PLAN.md — R5: re-wire createSignatureReplayScrubber into context-engine pipeline (layer membership + ordering test)

---

### Phase 2: EGRESS — Secret egress firewall + secure credential home
**Goal**: No secret escapes via any agent-reachable egress, and every agent-obtained credential lives in one enforced out-of-workspace home. A shared `secret-egress-guard` scans/redacts/redirects at the write/edit, sub-agent result-relay/persist, delivery, and memory boundaries; MCP-server OAuth tokens are unified onto the same `OAuthCredentialStorePort` the provider tokens use, with a structured `needs_reauth` result and per-server circuit breaker that stops the agent retrying or improvising.
**Depends on**: Phase 1 (R0's unified prefix vocabulary underpins R4's scrubber; R1's redactor patterns inform egress coverage)
**Build order** (forced): R4-core guard → its 4 wirings; R8-store → R8-handoff
**Requirements**: R4, R8
**Success Criteria** (what must be TRUE):
  1. A write/edit tool call whose body contains `Bearer hf_<44+>` is guarded (default `warn` + redirect to the secure store; `security.writeSecretGuard: warn|block|off` knob, default `warn`), and a sub-agent `fullResult`/announcement containing a token is redacted **before** both relay and `persistFullResult` (R4).
  2. `DeliveryService.deliverToChannel` redacts a token in one pass over the assembled delivery text **before** chunking, so the channel adapter receives `[REDACTED]`; `OutputGuard`'s bearer/`hf_` rule **redacts** (not just warns) (R4).
  3. A memory write containing a token is blocked/redacted pre-persist by `validateMemoryWrite`, and the divergent `memory-store-tool.ts` secret copy is retired in favor of the keystone (R4).
  4. A cross-origin MCP redirect (different scheme/host/port) has `Authorization`/`Cookie` stripped (header allowlist + redirect-depth cap), a stdio MCP server's user-declared `env` has interpreter-control vars (`NODE_OPTIONS`, `PYTHONSTARTUP`, …) denied, and the `secrets-audit` doctor check is wired (R4).
  5. A hand-rolled OAuth `write` of a token into `workspace/` is blocked + redirected to the store; an MCP OAuth token is persisted to the unified `OAuthCredentialStorePort` at `0600` in the data dir and is **absent** from the workspace and every agent-readable path (R8).
  6. An MCP auth failure returns a structured `needs_reauth` result (not a generic error) and trips a per-server circuit breaker so the agent stops retrying; a sub-agent that obtains a credential relays a `${ref}`/profileId, never the raw token (R8).
**Constraints / research corrections**:
  - **R4 cycle trap (non-negotiable)**: `secret-egress-guard` lives in `@comis/core` and **owns its own text scrubber** over the R0 prefix list. It must **NOT** import `redactSecretsInText` from `@comis/observability` — that inverts the one-way `core ← observability` graph and fails both `pnpm cycles` and `architecture-graph.test.ts`. Run `pnpm cycles` + `no-cycles.test.ts` after **every** cross-package move; never add a `TARGET_GRAPH` edge to "fix" a cycle.
  - **R8 adapter location (non-negotiable)**: the MCP token-store adapter is **constructed in `daemon` and injected** via `oauthDeps.createTokenStore`. It must **never** be built in `skills` (forbidden `skills → memory` edge); `skills` imports only the `OAuthCredentialStorePort` *type* from `@comis/core`.
  - **No AES-at-rest for MCP tokens this milestone**: AES conflicts with the cross-process chokidar disk-watch refresh (stale refresh-token → `invalid_grant`). P1 requirement is one enforced `0600` home in the data dir, never the workspace. AES-at-rest is deferred (R8-AES, P3). Confirm the chokidar watch survives the port wrapping.
  - **`core/security/secrets-audit.ts` already exists** (`scanConfigForSecrets`/`auditSecrets`) — R4's audit-doctor check is ≈ wiring, not a new build. Confirm before building.
  - **Borrows**: **OpenClaw** (not Hermes) for cross-origin redirect header scrubbing (13-header allowlist + 20-redirect cap) and the stdio env denylist (~90-key denylist on user-declared env). **Hermes** for the `needs_reauth` result + per-server circuit breaker.
  - **Delivery scan placement**: one pass on assembled `deliveryText` **before** chunking with a cheap combined-prefix pre-filter — not ~15 regexes per chunk per message fleet-wide. Verify `perf-budget.test.ts` baseline; add a large-message delivery case.
**Plans**: 5 plans

**Wave 1** *(R4 foundation — self-contained intra-core)*
- [x] 02-01-PLAN.md — R4: secret-egress-guard core module + OutputGuard redact upgrade + validateMemoryWrite secret branch + config schema knob

**Wave 2** *(parallel, depend on Wave 1)*
- [x] 02-02-PLAN.md — R4: write/edit tool guard + sub-agent result relay+persist scrub + memory-store-tool SECRET_PATTERNS retirement
- [x] 02-03-PLAN.md — R4: delivery scan (deliverToChannel) + redirect header expansion + secrets-audit doctor check

**Wave 3** *(R8 credential home — depend on Wave 1+2)*
- [x] 02-04-PLAN.md — R8: createPortBackedMcpTokenStore adapter in daemon + setup-mcp.ts oauthDeps injection + oauth.storage encrypted default
- [ ] 02-05-PLAN.md — R8: needs_reauth structured result + circuit-breaker-on-401 + sub-agent secure handoff hint

> **Parallel non-code Ops workstream (out of code scope, runs alongside Phase 2):** The operational completion of the incident (plan Part C) — revoke/rotate every leaked Higgsfield `hf_`/`hfr_` token, scrub `~/.comis/.git` history (commits `c2e85b6`, `ad1f7e7`) with `git filter-repo`/BFG, delete the plaintext workspace artifacts (`higgsfield_token.json`, `output/higgsfield_tokens.json`, the token-bearing `subagent-results/…` file), and rotate/scrub the `daemon.log` lines carrying raw `Bearer hf_…` — must run concurrently. It is not a code requirement (mirrors v1.1's git-scrub workstream) but must not be forgotten. The R4 secrets-audit doctor is the code-side complement that flags exactly these inlined-plaintext cases going forward.

---

### Phase 3: CONNECT — MCP connect correctness + delivery UX
**Goal**: The MCP install becomes usable, honest, actionable, and self-correcting — `mcp_manage connect` accepts `headers` as a JSON string (or returns an error that names the exact fix), a tool failure is never recorded as `success`, user-essential pre-tool text (auth links / one-time codes) is never silently dropped from delivery, and a validation error never spirals into a misdiagnosis → forbidden `gateway patch` → false-capability-claim cascade.
**Depends on**: Phase 1 (R5 keeps turns alive so R3/R9 failure-surfacing is observable rather than swallowed by a mid-turn 400). May proceed after Phase 2 — R8's `needs_reauth`/breaker reinforces R10's anti-improvisation steering, but R2 alone collapses most of the R10 cascade.
**Build order** (forced): R2 → R10; R3 ∥ R9
**Requirements**: R2, R3, R9, R10
**Success Criteria** (what must be TRUE):
  1. `mcp_manage connect`/`reconnect` with `headers` passed as a JSON string forwards the **parsed object** to `rpcCall("mcp.connect")` (mirroring `providers-manage-tool`'s `coerceArgs`); the daemon-side credential firewall still runs on the resulting object (R2).
  2. A malformed/object-required `headers` value returns a self-correcting `[invalid_value]` error naming the exact fix — *"pass `headers` as an object, e.g. `{\"Authorization\":\"Bearer ${TOKEN}\"}`, not a JSON string"* (R2 / R10).
  3. When `finishReason ∈ {stop, end_turn}` **and** a tool failed, `endReason` is not `"success"` (an `error`/`completed_with_tool_errors` outcome), and a short failure notice **naming the failed tool** is appended to the delivered `response` — gated on no model acknowledgement so recovered turns stay quiet (R3).
  4. A turn `[text-with-URL, tool_use sessions_spawn, post-tool text]` delivers the URL (via the explicit `message` tool before the spawn, or a safety-net surfacing of discarded pre-tool text containing a URL/short code absent from the final response); a turn with only framing prose + a tool call still suppresses the prose (R9).
  5. A guided fixture where `mcp_manage connect` fails validation does **not** proceed to a `gateway patch integrations.mcp.servers` attempt, the MCP tool-guide states connect/disconnect go through `mcp_manage` (not `gateway patch`), and a `Validation failed for tool X` result never yields a false "X is unavailable" capability claim (R10).
**Constraints / research corrections**:
  - **Keep `pi-executor.test.ts:4892` and `:4966` green**: R9 must not re-introduce framing/step-prose noise into `result.response`. The carve-out predicate surfaces only URL/short-code-bearing pre-tool text; test it against the framing-prose-with-no-URL negative control.
  - **R2 is the keystone**: its `coerceArgs`-style coercion + self-correcting error collapses most of the R10 cascade (build R2 first, then close the R10 guidance/misdiagnosis gap). R2 mirrors the pattern already in `providers-manage-tool.ts`.
  - **R3 notice gating**: append the failure notice only when failed tools are non-empty AND the model did not already acknowledge the failure, to avoid noise on recovered turns.
**Plans**: TBD

---

### Phase 4: OAUTH — OAuth refresh robustness
**Goal**: The `auth:"oauth"` refresh path (which already works end-to-end for a Higgsfield-shaped server) is robust under idle/expiry — the already-loaded discovery metadata is reused on the on-401 refresh instead of re-discovering every time, and an idle connection refreshes its access token proactively before expiry rather than waiting for the next call to 401.
**Depends on**: — (independent; can run in parallel with Phase 5 after Phase 1)
**Requirements**: R6
**Success Criteria** (what must be TRUE):
  1. An on-401 refresh reuses the already-loaded `authorizationServerMetadata` and performs **no** re-discovery of the token endpoint — verified by asserting the discovery cascade is not re-invoked across consecutive refreshes (R6 #1).
  2. An idle connection whose access token is approaching expiry is refreshed proactively on the keepalive tick (reusing the existing refresh deduper) so it never sits with an expired access token until the next call (R6 #2).
**Constraints / research corrections**:
  - **`DiscoveryStateFileSchema` currently drops `authorizationServerMetadata` on disk** — either widen the schema to persist it or thread the in-memory cache into the on-401 refresh. The metadata-persistence strategy needs plan-phase decision (the one un-threaded value is in `deduped-fetch.ts`).
  - **No new dependency**: `@modelcontextprotocol/sdk@1.29.0` has **no** RFC 8628 device-flow (grep-confirmed) — that is correctly deferred (R6-DEV, P3). This phase is robustness, not a fix; the `auth:"oauth"` flow itself already works.
**Plans**: TBD

---

### Phase 5: SANDBOX — Sandbox ergonomics
**Goal**: The sandbox guards stop over-triggering on legitimate input without weakening the security boundary — newlines inside quoted strings are accepted while unquoted/top-level newlines stay rejected, read-only `curl`/`wget` pipe targets are allowed unless an upload/data flag is present, and the warm venv seeds a small default package set.
**Depends on**: — (independent; can run in parallel with Phase 4 after Phase 1)
**Requirements**: R7
**Success Criteria** (what must be TRUE):
  1. A command with a newline **inside a quoted string** is accepted (via the existing `ShellQuoteTracker`), while an unquoted/top-level newline is still rejected — the real injection vector stays blocked (R7).
  2. A read-only `| curl` / `| wget` pipe target is accepted, but the same target carrying an upload/data flag (`-T/--upload-file`, `-d/--data*`, `-F/--form`, `-X POST/PUT`) is blocked, and `nc`/`socat`/`telnet`/interpreters stay **unconditionally** blocked (R7).
  3. The warm venv seeds a small default set (`requests`) so a script needing it runs without a separate install step (R7).
**Constraints / research corrections**:
  - **`safe-path.ts` is NEVER weakened**: all existing negative controls stay green. Write the still-blocked negative controls (`/tmp` write still rejected; `| bash`/`| nc` still blocked; unquoted newline still rejected) **before** any relaxation — they lock the boundary.
  - **`ShellQuoteTracker` is already imported** and the upload-flag list is well-enumerated — this is a standard pattern, not new infrastructure.
**Plans**: TBD

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. REGR — Critical regressions | v1.2 | 3/3 | Complete    | 2026-05-27 |
| 2. EGRESS — Secret egress firewall + secure credential home | v1.2 | 4/5 | In Progress|  |
| 3. CONNECT — MCP connect correctness + delivery UX | v1.2 | 0/? | Not started | - |
| 4. OAUTH — OAuth refresh robustness | v1.2 | 0/? | Not started | - |
| 5. SANDBOX — Sandbox ergonomics | v1.2 | 0/? | Not started | - |

---

*Last updated: 2026-05-27 — v1.2 roadmap created (5 phases, 11 requirements R0–R10, coarse granularity). v1.1 collapsed to archive.*
