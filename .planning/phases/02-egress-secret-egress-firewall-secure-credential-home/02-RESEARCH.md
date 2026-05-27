# Phase 2: EGRESS — Secret Egress Firewall + Secure Credential Home - Research

**Researched:** 2026-05-27
**Domain:** Security hardening — egress control + credential store unification (brownfield)
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

All implementation choices are at Claude's discretion — discuss phase skipped (`workflow.skip_discuss=true`). Use the ROADMAP goal, success criteria, source plan, and codebase conventions.

**LOCKED constraints (NON-NEGOTIABLE, the verifier relies on these):**
- **R4 CYCLE TRAP:** `secret-egress-guard` lives in `@comis/core` and OWNS ITS OWN text scrubber over the R0 prefix list (the keystone's `PLAINTEXT_SECRET_PREFIXES` + `PREFIX_MIN_BODY_LENGTHS`, already in `@comis/core`). It must NOT import `redactSecretsInText` from `@comis/observability` — that inverts the one-way `core ← observability` graph and fails `pnpm cycles` + `architecture-graph.test.ts`. Run `pnpm cycles` + `no-cycles.test.ts` after EVERY cross-package move; NEVER add a `TARGET_GRAPH` edge to "fix" a cycle.
- **R8 ADAPTER LOCATION:** The MCP token-store adapter is constructed in `daemon` and injected via `oauthDeps.createTokenStore`. It must NEVER be built in `skills` (forbidden `skills → memory` edge). `skills` imports only the `OAuthCredentialStorePort` TYPE from `@comis/core`.
- **R8 NO AES-AT-REST this milestone:** AES conflicts with the chokidar disk-watch refresh (stale refresh-token → `invalid_grant`). P1 = one enforced `0600` home in the data dir, never the workspace. AES-at-rest deferred (R8-AES, P3). CONFIRM the chokidar watch survives the port wrapping.
- **Delivery scan placement:** ONE pass on assembled `deliveryText` BEFORE chunking, with a cheap combined-prefix pre-filter — NOT ~15 regexes per chunk per message fleet-wide. Verify `perf-budget.test.ts` baseline; add a large-message delivery case.

### Confirm-before-build (already exists — wire, don't rebuild)
- `core/security/secrets-audit.ts` ALREADY exists (`scanConfigForSecrets`/`auditSecrets`) — R4's audit-doctor check is wiring, not a new build. CONFIRMED.
- `env-substitution.ts` already covers env refs — R8's SecretRef adds only `file`/`exec` indirection. CONFIRMED: `secret-ref-resolver.ts` ALREADY resolves `file` and `exec` (lines 79–81). This is a wire-not-rebuild. The `SecretRef` domain type already defines `source: z.enum(["env", "file", "exec"])` (`secret-ref.ts:30`).

### Borrows (reference implementations)
- **OpenClaw** (not Hermes) for cross-origin redirect header scrubbing (13-header allowlist + 20-redirect cap) and the stdio env denylist (~90-key denylist on user-declared env).
- **Hermes** for the `needs_reauth` result + per-server circuit breaker.

### Deferred Ideas (OUT OF SCOPE)
- **R8-AES** (AES-at-rest for MCP tokens) — P3, deferred (conflicts with chokidar disk-watch refresh).
- **`SecretRef` `file`/`exec` indirection** — SecretRef domain type and resolver already support `file`/`exec` (`secret-ref.ts:30`, `secret-ref-resolver.ts:79-81`). The R8 requirement is to use the port-backed store; no new SecretRef source types need to be built. P2 concern flagged as deferred.
- **Parallel Ops workstream** (token revocation, `~/.comis/.git` history scrub, plaintext-artifact deletion, `daemon.log` rotation) — out of code scope.
- Out of scope: R2/R3/R9/R10 (Phase 3), R6 (Phase 4), R7 (Phase 5).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| R4 | No secret escapes via any agent-reachable egress. A shared `secret-egress-guard` (in `@comis/core`, NO import from observability) scans/redacts/redirects at: (1) write/edit tool (default `warn`+redirect, `security.writeSecretGuard: warn\|block\|off`); (2) sub-agent result relay + `persistFullResult`; (3) `DeliveryService.deliverToChannel` (one pass BEFORE chunking); (4) `validateMemoryWrite` (pre-persist, retiring `memory-store-tool.ts` divergent copy). `OutputGuard` bearer/`hf_` rule must REDACT. Plus: cross-origin MCP redirect header stripping, stdio env denylist, secrets-audit doctor wiring. | New module `packages/core/src/security/secret-egress-guard.ts` confirmed safe (intra-core). All 4 wiring points verified at file:line. `output-guard.ts:27` confirmed `severity:"warning"`. `memory-store-tool.ts` lines 19-31 divergent SECRET_PATTERNS confirmed. `deliverToChannel` scan point at line 193. `persistFullResult` at line 490, called at line 274. Redirect policy already has cross-host scrub. Stdio env already strips `NODE_OPTIONS`. `secrets-audit.ts` wiring confirmed. |
| R8 | Every agent-obtained credential lives in one enforced out-of-workspace home. MCP-server OAuth tokens backed by `OAuthCredentialStorePort`; adapter constructed in `daemon`, injected via `oauthDeps.createTokenStore`; `0600` in data dir, never workspace. Hand-rolled OAuth write blocked/redirected via R4 write-guard. MCP auth failure returns structured `needs_reauth` + per-server circuit breaker. Sub-agent relays `${ref}`/profileId, never raw token. Provider tokens default to `oauth.storage:"encrypted"`. | `OAuthCredentialStorePort` confirmed at `packages/core/src/ports/oauth-credential-store.ts:45`. `McpOAuthDeps.createTokenStore` seam confirmed at `mcp-client-types.ts:343` (optional field). `setup-mcp.ts` confirmed does NOT currently pass `oauthDeps` — this is the injection gap. `createTokenStore` in MCP client (`token-store.ts:220`) uses chokidar at lines 43-47, `0600` fchmod at line 302. Circuit breaker already exists in `mcp-client-call.ts:143-167`; `needs_reauth` structured result is NEW (currently only `needs_oauth_login` at connect time). |
</phase_requirements>

---

## Summary

Phase 2 closes two P1 security gaps that the v1.1 MCP Hardening missed: the four egress paths through which plaintext OAuth tokens actually leaked (write tool, sub-agent result relay+persist, delivery to Telegram, memory), and the structural absence of an enforced out-of-workspace credential home for MCP-server OAuth tokens.

Phase 1 (REGR) is COMPLETE, confirming the prerequisite state: `PLAINTEXT_SECRET_PREFIXES` now explicitly includes `hf_`/`hfr_`/`r8_` with `PREFIX_MIN_BODY_LENGTHS` gates at `packages/core/src/security/secret-detection.ts:54-111` — the keystone R4's new guard will build on. The `deliverToChannel` chokepoint (`packages/core/src/delivery/delivery-service.ts:168`) is verified: the right scan insertion point is line 193 (`let deliveryText = text;`), AFTER the empty-text early return (line 178) and BEFORE the `before_delivery` hook block. `persistFullResult` is defined at `result-condenser.ts:490`, called at line 274, writing raw `fullResult` to `~/.comis/subagent-results/<id>.json` — no scrubbing exists today.

For R8, the key finding is that `McpOAuthDeps.createTokenStore` is already an optional injectable seam in `McpClientManagerDeps` (`mcp-client-types.ts:343`), but `setup-mcp.ts` currently does NOT pass `oauthDeps` at all — the entire OAuth wiring is absent at the manager-construction level. The `oauthCredentialStore` (the unified `OAuthCredentialStorePort`) IS constructed in `setup-agents-registry.ts:351` and threaded through `singleAgentDeps` but has never been connected to the MCP client manager. The token store already satisfies `0600` (`token-store.ts:302`) and lives outside the workspace — the structural unification work is making the existing `TokenStore` implement `OAuthCredentialStorePort` and injecting it from `setup-mcp.ts`.

**Primary recommendation:** Build `secret-egress-guard.ts` in `@comis/core/security` first (new module, intra-core, no cycle risk), then fan the four wirings out in parallel. For R8, add `oauthCredentialStore` as a dep to `McpDeps` in `setup-mcp.ts`, pass it as `oauthDeps.createTokenStore`, and build the adapter mapping `TokenStore` shape → `OAuthCredentialStorePort` in `daemon` (never in `skills`).

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `secret-egress-guard` module | `@comis/core` | — | Core security primitive; no observability import allowed (would cycle). Intra-core. |
| Write/edit guard wiring | `@comis/skills` | — | `write-tool.ts`/`edit-tool.ts` own content validation. `skills → core` edge exists. |
| Sub-agent result scrub | `@comis/agent` | — | `result-condenser.ts` and `sub-agent-result-processor.ts` are intra-agent. `agent → core` edge exists. |
| `deliverToChannel` scan | `@comis/core` | — | `delivery-service.ts` is intra-core; no new edge needed. |
| `validateMemoryWrite` secret branch | `@comis/core` | — | `memory-write-validator.ts` is intra-core. |
| `OutputGuard` bearer→redact | `@comis/core` | — | `output-guard.ts` is intra-core. |
| Cross-origin redirect header scrub | `@comis/skills` | — | `mcp-client-redirect-policy.ts` (already exists in skills). **ALREADY IMPLEMENTED** — see below. |
| Stdio env interpreter denylist | `@comis/skills` | — | `mcp-client-discover.ts` + `mcp-prespawn-allowlist.test.ts`. **ALREADY IMPLEMENTED** — see below. |
| Secrets-audit doctor wiring | `@comis/cli` | `@comis/core` | `secrets-audit.ts` exists; `cli/src/doctor/checks/` houses the check. |
| MCP token-store adapter (port-backed) | `@comis/daemon` | — | Adapter must be constructed in daemon to avoid `skills → memory` forbidden edge. |
| `OAuthCredentialStorePort` (port type) | `@comis/core` | — | Already at `ports/oauth-credential-store.ts`. Port type only in `skills`. |
| `needs_reauth` + circuit breaker | `@comis/skills` | — | Intra-skills MCP client call path. Circuit breaker already exists; `needs_reauth` result is new. |
| Provider default `encrypted` storage | `@comis/core` config | `@comis/daemon` | Config schema default change in `core`; daemon selectOAuthCredentialStore honors it. |

---

## Standard Stack

### Core (no new dependencies — all verified present)

| Library | Version (installed) | Purpose | Notes |
|---------|---------------------|---------|----|
| `@comis/core/security/secret-detection` | in-repo | Keystone prefix list + `scanForSecrets` | Already has `hf_`/`hfr_`/`r8_` after Phase 1 |
| `@comis/core/ports/oauth-credential-store` | in-repo | `OAuthCredentialStorePort` + `OAuthProfile` | Port to unify MCP tokens onto |
| `@comis/skills/.../mcp-client/oauth/token-store` | in-repo | Existing `TokenStore` with chokidar watch + 0600 | Must implement port without removing disk-watch |
| `@comis/skills/.../mcp-client/mcp-client-redirect-policy` | in-repo | Cross-host redirect header scrub | **Already ships** — verify coverage vs OpenClaw 13-header list |
| `pino-abstract-transport@3.0.0` | installed | Not needed for Phase 2 (R1 is Phase 1) | — |

[VERIFIED: live codebase grep] All packages are in-repo; no new npm installs required.

---

## Architecture Patterns

### System Architecture Diagram (Phase 2 egress + credential flow)

```
[agent action: write / sub-agent result / memory / message delivery]
         │
         ├─ write/edit tool (skills/file-tools/)
         │    └─ secret-egress-guard.scanContent() ──► WARN + redirect to OAuthCredentialStorePort
         │
         ├─ result-condenser.ts:274 / sub-agent-result-processor.ts
         │    └─ secret-egress-guard.scrubSecretsFromText() ──► [REDACTED] before condense+persist+relay
         │
         ├─ DeliveryService.deliverToChannel() [SINGLE egress chokepoint]
         │    └─ line 193: ONE pre-hook scan ──► deliveryText scrubbed before format+chunk+send
         │         OutputGuard bearer/hf_ ──► severity critical (redact, not warn)
         │
         └─ validateMemoryWrite() [memory-write-validator.ts]
              └─ new secret branch ──► retire memory-store-tool.ts:19-31 copy
                                        pre-persist block on keystone match

[MCP OAuth token acquired]
         │
         ├─ BEFORE R8: skills token-store.ts ──► ~/.comis/mcp-tokens/<server>.json  (0600)
         │             but SEPARATE silo, not unified, not port-backed
         │
         └─ AFTER R8:  daemon/setup-mcp.ts builds port-backed adapter
                        injected as oauthDeps.createTokenStore into McpClientManager
                        skills creates TokenStore backed by OAuthCredentialStorePort
                        ~/.comis/mcp-tokens/ stays 0600, disk-watch PRESERVED
                        write-guard (R4) blocks any hand-rolled write to workspace/

[MCP auth failure (401 on tool call)]
         BEFORE R8: generic error surfaced, agent retries/improvises
         AFTER R8:  mcp-client-call.ts ──► structured `needs_reauth` result
                     + trips per-server circuit breaker (already exists at mcp-client-call.ts:143)
```

### Recommended Project Structure (new / changed files only)

```
packages/core/src/security/
├── secret-egress-guard.ts     # NEW: scrubSecretsFromText + guardEgress (R4)
├── secret-egress-guard.test.ts # NEW: RED tests
├── output-guard.ts             # MODIFIED: bearer_token severity warning → critical (line 27)
├── memory-write-validator.ts   # MODIFIED: add secret branch (line 50+)
packages/core/src/delivery/
└── delivery-service.ts         # MODIFIED: scan at line 193
packages/agent/src/spawn/
├── result-condenser.ts         # MODIFIED: scrub before condense (line 274) + persistFullResult (line 490)
└── sub-agent-result-processor.ts # MODIFIED: scrub before announce (line 345+)
packages/skills/src/tools/builtin/file-tools/
├── write-tool.ts               # MODIFIED: guard content scan
└── edit-tool.ts                # MODIFIED: guard content scan
packages/skills/src/platform-tools/tools/
└── memory-store-tool.ts        # MODIFIED: retire lines 19-31 in favor of validateMemoryWrite
packages/skills/src/skills/integrations/mcp-client/
├── mcp-client-call.ts          # MODIFIED: needs_reauth result on auth failure
└── oauth/token-store.ts        # MODIFIED: implement OAuthCredentialStorePort (adapter pattern)
packages/daemon/src/wiring/
└── setup-mcp.ts                # MODIFIED: pass oauthDeps.createTokenStore backed by store
packages/cli/src/doctor/checks/
└── secrets-audit.ts            # NEW: doctor check wiring (core/security/secrets-audit.ts exists)
```

### Pattern 1: Core-owned text scrubber over the shared prefix list

**What:** `secret-egress-guard.ts` in `@comis/core/security` owns its own fast text scrubber using `PLAINTEXT_SECRET_PREFIXES` + `PREFIX_MIN_BODY_LENGTHS` (already in core). It does NOT import `redactSecretsInText` from `@comis/observability`. Result: `core → shared` only — no new package edge, no cycle.

**Why:** The arch graph has `TARGET_GRAPH.core = {shared}` (architecture-graph.test.ts:102). Any `core → observability` import inverts the one-way `core ← observability ← infra` chain → `pnpm cycles` fails and `no-cycles.test.ts` fails. The log-pipeline path (R1, Phase 1) keeps using `redactSecretsInText` via the `infra → observability` edge. Two scrubbers sharing one vocabulary (R0 parity test guards drift) is the intentional design.

**Implementation sketch:**
```typescript
// packages/core/src/security/secret-egress-guard.ts
// Source: intra-core, no observability import
import { PLAINTEXT_SECRET_PREFIXES, PREFIX_MIN_BODY_LENGTHS, looksLikeSecretValue } from "./secret-detection.js";

export interface ScrubResult { text: string; redactions: number; }

/** Fast combined-prefix pre-filter: returns true if text MIGHT contain a secret. */
function mightContainSecret(text: string): boolean {
  // O(prefixes + text) single pass — gate before the expensive per-match loop
  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    if (text.includes(prefix)) return true;
  }
  return text.includes("Bearer ") || text.includes("Token ");
}

/** Scrub unstructured text of secret-shaped values. Called at delivery + relay + memory. */
export function scrubSecretsFromText(text: string): ScrubResult {
  if (!mightContainSecret(text)) return { text, redactions: 0 };
  // ... targeted replacement using PLAINTEXT_SECRET_PREFIXES + looksLikeSecretValue
}

/** Scan structured payload (tool args, object fields). Reuses core scanForSecrets. */
export { scanForSecrets as guardStructured } from "./secret-detection.js";
```

### Pattern 2: Delivery scan — one pass on `deliveryText`, pre-hook/pre-format

**What:** In `delivery-service.ts`, insert the scan at line 193 (`let deliveryText = text;`), immediately AFTER the empty-text early return (line 178-188) and BEFORE the `before_delivery` hook block. The variable `deliveryText` starts as `text` — scan it HERE, before it can be mutated by hooks.

**When:** Every call to `deliverToChannel`. The cheap pre-filter (`mightContainSecret`) makes the no-secret case a fast O(prefixes) scan; the full scrub only runs when a prefix is found.

```typescript
// packages/core/src/delivery/delivery-service.ts — insert after line 192
let deliveryText = text;
// R4: scan for secrets BEFORE hooks can see the raw text (and before chunking).
// One pass with cheap pre-filter — does not run the full regex battery on every message.
const { text: scrubbedText, redactions } = scrubSecretsFromText(deliveryText);
if (redactions > 0) {
  deps.logger.warn({ redactions, hint: "Secret found in outbound delivery text — redacted" }, "R4 egress guard: delivery text scrubbed");
  deliveryText = scrubbedText;
}
// rest of existing code continues with deliveryText
```

### Pattern 3: R8 adapter — `setup-mcp.ts` injection gap

**What:** `McpClientManagerDeps.oauthDeps` is optional (`mcp-client-types.ts:343`). `setup-mcp.ts` currently passes NO `oauthDeps` to `createMcpClientManager`. The fix adds `oauthCredentialStore: OAuthCredentialStorePort` to `McpDeps` (the setup-mcp.ts deps interface), builds a `TokenStore`-shaped adapter that delegates persistence to the port, and passes it as `oauthDeps.createTokenStore`.

**Critical:** The adapter must preserve the chokidar disk-watch (`token-store.ts:43-47`) — the P1 requirement is "one enforced `0600` home via the port," NOT AES encryption. The existing `createTokenStore` already does `0600` and chokidar. The adapter is a thin port-compliance wrapper, not a rewrite.

**Injection location:** `packages/daemon/src/wiring/setup-mcp.ts` — already has the `McpDeps` shape. Extend it with `oauthCredentialStore?: OAuthCredentialStorePort` and pass to `createMcpClientManager({..., oauthDeps: { createTokenStore: () => createPortBackedTokenStore(oauthStore, dataDir, logger) }})`.

**Why daemon, not skills:** `skills → memory` is forbidden in `TARGET_GRAPH.skills = {shared, core, observability}` (architecture-graph.test.ts:122). The adapter (which needs the `OAuthCredentialStorePort` value, not just the type) must live in `daemon`. The `oauthCredentialStore` value is already constructed and threaded in `setup-agents-registry.ts:351`.

### Anti-Patterns to Avoid

- **`core → observability` import for scrubbing:** Inverts the one-way graph. Core owns its own scrubber over the shared prefix list. [VERIFIED: arch test TARGET_GRAPH.core = {shared}]
- **MCP token store adapter in `skills`:** Requires `skills → memory` edge not in TARGET_GRAPH. Build in daemon.
- **Default `block` on write-guard:** High false-positive surface (entropy backstop fires on base64, hex, test fixtures). Default MUST be `warn`+redirect.
- **Scan INSIDE the chunk loop in `deliverToChannel`:** O(patterns × chars × chunks) on every outbound message. Scan once on `deliveryText` before the loop.
- **Removing chokidar watch from `token-store.ts` for R8:** Would break cross-process refresh-token rotation → `invalid_grant`. AES deferred to R8-AES (P3).
- **Importing `redactSecretsInText` into `secret-egress-guard.ts`:** Cycle. Use the core-owned scrubber pattern above.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Prefix-based text scrubbing in core | New regex set | `PLAINTEXT_SECRET_PREFIXES` + `PREFIX_MIN_BODY_LENGTHS` from `secret-detection.ts` | R0 parity test guards them; authoring a third matcher restarts the drift problem |
| Cross-origin redirect header stripping | New redirect handler | **`mcp-client-redirect-policy.ts`** (ALREADY EXISTS) | Already strips `Authorization`/`Cookie`/`Proxy-Authorization` on cross-host redirect, max 20 hops |
| Stdio env interpreter-control denylist | New env filter | **`scrubStdioEnv` in `mcp-client-discover.ts`** (ALREADY EXISTS) | Already strips `NODE_OPTIONS`; `mcp-prespawn-allowlist.test.ts` enforces allowlist membership |
| Per-server circuit breaker | New state machine | **Already in `mcp-client-call.ts:143-167`** | `circuitBreakers` Map, half-open probe, threshold+cooldown configurable |
| OAuth file `0600` storage | Custom file writer | **`createTokenStore` in `token-store.ts:220`** | Already does `O_EXCL + O_NOFOLLOW + fchmod 0600 + chokidar watch` |
| SecretRef `file`/`exec` resolution | New resolver | **`secret-ref-resolver.ts`** (ALREADY EXISTS, lines 79-81) | Resolves `env`, `file`, and `exec` sources with fs/child_process injection |
| Config secrets scanning | New scanner | **`secrets-audit.ts`** (ALREADY EXISTS, `scanConfigForSecrets`/`auditSecrets`) | Doctor check is wiring, not building |
| OAuthProfile persistence | Custom JSON store | **`createOAuthCredentialStoreFile` / `OAuthCredentialStorePort`** | Atomic write + fsync + cross-process lock + schema versioning |

---

## R4 Touch-Points — Verified File:Line

### 1. New module: `secret-egress-guard.ts`

- **Location:** `packages/core/src/security/secret-egress-guard.ts` — does NOT yet exist [VERIFIED: `ls packages/core/src/security/` shows no such file]
- **Exports needed:** `scrubSecretsFromText(text: string): ScrubResult`, `mightContainSecret(text: string): boolean` (used as pre-filter)
- **Must be added to:** `packages/core/src/security/index.ts` (re-export)
- **Cycle check:** intra-core, only imports from `./secret-detection.js` — SAFE [VERIFIED: TARGET_GRAPH.core = {shared}]
- **Existing test neighbor:** `secret-detection.test.ts` — add `secret-egress-guard.test.ts` alongside

### 2. Write/edit tool

- **File:** `packages/skills/src/tools/builtin/file-tools/write-tool.ts`
- **Confirmed:** zero `scanForSecrets` references today [VERIFIED: `grep -c scanForSecrets write-tool.ts` → 0]
- **Imports:** `safePath` from `@comis/core` already exists in write-tool (confirmed `skills → core` edge live)
- **Config knob:** `security.writeSecretGuard: "warn" | "block" | "off"` — default `"warn"`. Must add to config schema in `@comis/core/src/config/`.
- **Same wiring needed:** `packages/skills/src/tools/builtin/file-tools/edit-tool.ts`
- **Also fence:** workspace-adjacent credential paths (`~/.comis/mcp-tokens/`, `~/.comis/auth-profiles.json`, `~/.comis/secrets.db`) — use `safePath` check + `isCredentialHomePath` helper to block writes to these even when `writeSecretGuard: "off"`

### 3. Sub-agent result relay + `persistFullResult`

- **Files:**
  - `packages/agent/src/spawn/result-condenser.ts` — `persistFullResult` defined at line **490**, called at line **274** [VERIFIED]
  - `packages/agent/src/spawn/sub-agent-result-processor.ts` — `buildAnnouncementMessage` at line **345**, `deliverAnnouncement` at line **462** [VERIFIED]
- **Today:** `condenseInternal` at line 176 passes `fullResult` raw to `persistFullResult`. No scrubbing.
- **Fix:** Call `scrubSecretsFromText(fullResult)` at the top of `condenseInternal` (line 177), replacing `fullResult` in scope before it flows to `wrapAsSubagentResult` (line 195) and `persistFullResult` (line 274). Log at WARN with redaction count.
- **Secure handoff (R8 tie-in):** when a full-result contains a credential-shaped value that matches a recognized pattern, the sub-agent should relay a `${ref}` from the unified store instead. This is the "secure handoff" behavior; wiring it requires R8 store to exist first (build order: R4-core → R4-wirings → R8-store → R8-handoff).

### 4. `DeliveryService.deliverToChannel`

- **File:** `packages/core/src/delivery/delivery-service.ts`
- **Chokepoint confirmed:** `message-handlers.ts:236` AUDIT note routes ALL text→channel through here [VERIFIED: HIGGSFIELD-MCP-FIX-PLAN.md Appendix A]
- **Exact insertion point:** line **193** — `let deliveryText = text;` — AFTER empty-text early return (lines 178-188) and BEFORE the `before_delivery` hook block (lines 194-233) [VERIFIED: `sed -n '168,200p' delivery-service.ts`]
- **Scan `deliveryText`, NOT `formatted`:** `formatted` is assigned at line 238 (`formatted = formatForChannel(deliveryText, adapter.channelType)`) — scanning post-format risks HTML/markdown escaping obscuring the token.
- **Cheap pre-filter required:** `mightContainSecret(deliveryText)` gates the full `scrubSecretsFromText`. Most outbound messages contain no secret-shaped prefixes.
- **perf-budget.test.ts baseline:** `test/architecture/perf-budget.test.ts` validates the SHAPE of `perf-baseline.json`, not individual function perf [VERIFIED: grep of test file]. The test will NOT auto-fail on the scan addition — but add a large-message delivery unit test that asserts the scan completes in <5ms (the real performance guard).

### 5. `OutputGuard` bearer/`hf_` upgrade

- **File:** `packages/core/src/security/output-guard.ts`
- **Line 27 (VERIFIED):** `{ name: "bearer_token", regex: BEARER_TOKEN, severity: "warning" }` — must change to `"critical"`
- **Missing `hf_` pattern:** `SECRET_PATTERNS` at lines 25-41 has no `hf_`-specific entry; it will be caught if `BEARER_TOKEN` regex matches `Bearer hf_…`, but bare `hf_…` without `Bearer` is NOT caught. Add `{ name: "hf_token", regex: /\bhf_[A-Za-z0-9_]{18,}\b/, severity: "critical" }` per the keystone's `PREFIX_MIN_BODY_LENGTHS["hf_"] = 18`.
- **OutputGuard behavior (VERIFIED):** `critical` findings are redacted in `sanitized` string (line 73); `warning` findings are detect-only (line 58-60 comment confirms). Changing `bearer_token` to `"critical"` makes it redact, not just detect.

### 6. `validateMemoryWrite` + `memory-store-tool.ts` divergent copy

- **Validator file:** `packages/core/src/security/memory-write-validator.ts`
- **Line 50:** `export function validateMemoryWrite(content: string): MemoryWriteValidationResult` — today scans only for injection patterns (`DANGEROUS_COMMAND_PATTERNS`), NOT secrets [VERIFIED: grep of file]
- **Divergent copy:** `packages/skills/src/platform-tools/tools/memory-store-tool.ts` lines **19-31** — a private `SECRET_PATTERNS` array of 8 patterns (Google, OpenAI, Groq, GitHub, Tavily, xAI) that MISSES `hf_`, runs AFTER persistence (line 70+), and is not maintained with the keystone [VERIFIED]
- **Fix:** Add a `secret-scan` branch to `validateMemoryWrite` using `scrubSecretsFromText` from the new guard. Delete lines 19-31 from `memory-store-tool.ts` and use `validateMemoryWrite` as the single check (which callers already use per AGENTS.md §2.2).
- **Test file:** `packages/core/src/security/memory-write-validator.test.ts` exists — extend it with token-bearing content RED tests.

### 7. Transport + audit hardening

**Cross-origin redirect header scrubbing:**
- **ALREADY IMPLEMENTED** in `packages/skills/src/skills/integrations/mcp-client/mcp-client-redirect-policy.ts` [VERIFIED: file confirmed]
- Strips `Authorization`/`Cookie`/`Proxy-Authorization` on cross-host redirect (URL.host mismatch), max 20 hops [VERIFIED: file header + grep]
- **Action for R4:** VERIFY the header scrub list covers the OpenClaw 13-header allowlist. The current implementation scrubs 3 headers on cross-host redirect. OpenClaw's allowlist is broader — check if additional sensitive headers (`X-Auth-Token`, `X-API-Key`, etc.) should be added. This is a small verification + possible expansion, not a rebuild.

**Stdio env interpreter-control denylist:**
- **ALREADY IMPLEMENTED** in `packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.ts` [VERIFIED]
- `NODE_OPTIONS` is already stripped via `env -u NODE_OPTIONS` at line 179 [VERIFIED]
- `PYTHONIOENCODING`/`PYTHONPATH` are in `REQUIRED_ALLOWLIST_MEMBERS` (allowed, not denied) per `mcp-prespawn-allowlist.test.ts:36` [VERIFIED]
- **Key gap:** `PYTHONSTARTUP`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`, `PERL5OPT`, `BASH_ENV`, `ENV`, `CDPATH` — interpreter-control injection vectors — are NOT in the allowlist (only `PYTHONIOENCODING`/`PYTHONPATH` for uvx-launched servers). They are also NOT in the dangerous-credential denylist. Since these keys are NOT in the allowlist and the env scrub is allowlist-based (pass only what's allowed), they are ALREADY effectively denied. **Action:** Verify by reading `buildStdioEnv` in `mcp-client-discover.ts` — if it uses allowlist-only logic, interpreter-control vars are denied by omission. Add a test asserting they're absent from the scrubbed env.

**Secrets-audit doctor wiring:**
- `packages/core/src/security/secrets-audit.ts` EXISTS with `scanConfigForSecrets` and `auditSecrets` [VERIFIED: `grep -n "export function" secrets-audit.ts`]
- `packages/cli/src/doctor/checks/` has 5 existing checks: `channel-health`, `config-health`, `daemon-health`, `gateway-health`, `oauth-health`, `workspace-health` [VERIFIED]
- **Action:** Add `packages/cli/src/doctor/checks/secrets-audit-health.ts` that calls `auditSecrets()` with the config paths from `DoctorContext` and maps `AuditFinding[]` to `DoctorFinding[]`. Wire into `check-runner.ts`. Follow the pattern of `oauth-health.ts`.

---

## R8 Touch-Points — Verified File:Line

### 1. `OAuthCredentialStorePort` — the target port

- **File:** `packages/core/src/ports/oauth-credential-store.ts` [VERIFIED]
- **Interface line 45:** `export interface OAuthCredentialStorePort { get, set, list }` [VERIFIED]
- **`OAuthProfile` line 14:** `{ provider, profileId, access, refresh, expires, ... }` — `access`/`refresh` annotated "NEVER log this value" at lines 19/21 [VERIFIED]
- **`skills` may only import the TYPE**, not the value (per locked R8 adapter constraint)

### 2. `McpOAuthDeps` — the injection seam

- **File:** `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts`
- **Line 351:** `export interface McpOAuthDeps { createTokenStore: () => TokenStore; resolveDiscovery: ...; openUrl?: ... }` [VERIFIED]
- **Line 343 in `McpClientManagerDeps`:** `readonly oauthDeps?: McpOAuthDeps` — OPTIONAL, currently not passed by `setup-mcp.ts` [VERIFIED]
- **Seam usage:** `mcp-client-oauth-connect.ts:80` — `const tokenStore = oauthDeps.createTokenStore()` [VERIFIED]

### 3. `createTokenStore` — existing MCP token store

- **File:** `packages/skills/src/skills/integrations/mcp-client/oauth/token-store.ts`
- **Function line 220:** `export function createTokenStore(deps: TokenStoreDeps): TokenStore` [VERIFIED]
- **Chokidar disk-watch:** lines 43-47 (design doc), lines 352-464 (implementation) — watches `~/.comis/mcp-tokens/` dir, `atomic:100`, 100ms debounce [VERIFIED]
- **`0600` fchmod:** line 302 — `fchmod`s unconditionally on every write [VERIFIED]
- **Current storage path:** `~/.comis/mcp-tokens/<serverName>.{json,client.json,meta.json}` — 3 files per server [VERIFIED: file header]
- **CONFIRMED not workspace:** base dir is under data dir (`~/.comis/mcp-tokens/`), NOT workspace — satisfies the P1 `0600`+out-of-workspace requirement already

### 4. The injection gap: `setup-mcp.ts` passes NO `oauthDeps`

- **File:** `packages/daemon/src/wiring/setup-mcp.ts`
- **Current `McpDeps` interface (lines 22-46):** No `oauthCredentialStore` field and no `oauthDeps` field [VERIFIED: full file read]
- **`createMcpClientManager` call (line 132):** Does NOT pass `oauthDeps` [VERIFIED: `sed -n '120,170p' setup-mcp.ts`]
- **Fix:** Add `oauthCredentialStore?: OAuthCredentialStorePort` to `McpDeps`, build `createPortBackedMcpTokenStore(store, dataDir, logger)` adapter in daemon wiring, pass as `oauthDeps: { createTokenStore: () => createPortBackedMcpTokenStore(oauthCredentialStore, ...) }`.
- **Where `oauthCredentialStore` comes from:** `setup-agents-registry.ts:351` constructs it via `selectOAuthCredentialStore(...)` [VERIFIED]. It must be threaded to `setupMcp` in `daemon.ts`.

### 5. `needs_reauth` structured result — NEW (currently `needs_oauth_login` at connect only)

- **Current state (VERIFIED):** `needs_oauth_login` (`mcp-client-oauth-connect.ts:45`) surfaces on CONNECT failure when no token store is wired. `mcp-client-call.ts` already has a per-server circuit breaker (lines 143-167) but does NOT return a `needs_reauth` structured result on 401 during tool call — it surfaces `server_unavailable` when the breaker is open (line 167).
- **Gap:** No `needs_reauth` result exists for call-time auth failure. The circuit breaker exists but its open-state message is `[server_unavailable]`, not `[needs_reauth]`.
- **Fix location:** `mcp-client-call.ts` — when a tool call returns a 401 (or `UnauthorizedError`), return a structured result: `[needs_reauth] MCP server "<name>" requires re-authentication — run \`comis mcp login <name>\`. Do NOT retry this tool.` AND trip the circuit breaker at this point. This mirrors Hermes `mcp_tool.py:1925` (`tools/mcp_tool.py:1925`).
- **Existing test to extend:** `packages/skills/src/skills/integrations/mcp-client/mcp-client-connect.test.ts` (has `needs_oauth_login` test at line 164) — add parallel test for call-time `needs_reauth`.

### 6. `OAuthProfile` ↔ MCP token shape mapping

The MCP `TokenStore` stores 3 files per server: `<server>.json` (tokens: `access_token`, `refresh_token`, `expires_at`), `.client.json` (DCR client credentials), `.meta.json` (discovery state). `OAuthProfile` is flat: `{ provider, profileId, access, refresh, expires }`.

The port-backed adapter needs a mapping strategy:
- `access` ← `access_token`, `refresh` ← `refresh_token`, `expires` ← `expires_at` (Unix ms)
- `provider` = `"mcp-oauth"`, `profileId` = `"mcp-oauth:<serverName>"`
- `.client.json` and `.meta.json` are NOT part of `OAuthProfile` — they stay as sidecar files managed by `createTokenStore` directly. The adapter passes through the token triple to the port, keeping `.client.json`/`.meta.json` in the existing file store.

This is the "two OAuth subsystems, Risk Med" noted in the source plan. The adapter is non-trivial but bounded: it only maps the token triple; client+discovery sidecars stay in the existing `TokenStore` files.

### 7. Chokidar watch survival verification

- `createTokenStore` starts the chokidar watch via `tokenStore.startWatch()` (`token-store.ts:189-196`), called at connect time in `mcp-client-oauth-connect.ts`
- The port-backed adapter MUST either: (a) delegate `startWatch`/`stopWatch` to the underlying `createTokenStore` (keep the same `TokenStore` interface intact, wrap it rather than replacing it), OR (b) preserve the watch in a separate layer
- **Recommended:** wrap approach — the adapter constructs the underlying `createTokenStore`, delegates all `TokenStore` methods including `startWatch`/`stopWatch`, and additionally syncs to `OAuthCredentialStorePort` on writes. The `OAuthCredentialStorePort` becomes the persistence backend for the token triple; the chokidar watch + cache stay intact.

### 8. Provider tokens — default `oauth.storage: "encrypted"`

- **Config file:** `packages/core/src/config/` — find `oauth.storage` default
- **Current default:** `"file"` (or needs verification) — change to `"encrypted"` so provider tokens (Codex/Claude-Max) use AES-at-rest via the auto-initialized Phase 1 `secrets.db`
- **Does NOT affect MCP tokens** (which stay `0600` file-backed per no-AES constraint)
- Note: this is a one-line config default change in the schema; `selectOAuthCredentialStore` already handles both modes.

---

## Common Pitfalls

### Pitfall 1: `core → observability` cycle when implementing `scrubSecretsFromText`

**What goes wrong:** Developer reaches for `redactSecretsInText` from observability inside `secret-egress-guard.ts` — instant cycle.
**Root cause:** `redactSecretsInText` lives in `@comis/observability`, and `core` is architecturally downstream of `observability`. `TARGET_GRAPH.core = {shared}`.
**How to avoid:** Core's text scrubber re-implements the scrub loop using `PLAINTEXT_SECRET_PREFIXES` + `PREFIX_MIN_BODY_LENGTHS` (both already in core's `secret-detection.ts`). Short, simple loop — not a duplication of the full observability regex engine.
**Warning signs:** Any `import.*from "@comis/observability"` inside `packages/core/src/`.

### Pitfall 2: Delivery scan inside the chunk loop

**What goes wrong:** Scan placed inside the `for (let i = 0; i < chunks.length; i++)` block in `deliverToChannel` — O(patterns × chars) × chunks on every outgoing message.
**How to avoid:** Scan at line 193 (`let deliveryText = text;`), BEFORE `formatForChannel` and the chunk loop. One pass, one call.
**Warning signs:** Scan function call inside any loop body in `delivery-service.ts`.

### Pitfall 3: MCP token adapter in `skills` (forbidden `skills → memory` edge)

**What goes wrong:** Adapter built inside `token-store.ts` or any skills file that imports the memory package for store implementation.
**How to avoid:** Adapter lives in `packages/daemon/src/wiring/` (e.g., `mcp-token-port-adapter.ts`). Skills only imports the `OAuthCredentialStorePort` TYPE (type-only import, no runtime edge).
**Warning signs:** `import { createOAuthCredentialStoreFile } from "@comis/memory"` inside any `packages/skills/src/` file.

### Pitfall 4: Removing or disabling the chokidar watch for "simplicity"

**What goes wrong:** Chokidar watch removed from `createTokenStore` when wrapping it — cross-process refresh rotation stops being picked up, daemon refreshes a stale refresh token, provider's `invalid_grant` nukes the refresh chain.
**How to avoid:** Wrap the existing `createTokenStore` rather than replacing it. Keep `startWatch()`/`stopWatch()` on the adapter interface. Never disable `watchPersistent`.
**Warning signs:** `chokidar` import removed from `token-store.ts`; `startWatch` not called from the adapter path.

### Pitfall 5: Write-guard defaults to `block`

**What goes wrong:** Hard-blocking on secret detection in write/edit tools breaks legitimate writes: `.env.example`, test fixtures with fake tokens, 64-char git SHAs, base64 image data.
**How to avoid:** Default `security.writeSecretGuard: "warn"`. The config knob allows `"block"` for opt-in high-security deployments. Write negative-control tests (`.example`, fake `sk-`, 64-hex SHA, `${VAR}` refs) that must NOT block under the default.
**Warning signs:** Tool result shows `[blocked]` on a write with a fake token in a `.example` file.

### Pitfall 6: `needs_reauth` only at connect time, not call time

**What goes wrong:** R8's `needs_reauth` is wired only for the connect path (already exists as `needs_oauth_login`) but not for call-time 401s — agent retries tool calls and eventually improvises.
**How to avoid:** `mcp-client-call.ts` must intercept 401 responses and return the structured `needs_reauth` result with the "Do NOT retry" instruction. Wire with the existing circuit breaker so the breaker trips on 401 and the breaker's open-state also returns `needs_reauth` (not `server_unavailable`).

---

## Code Examples

### `secret-egress-guard.ts` — intra-core text scrubber (no observability import)

```typescript
// packages/core/src/security/secret-egress-guard.ts
// [VERIFIED: intra-core pattern, no observability import needed]
import { PLAINTEXT_SECRET_PREFIXES, PREFIX_MIN_BODY_LENGTHS, looksLikeSecretValue } from "./secret-detection.js";

export interface ScrubResult { text: string; redactions: number; }

const REDACTED = "[REDACTED]";

// Fast O(prefixes) pre-filter — prevents full scan on common secret-free text
export function mightContainSecret(text: string): boolean {
  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    if (text.includes(prefix)) return true;
  }
  return text.includes("Bearer ") || text.includes("Token ");
}

export function scrubSecretsFromText(text: string): ScrubResult {
  if (!mightContainSecret(text)) return { text, redactions: 0 };
  let result = text;
  let redactions = 0;
  // For each prefix, find and replace token-shaped runs
  for (const prefix of PLAINTEXT_SECRET_PREFIXES) {
    const minBody = PREFIX_MIN_BODY_LENGTHS.get(prefix) ?? 0;
    const pattern = new RegExp(`\\b${escapeRegex(prefix)}[A-Za-z0-9_\\-]{${minBody},}\\b`, "g");
    const replaced = result.replace(pattern, () => { redactions++; return REDACTED; });
    result = replaced;
  }
  // Also strip bare Bearer/Token schemes
  const bearerPattern = /Bearer\s+[A-Za-z0-9_\-.]{20,}/g;
  result = result.replace(bearerPattern, () => { redactions++; return `Bearer ${REDACTED}`; });
  return { text: result, redactions };
}
```

### `output-guard.ts` — change `bearer_token` severity to `critical`, add `hf_token`

```typescript
// packages/core/src/security/output-guard.ts — lines 25-40 (VERIFIED current state)
// Change: severity "warning" → "critical" for bearer_token (line 27)
// Add: hf_token pattern (currently absent — bare hf_ not caught without Bearer prefix)
{ name: "bearer_token", regex: BEARER_TOKEN, severity: "critical" },  // was "warning"
{ name: "hf_token", regex: /\bhf_[A-Za-z0-9_]{18,}\b/, severity: "critical" },  // NEW
```

### `deliverToChannel` scan insertion

```typescript
// packages/core/src/delivery/delivery-service.ts
// Insert AFTER line 192 (the empty-text early return block ends at line 188)
// BEFORE line 193 (let deliveryText = text;)

// Source: existing pattern + R4 requirement
let deliveryText = text;
const egressScrub = scrubSecretsFromText(deliveryText);  // cheap pre-filter inside
if (egressScrub.redactions > 0) {
  deliveryText = egressScrub.text;
  deps.logger.warn(
    { redactions: egressScrub.redactions, channelType: adapter.channelType,
      hint: "Secret detected in outbound delivery text — redacted before send", errorKind: "internal" as const },
    "R4 egress guard: delivery text redacted",
  );
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `bearer_token` detect-only (`output-guard.ts:27`) | Will become redact (severity: `"critical"`) | Phase 2 | Bearer tokens no longer delivered to channels |
| MCP tokens in separate silo (`~/.comis/mcp-tokens/`) | MCP tokens behind `OAuthCredentialStorePort` (same port as providers) | Phase 2 | One enforced credential home; port-backed |
| Sub-agent `fullResult` persisted raw | `fullResult` scrubbed before condense and persist | Phase 2 | `~/.comis/subagent-results/*.json` never contains plaintext tokens |
| Memory store secret check: 8-pattern copy in `memory-store-tool.ts` | `validateMemoryWrite` with guard from keystone | Phase 2 | Single detection source; `hf_`/`hfr_` covered |
| MCP auth failure: generic error + agent retries | `needs_reauth` structured result + circuit breaker on 401 | Phase 2 | Agent steered to `comis mcp login`, stops improvising |

**Deprecated/outdated:**
- `memory-store-tool.ts` lines 19-31 (private `SECRET_PATTERNS` array): retired in favor of `validateMemoryWrite` + keystone

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `secret-ref-resolver.ts` `file`/`exec` sources are already production-grade (fully tested); R8 SecretRef extension is a wire-not-build | Deferred Ideas | If file/exec paths are stub-only, planning must add test coverage — but the types confirm full implementation |
| A2 | The `OAuthProfile.access/refresh/expires` triple is sufficient to reconstruct MCP token state for `OAuthCredentialStorePort.set()` — `.client.json` and `.meta.json` sidecars are managed separately by the existing `createTokenStore` and do NOT need to go through the port | R8 adapter mapping | If `.client.json`/`.meta.json` MUST flow through the port, the adapter schema is more complex |
| A3 | `oauth.storage` default is currently `"file"` (not `"encrypted"`) — changing to `"encrypted"` is the new default for provider tokens | R8 provider default | If already `"encrypted"` by default, this is a no-op (good) |

---

## Open Questions (RESOLVED)

1. **Header allowlist gap for cross-origin redirect scrubbing**
   - What we know: `mcp-client-redirect-policy.ts` strips `Authorization`/`Cookie`/`Proxy-Authorization` on cross-host redirect (3 headers)
   - What's unclear: OpenClaw's allowlist has 13 headers — does comis need to add `X-Auth-Token`, `X-API-Key`, `X-Authorization`, `Authorization-Token`, etc.?
   - Recommendation: During plan Wave 1 (R4-core), read `mcp-client-redirect-policy.ts` fully and compare against OpenClaw's `src/agents/mcp-transport.ts:145` header list. Expand if significant gaps exist.
   - **RESOLVED:** Plan 02-03 expands the cross-origin redirect header scrub list to cover the full OpenClaw 13-header allowlist (verifying coverage and extending `mcp-client-redirect-policy.ts` if gaps exist against `X-Auth-Token`, `X-API-Key`, etc.).

2. **`oauth.storage` config schema default location**
   - What we know: `selectOAuthCredentialStore` uses `storage: OAuthStorageMode` from config; the value comes from `container.config.oauth.storage`
   - What's unclear: Which `schema-*.ts` file defines `oauth.storage` and what its current `.default()` is
   - Recommendation: Before writing the provider-default task, grep `schema-oauth\|oauth.*storage\|storage.*default` in `packages/core/src/config/`. Trivial to find; one-line change.
   - **RESOLVED:** Plan 02-04 Task 2 locates `oauth.storage` in `packages/core/src/config/schema-oauth.ts` and changes its default to `"encrypted"` (provider tokens default to AES-at-rest via Phase 1 `secrets.db`).

3. **`scrubStdioEnv` and `PYTHONSTARTUP` / `RUBYOPT` coverage**
   - What we know: `mcp-client-discover.ts` uses an allowlist-only approach (only allowed keys pass through); `NODE_OPTIONS` is stripped via `env -u`; `PYTHONSTARTUP`/`RUBYOPT`/`BASH_ENV` are NOT in the allowlist so they're already denied
   - What's unclear: Whether the R4 success criterion requires an explicit TEST asserting these keys are absent, or whether the existing `mcp-prespawn-allowlist.test.ts` negative controls are sufficient
   - Recommendation: The existing test at line 65-68 (`dangerous credential keys NOT in allowlist`) covers only API keys. Add assertions that interpreter-control vars (`PYTHONSTARTUP`, `RUBYOPT`, `BASH_ENV`, `JAVA_TOOL_OPTIONS`) are absent from `scrubStdioEnv({})` output. Small targeted test addition.
   - **RESOLVED:** Plan 02-03 extends `mcp-prespawn-allowlist.test.ts` with explicit assertions that `PYTHONSTARTUP`, `RUBYOPT`, `BASH_ENV`, and `JAVA_TOOL_OPTIONS` are absent from the `scrubStdioEnv` output (allowlist-only logic already denies them; test makes this explicit).

---

## Environment Availability

Step 2.6: SKIPPED — Phase 2 is code/config changes only; all required APIs are in-repo or already-installed packages. No new npm installs. No external services required for the code changes.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (workspace config) |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `pnpm vitest run packages/core/src/security/secret-egress-guard.test.ts` |
| Full suite command | `pnpm validate` (= `pnpm build && pnpm test && pnpm lint:security && pnpm cycles`) |
| Cycles check | `pnpm cycles` (madge dist-mode) + `vitest run test/architecture/no-cycles.test.ts` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| R4-guard | `scrubSecretsFromText("Bearer hf_" + "a".repeat(44))` returns `[REDACTED]` | unit | `pnpm vitest run packages/core/src/security/secret-egress-guard.test.ts` | ❌ Wave 0 |
| R4-guard | `mightContainSecret(plainText)` returns false for text with no secret prefix | unit | same | ❌ Wave 0 |
| R4-guard | `scrubSecretsFromText` reuses keystone prefixes (no observability import) | architecture | `pnpm vitest run test/architecture/no-cycles.test.ts` | ✅ (checks cycles) |
| R4-write | `write-tool.ts` body with `Bearer hf_<44+>` → tool result contains `[warn]` + redirect hint | unit | `pnpm vitest run packages/skills/src/tools/builtin/file-tools/write-tool.test.ts` | ✅ (extend) |
| R4-write | `.env.example` with `API_KEY=${API_KEY}` → NOT warned under default `warn` | unit | same | ✅ (extend) |
| R4-write | 64-char hex SHA → NOT warned | unit | same | ✅ (extend) |
| R4-relay | `condenseInternal` with token in `fullResult` → `persistFullResult` receives `[REDACTED]` | unit | `pnpm vitest run packages/agent/src/spawn/result-condenser.test.ts` | ✅ (extend) |
| R4-relay | `buildAnnouncementMessage` with token → announcement text contains `[REDACTED]` | unit | `pnpm vitest run packages/agent/src/spawn/sub-agent-result-processor.test.ts` | ✅ (extend) |
| R4-delivery | `deliverToChannel` with `Bearer hf_<44+>` → adapter receives `[REDACTED]` (Telegram + Discord) | unit | `pnpm vitest run packages/core/src/delivery/delivery-service.test.ts` | ✅ (extend) |
| R4-delivery | `deliverToChannel` scan is above the chunk loop (perf guard) + large message < 5ms | unit | same | ❌ Wave 0 (new perf assertion) |
| R4-memory | `validateMemoryWrite` with token → `critical` result, blocked | unit | `pnpm vitest run packages/core/src/security/memory-write-validator.test.ts` | ✅ (extend) |
| R4-memory | `memory-store-tool.ts` uses `validateMemoryWrite` (no private `SECRET_PATTERNS`) | unit | `pnpm vitest run packages/skills/src/platform-tools/tools/memory-store-tool.test.ts` | ✅ (extend) |
| R4-output-guard | `OutputGuard` bearer/`hf_` rule → `sanitized` has `[REDACTED]`, not the raw token | unit | `pnpm vitest run packages/core/src/security/output-guard.test.ts` | ✅ (extend) |
| R4-redirect | Cross-origin redirect strips `Authorization` header | unit | `mcp-client-redirect-policy.test.ts` | ✅ (verify/extend) |
| R4-env | `scrubStdioEnv` → `PYTHONSTARTUP`, `RUBYOPT`, `BASH_ENV` absent from result | unit | `pnpm vitest run test/architecture/mcp-prespawn-allowlist.test.ts` | ✅ (extend) |
| R4-doctor | `comis doctor` runs `auditSecrets()` check, returns findings | unit | `pnpm vitest run packages/cli/src/doctor/checks/secrets-audit-health.test.ts` | ❌ Wave 0 |
| R8-store | MCP OAuth token persisted to unified `OAuthCredentialStorePort`, absent from workspace | unit | `pnpm vitest run packages/skills/src/skills/integrations/mcp-client/oauth/token-store.test.ts` | ✅ (extend) |
| R8-store | MCP token store chokidar watch NOT disabled after port wrapping | unit | same | ✅ (extend) |
| R8-reauth | MCP tool call 401 → returns structured `needs_reauth` result, NOT generic error | unit | `pnpm vitest run packages/skills/src/skills/integrations/mcp-client/mcp-client-call.test.ts` | ✅ (extend) |
| R8-reauth | Circuit breaker trips on 401 → subsequent calls return `needs_reauth` (open state) | unit | same | ✅ (extend) |
| R8-handoff | Sub-agent result with credential → relays `${ref}`, not raw token | unit | `result-condenser.test.ts` (extend) | ✅ (extend) |
| CYCLES | No `core → observability` edge after Phase 2 | architecture | `pnpm cycles && pnpm vitest run test/architecture/no-cycles.test.ts` | ✅ |

### Sampling Rate

- **Per task commit:** `pnpm vitest run <changed-test-file>` + `pnpm vitest run test/architecture/no-cycles.test.ts`
- **Per wave merge:** `pnpm test` (full unit suite)
- **Phase gate:** `pnpm validate` (build + test + lint:security + cycles) green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/core/src/security/secret-egress-guard.test.ts` — RED tests for `scrubSecretsFromText` and `mightContainSecret`
- [ ] `packages/cli/src/doctor/checks/secrets-audit-health.test.ts` — RED tests for doctor check wiring
- [ ] Large-message delivery perf assertion in `delivery-service.test.ts` — asserts scan < 5ms on 10k-char message

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `needs_reauth` result + circuit breaker (R8); `OAuthCredentialStorePort` for token persistence |
| V3 Session Management | no | Out of scope for Phase 2 |
| V4 Access Control | yes | Write-guard blocks credential writes to workspace; `0600` data-dir home enforced |
| V5 Input Validation | yes | `scrubSecretsFromText` guards all four egress paths before data reaches channels/disk |
| V6 Cryptography | partial | Provider tokens default to AES-at-rest (`oauth.storage: "encrypted"`); MCP tokens `0600` file (no AES this milestone, R8-AES deferred) |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Token in sub-agent result relayed to parent + channel | Information Disclosure | `scrubSecretsFromText` before `announceToParent`/`sendToChannel` (R4 #2) |
| Token written to workspace file by agent | Information Disclosure | `write-guard` WARN+redirect; workspace-adjacent credential paths fenced (R4 #1) |
| Token delivered via `deliverToChannel` to chat platform | Information Disclosure | One-pass scan on `deliveryText` before format+chunk (R4 #3) |
| Token persisted to memory store | Information Disclosure | `validateMemoryWrite` secret branch pre-persist (R4 #4) |
| Hand-rolled OAuth → workspace file (the incident root) | Elevation of Privilege | R4 write-guard + R8 unified store enforce the secure path |
| 401 on MCP tool call → agent retries/improvises OAuth | Spoofing/Elevation | `needs_reauth` structured result + per-server circuit breaker stops retry loop (R8) |
| Cross-origin MCP redirect carries `Authorization` to attacker server | Information Disclosure | `createRedirectPolicyFetch` strips `Authorization`/`Cookie`/`Proxy-Authorization` — already deployed |
| Stdio MCP child inherits `NODE_OPTIONS`/`PYTHONSTARTUP` for code injection | Tampering | Allowlist-only env scrub in `buildStdioEnv`; `NODE_OPTIONS` explicitly stripped — already deployed |

---

## Sources

### Primary (HIGH confidence)

- `packages/core/src/security/secret-detection.ts:51-111` — Phase 1 complete: `hf_`/`hfr_`/`r8_` in `PLAINTEXT_SECRET_PREFIXES` with `PREFIX_MIN_BODY_LENGTHS` [VERIFIED in session]
- `packages/core/src/security/output-guard.ts:25-41` — `bearer_token` at `severity:"warning"`, no `hf_` entry [VERIFIED in session]
- `packages/core/src/delivery/delivery-service.ts:168-240` — `deliverToChannel` empty-text guard at 178, scan insertion point at 193 [VERIFIED in session]
- `packages/agent/src/spawn/result-condenser.ts:274,490` — `persistFullResult` sites [VERIFIED in session]
- `packages/agent/src/spawn/sub-agent-result-processor.ts:345,462` — `buildAnnouncementMessage`, `deliverAnnouncement` [VERIFIED in session]
- `packages/core/src/security/memory-write-validator.ts:50` — no secret scanning today [VERIFIED in session]
- `packages/skills/src/platform-tools/tools/memory-store-tool.ts:19-31` — divergent `SECRET_PATTERNS` confirmed [VERIFIED in session]
- `packages/core/src/ports/oauth-credential-store.ts:14,45` — `OAuthProfile`, `OAuthCredentialStorePort` [VERIFIED in session]
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts:343,351` — `oauthDeps?: McpOAuthDeps` optional, `McpOAuthDeps.createTokenStore` seam [VERIFIED in session]
- `packages/skills/src/skills/integrations/mcp-client/oauth/token-store.ts:43-47,220,302` — chokidar watch, `createTokenStore` entry, `0600` fchmod [VERIFIED in session]
- `packages/daemon/src/wiring/setup-mcp.ts:22-46,132` — NO `oauthDeps` passed today [VERIFIED in session]
- `packages/daemon/src/wiring/setup-agents/setup-agents-registry.ts:351` — `oauthCredentialStore` constructed here [VERIFIED in session]
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-redirect-policy.ts` — cross-host redirect header scrub ALREADY IMPLEMENTED [VERIFIED in session]
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.ts:158-179` — `NODE_OPTIONS` stripped, allowlist-only env scrub ALREADY IMPLEMENTED [VERIFIED in session]
- `test/architecture/mcp-prespawn-allowlist.test.ts:22,36` — `scrubStdioEnv` exported, `PYTHONIOENCODING`/`PYTHONPATH` allowed [VERIFIED in session]
- `packages/core/src/security/secrets-audit.ts:110,187,234` — `scanConfigForSecrets`, `scanEnvForSecrets`, `auditSecrets` ALREADY EXIST [VERIFIED in session]
- `packages/core/src/domain/secret-ref.ts:30` — `SecretRef.source: z.enum(["env","file","exec"])` [VERIFIED in session]
- `packages/core/src/security/secret-ref-resolver.ts:79-81` — `file`/`exec` cases ALREADY IMPLEMENTED [VERIFIED in session]
- `test/architecture/architecture-graph.test.ts:100-133` — `TARGET_GRAPH` confirmed: `core={shared}`, `skills={shared,core,observability}`, `infra={shared,core,observability}`, `agent={shared,core,observability,scheduler}` [VERIFIED in session]
- `packages/skills/src/skills/integrations/mcp-client/mcp-client-call.ts:143-167` — per-server circuit breaker EXISTS; no `needs_reauth` result [VERIFIED in session]
- `HIGGSFIELD-MCP-FIX-PLAN.md` — root-cause file:line per R#, Appendix A file index, Appendix B borrows [cited as source plan]

### Secondary (MEDIUM confidence)
- `.planning/research/{SUMMARY.md,PITFALLS.md,ARCHITECTURE.md}` — milestone research validated all architectural constraints [cited]
- Hermes `mcp_tool.py:1925` — `needs_reauth` pattern (via source plan Appendix B) [cited]
- OpenClaw `src/agents/mcp-transport.ts:145` — redirect header list (via source plan Appendix B) [cited]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions/locations verified against live codebase
- Architecture: HIGH — all cycle risks verified against TARGET_GRAPH; all file:line confirmed
- Pitfalls: HIGH — traced to live file:line; chokidar + delivery scan + cycle trap all confirmed
- R4 wirings: HIGH — all 4 touch-points verified, insertion points exact
- R8 injection gap: HIGH — confirmed `setup-mcp.ts` does not pass `oauthDeps`; seam confirmed

**Research date:** 2026-05-27
**Valid until:** 2026-06-27 (stable internal codebase)

**Key deviation from source plan found:**
- `needs_reauth` does NOT yet exist — `needs_oauth_login` exists only for connect-time failures; call-time 401 handling is NEW work.
- Cross-origin redirect header scrubbing is ALREADY IMPLEMENTED (`mcp-client-redirect-policy.ts`) — verification rather than new build.
- Stdio env interpreter-control denylist is ALREADY IMPLEMENTED (allowlist-only approach + `NODE_OPTIONS` explicit strip) — verification + targeted test addition.
- `SecretRef` `file`/`exec` sources are ALREADY IMPLEMENTED in `secret-ref-resolver.ts` — not new work.
