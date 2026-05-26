# Roadmap: Comis

## Milestones

- ✅ **v1.0 — Comis Observability & Troubleshooting** — Phases 1-8 (shipped 2026-05-25)
- 🚧 **v1.1 — MCP Hardening** — Phases 1-5 (in progress)

---

<details>
<summary>✅ v1.0 — Comis Observability & Troubleshooting (Phases 1-8) — SHIPPED 2026-05-25</summary>

8/8 phases verified · 35 plans · 140 commits · 172 files · +24,423/-907 LOC · 54/54 requirements met.
Archive: `.planning/milestones/v1.0-ROADMAP.md` · `v1.0-REQUIREMENTS.md` · `v1.0-MILESTONE-AUDIT.md`

</details>

---

## 🚧 v1.1 — MCP Hardening (Active)

**Milestone Goal:** Make Comis's MCP integration secure-by-default and self-healing — no plaintext credential reaches config or git, OAuth tokens refresh instead of expiring, remote transports stay stable, and sub-agents fail fast with actionable errors.

**Mode:** standard
**TDD:** yes — every change in `packages/*/src/**` lands RED first, then GREEN. No backward-compat shims (AGENTS.md §2.9).
**Phase numbers restart at 1** for this milestone.

### Phases

- [x] **Phase 1: SEC — Secret-detection keystone** - Consolidate two fragmented detection copies into one authoritative module; delete both legacy files; repoint all call sites (completed 2026-05-26)
- [x] **Phase 2: STORE — Zero-config secrets store** - Auto-generate master key on first boot; fail-early `env_set` UX; opt-out flag and docs (completed 2026-05-26)
- [x] **Phase 3: CRED — MCP credential firewall & lifecycle** - Block plaintext secrets from headers/config/git/LKG; extract static secrets; steer OAuth to `auth:"oauth"` (completed 2026-05-26)
- [x] **Phase 4: MCPX — MCP transport resilience** - Transport-aware keepalive; classify SSE self-heal errors; close old transport + generation guard (completed 2026-05-26)
- [x] **Phase 5: SUBA — Sub-agent tool governance** - Spawn-time `required_tools` validation; enriched "Tool not found"; lock gateway denylist invariant (completed 2026-05-26)

## Phase Details

### Phase 1: SEC — Secret-detection keystone
**Goal**: A single authoritative `core/security/secret-detection.ts` module exists, both legacy copies are deleted with no aliases, and every call site is repointed — closing the `Bearer <scheme>` false-negative that let the Higgsfield token through
**Depends on**: Nothing (first phase — prerequisite for all of Phase 3)
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04
**Success Criteria** (what must be TRUE):
  1. `looksLikeSecretValue("Bearer hf_<44+>")` returns `true` — a RED test proves the pre-patch function returns `false`, confirming the scheme-strip fix is load-bearing
  2. `isSecretFieldName("Authorization")` returns `true` and the field-name superset covers `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`
  3. `scanForSecrets({ headers: { Authorization: "Bearer ${TOK}" } })` returns `[]` — `${VAR}`/`$VAR`/`SecretRef` values are exempt, reusing patterns from `env-substitution.ts` with no re-authored regexes
  4. `daemon/api/mcp-plaintext-secret.ts` and `core/security/config-redaction.ts` are deleted; `pnpm validate` passes with zero cycles and all coverage floors met
**Plans**: TBD

> **Parallel workstream (out of code scope):** The operational git-history token scrub + revocation (design §12) — `git filter-repo`/BFG over `~/.comis/.git` plus provider-side revocation for tokens committed 2026-05-25 and -26 — must run concurrently with Phase 3 (CRED). It is not a code requirement but must not be forgotten.

---

### Phase 2: STORE — Zero-config secrets store
**Goal**: A fresh Comis install gets a working encrypted secrets store with no manual setup; `env_set` tells the caller immediately when persistence is impossible; operators can opt out; docs reflect the posture change
**Depends on**: Phase 1
**Requirements**: STORE-01, STORE-02, STORE-03, STORE-04
**Success Criteria** (what must be TRUE):
  1. On first boot with no `SECRETS_MASTER_KEY` in the environment, a master key is auto-generated, written to `~/.comis/.env` (0600), and the encrypted store is usable in the same boot — no restart required (`MasterKeyWriteResult.keyHex` drives same-boot injection; RED test confirms `keyHex` absent pre-patch)
  2. Setting `COMIS_DISABLE_ENCRYPTED_SECRETS=1` suppresses auto-init and the daemon boots in envfile-only mode, emitting a loud `WARN` about the backup obligation; `secretStore` is `undefined`
  3. An `env_set` call with no encrypted store available returns an immediate `secrets_store_unavailable` error with an honest hint — no confirmation dance, no rate-limit consumption, no `rpcCall` made
  4. Install docs (`docker/README-comis.md`, `install-render.mdx`, `docs/operations/docker.mdx`, `docs/security/secrets.mdx`, `environment-variables.mdx`) and CHANGELOG document the posture change
**Plans**: 5 plans

Plans:
- [x] 02-01-PLAN.md — TDD: Add `keyHex` to `MasterKeyWriteResult` in `@comis/core` (STORE-01 foundation)
- [x] 02-02-PLAN.md — TDD: Add `seedKeyHex` fallback to `setupSecrets` in `@comis/memory` (STORE-01 same-boot)
- [x] 02-03-PLAN.md — TDD: Wire opt-out flag + `writeMasterKeyIfAbsent` + `seedKeyHex` threading in daemon boot (STORE-01c + STORE-02)
- [x] 02-04-PLAN.md — TDD: Add `gateway.status` pre-flight in `env_set` for fail-early store check (STORE-03)
- [x] 02-05-PLAN.md — Docs sweep: 5 install docs + CHANGELOG encrypted-by-default posture change (STORE-04)

---

### Phase 3: CRED — MCP credential firewall & lifecycle
**Goal**: No plaintext secret can reach `config.yaml`, the last-known-good snapshot, the git history, or `config.read` output; static secret headers are automatically extracted to the encrypted store as `${VAR}` refs; OAuth bearer headers are refused with actionable guidance
**Depends on**: Phase 1, Phase 2
**Requirements**: CRED-01, CRED-02, CRED-03, CRED-04, CRED-05, CRED-06
**Success Criteria** (what must be TRUE):
  1. `mcp.connect` and `mcp.test` reject a plaintext secret in `headers` (e.g., `Authorization: "Bearer hf_…"`) and allow `Authorization: "Bearer ${HIGGSFIELD_TOKEN}"` — the `disablePlaintextSecretCheck` per-server opt-out still WARNs but does not throw
  2. `persistToConfig` with a plaintext secret in any field returns an `err` result before any write or `configGitManager.commit` call — the live connection survives runtime-only; `config.yaml` is unchanged
  3. The last-known-good snapshot is skipped (`{saved:false}`) when the source config contains any secret finding; `config.read` output has `headers.Authorization` masked by `redactForDisplay`
  4. A static secret header (e.g., `X-Api-Key: sk-ant-…`) is automatically extracted: `secretStore.set` is called with the raw value and the persisted entry holds the `${VAR}` ref; a mixed-form `"Bearer ${VAR}"` passes the §A scan without re-extraction
  5. A short-lived OAuth bearer in `Authorization` is refused with `[use_oauth_login]` — no extraction, no storage, actionable guidance to use `auth:"oauth"` + `comis mcp login`
**Plans**: 4 plans

Plans:
- [x] 03-01-PLAN.md — Wire `secretStore` into `WorkspaceApiDeps` + extract `mcp-header-credential.ts` helper (CRED-05 foundation)
- [x] 03-02-PLAN.md — TDD: mcp.connect/mcp.test headers credential firewall + extraction + OAuth refusal (CRED-01, CRED-05, CRED-06)
- [x] 03-03-PLAN.md — TDD: persistToConfig secret gate + saveLastKnownGood snapshot guard (CRED-02, CRED-03)
- [x] 03-04-PLAN.md — TDD: config.read header masking regression guard (CRED-04)

---

### Phase 4: MCPX — MCP transport resilience
**Goal**: Remote MCP connections survive periodic SSE idle-closes without error-counting or full reconnects; keepalive cadence is transport-aware from a single source of truth; reconnects close the prior transport and guard against stale-generation callbacks
**Depends on**: —
**Requirements**: MCPX-01, MCPX-02, MCPX-03
**Success Criteria** (what must be TRUE):
  1. Five consecutive `"SSE stream disconnected: …"` errors (SDK self-heal) leave `consecutiveErrors` at zero and do not invoke `handleDisconnection`; a `"Maximum reconnection attempts … exceeded"` error escalates normally; a generic `McpError` also escalates (proves predicate is narrow)
  2. An http/sse transport with no per-server `keepaliveIntervalMs` override uses 30 000 ms; stdio uses 180 000 ms; both schema default (`schema-integrations.ts:208`) and factory fallback (`index.ts:170`) are removed — `pnpm validate` passes with zero cycles
  3. During reconnect, the prior `client.close()` is awaited before `createTransport` is called; a stale-generation `onerror`/`onclose` after a newer reconnect leaves the new connection's counter untouched; reconnect start is logged at INFO and per-attempt failure at WARN (not DEBUG)
**Plans**: 4 plans

Plans:
- [x] 04-01-PLAN.md — TDD RED: All MCPX-01/02/03 failing tests (mcp-client-reconnect.test.ts new + keepalive.test.ts + schema-integrations.test.ts additions)
- [x] 04-02-PLAN.md — GREEN MCPX-01 + MCPX-03: isSelfHealedTransientError predicate + generation guard + close-before-create + log levels (mcp-client-ticker.ts + mcp-client-reconnect.ts)
- [x] 04-03-PLAN.md — GREEN MCPX-02: resolveDefaultKeepaliveIntervalMs + remove both 180_000 defaults + schema optional + daemon wiring (mcp-client-keepalive.ts + types + index + schema + daemon)
- [x] 04-04-PLAN.md — GREEN MCPX-02/03: startKeepaliveTicker restart after reconnect via dynamic import (reconnectionLoop success block)

---

### Phase 5: SUBA — Sub-agent tool governance
**Goal**: A spawned sub-agent whose declared `required_tools` are unreachable fails at spawn time with an actionable error; "Tool not found" is enriched with delegation routing; the `gateway` denylist invariant is locked by a regression guard; `SUB_AGENT_TOOL_DENYLIST` lives in `@comis/core`
**Depends on**: —
**Requirements**: SUBA-01, SUBA-02, SUBA-03
**Success Criteria** (what must be TRUE):
  1. A spawn call with `required_tools: ["mcp_manage"]` under a `coding` profile fails immediately with a `RequiredToolsUnreachableError` — no `runId` returned, the sub-agent never starts, and the error message says "re-spawn with `tool_groups:['supervisor']`"
  2. A spawn call with `required_tools: ["gateway"]` fails immediately and the error message states the tool is "denied to ALL sub-agents — the parent must perform this step"
  3. `tool-policy.test.ts` contains a green-on-current invariant guard asserting no profile/group contains `gateway` AND `SUB_AGENT_TOOL_DENYLIST.has("gateway")` is true; `SUB_AGENT_TOOL_DENYLIST` is defined in `@comis/core` with no alias at the old daemon location; `pnpm cycles` passes
**Plans**: 3 plans

Plans:
- [x] 05-01-PLAN.md — TDD: Move SUB_AGENT_TOOL_DENYLIST to @comis/core + RequiredToolsUnreachableError + gateway invariant guard (SUBA-03)
- [x] 05-02-PLAN.md — TDD: pi-event-bridge enrichment for "Tool not found" with two-shape classifier (SUBA-02)
- [x] 05-03-PLAN.md — TDD: spawn() required_tools gate + SpawnParams field + RPC chain wiring (SUBA-01)

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. SEC — Secret-detection keystone | v1.1 | 2/2 | Complete   | 2026-05-26 |
| 2. STORE — Zero-config secrets store | v1.1 | 5/5 | Complete   | 2026-05-26 |
| 3. CRED — MCP credential firewall & lifecycle | v1.1 | 4/4 | Complete   | 2026-05-26 |
| 4. MCPX — MCP transport resilience | v1.1 | 4/4 | Complete   | 2026-05-26 |
| 5. SUBA — Sub-agent tool governance | v1.1 | 3/3 | Complete   | 2026-05-26 |

---

*Last updated: 2026-05-26 — Phase 5 planned (3 plans, 2 waves)*
