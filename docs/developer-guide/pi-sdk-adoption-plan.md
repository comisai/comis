# pi SDK capability adoption plan

Status: reviewed assessment and sequencing plan. The 0.80.10 upgrade described in "Completed" is implemented on this branch; every other item is a proposal that must land test-first with a concrete caller, per the [generic agent runtime redesign](./generic-agent-runtime-redesign.md) rules.

This document records the deep review of the pi SDK surface (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`) against Comis's own subsystems: what the SDK now provides, where Comis duplicates it, and — for each area — whether moving onto the SDK is worth it. The standing bar: adopt SDK behavior only when an unrelated deployment gains something (less Comis-maintained code, better provider coverage, better cache behavior) without losing a Comis guarantee (security gating, multi-tenancy, multi-profile auth, observability, offline determinism).

## Completed: 0.80.10 upgrade (this branch)

Pinned 0.80.6 → 0.80.10 across all packages. The breaking surface and how it landed:

| Break (SDK) | Comis resolution |
| --- | --- |
| `AuthStorage` / `InMemoryAuthStorageBackend` no longer exported; `CreateAgentSessionOptions.authStorage`/`modelRegistry` replaced by async `modelRuntime` | Comis-owned `ComisCredentialStore` (packages/agent/src/model/auth-storage-adapter.ts) implements pi-ai's `CredentialStore`; `createModelRegistryAdapter` now builds `ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false })` plus the sync `ModelRegistry` facade; the executor passes `modelRuntime` to `createAgentSession` |
| `ModelRegistry.inMemory()` removed; `refresh()`/`getApiKeyAndHeaders()` now async | Registry construction moved to `ModelRuntime`; Comis never called the auth-resolution methods on the facade |
| `pi-ai/oauth` value exports removed (`getOAuthProvider`, `getOAuthApiKey`, `getOAuthProviders`, `loginOpenAICodex`); OAuth is provider-owned (`Provider.auth.oauth: OAuthAuth`) | `provider-oauth-catalog.ts` in core (`getProviderOAuth`/`listOAuthProviderIds`/`resolveOAuthApiKey` over `builtinProviders()`); token-manager refresh + eligibility checks re-homed onto it |
| SDK codex browser login hardcodes `originator="pi"`; no injection point | Vendored the PKCE + localhost-callback + code-exchange flow as `openai-codex-browser-login.ts` in core with `originator="comis"` (wire-visible client identity is a product constraint; the sibling device-code flow was already Comis-owned). MIT derivation noted in NOTICE |
| `KnownProvider` widened (now includes dynamic providers like `radius`) while static catalog reads take `BuiltinProvider` | Cast sites updated to `BuiltinProvider` (guarded by `getProviders()` membership before every cast) |

Two load-bearing properties verified against the shipped 0.80.10 code, worth preserving through any future bump:

- **Request auth resolves live.** `ModelRuntime.prepareRequest` calls `getAuth` → `credentials.read()` per dispatch. A synchronous write into `ComisCredentialStore` (rotation hot-swap, OAuth bearer pre-resolve, keyless sentinel) is visible to the very next request with no refresh choreography. The store's contract tests pin this.
- **`allowModelNetwork` defaults ON.** `ModelRuntime.create()` fetches remote model catalogs unless told otherwise (or `PI_OFFLINE` is set). Comis passes `allowModelNetwork: false` explicitly; a future constructor call site that forgets it silently adds boot-time network fetches to the daemon.

New OAuth-capable providers inherited by the upgrade: `xai` and `radius` join `anthropic`/`github-copilot`/`openai-codex` in the eligibility catalog.

## Duplication review: verdict per area

A full-subsystem sweep found Comis overwhelmingly **wraps** the SDK rather than reimplementing it. Realistically delegable code is ~1,300–2,000 lines, concentrated in OAuth protocol plumbing and skill loading. Everything else is genuine Comis value-add the SDK cannot express.

### Adopt (worth it)

1. **Context-overflow detection** — `safety/context-truncation-recovery.ts` keeps a 10-pattern regex catalog; the SDK ships `isContextOverflow`/`getOverflowPatterns` with ~24 patterns plus non-overflow exclusions (Bedrock throttling would currently false-positive as overflow). Small diff, correctness upgrade. Keep Comis's recovery *strategy*; adopt the SDK *detector*.
2. **Initial model resolution + thinking-level clamping** — `resolveInitialModel` hand-rolls `reasoning ? "medium" : "off"`; the SDK's resolver clamps thinking levels per model capability (including the new `xhigh`/`max` tiers). Adopt the clamping; keep the Comis allowlist gate wrapped around it.
3. **Session-stats derivation** — `comis-session-manager.ts` `getSessionStats` re-derives what SDK `getLastAssistantUsage`/`calculateContextTokens` provide. Thin delegation, ~60–80 lines removed.
4. **Session security scrubbers off private internals** — three files reach into `sm.fileEntries`/`sm._rewriteFile()` via `as any` (orphaned-message-repair, scrub-redacted-tool-calls, forged-context-markers). They survived this bump (verified), but they are one internal rename from silently breaking. Migrate to the public `entryTransforms`/`entryProjectors` seam. This is robustness work, not line-count work — highest priority of the adopt list. The sibling risk — the executor's `session.agent` hook/state mutation surface, previously exercised only through mocks — is now pinned by a real-SDK contract test (`agent-session-contract.test.ts`), which also documents that `state.messages` assignment copies the top-level array rather than adopting it.
5. **Frontmatter parsing in skills** — delegate to the SDK's `parseFrontmatter`, keep the Zod validation and the content-scanner injection defense on top.
6. **Tool-parallelism mutex** — evaluate the SDK's per-tool `executionMode: "sequential"` against Comis's mutex-among-mutating-tools semantics; adopt only if the semantic difference (sequential-against-all) is acceptable per tool.

### Re-evaluate at 0.80.10 (was assessed pre-upgrade)

7. **Deferred/dynamic tool loading** — the SDK's cache-friendly dynamic tool loading (0.80.7+) lets extensions add tools mid-session while preserving Anthropic/OpenAI prompt-cache prefixes; 0.80.9 adds Kimi-native deferred tools. Comis's 1,500-line deferral engine carries security gating, budgets, and BM25 ranking the SDK lacks — do not delete it — but its *activation mechanics* could ride the SDK's cache-preserving pathway instead of Comis's own stub/re-register dance. Potentially the single biggest cache-hit-rate win; needs a live-drive spike to compare token bills before committing.
8. **Skill loading** — SDK `loadSourcedSkills` could replace parts of registry discovery *if* capability metadata, the `learned` source, and scanner hooks survive delegation. Refactor, not delete.

### Keep (deliberate divergence — the SDK model cannot express these)

- **Multi-profile auth** (`profileId = provider:identity`, per-agent `oauthProfiles`, rotation + cooldown, usage tracking): the SDK stores one credential per provider. Architectural blocker to wholesale `Models.login`/`getAuth` adoption; Comis layers over the SDK deliberately.
- **Codex OAuth protocol ownership**: the SDK flow cannot carry `originator="comis"`. Both login flows stay Comis-owned. Upstream feature request (an `originator` option on `OAuthAuth.login`) would let ~330 lines retire.
- **LCD context engine** (~8k lines of hierarchical distillation/eviction/rehydration/budget): the SDK offers linear compaction only. The moat; keep.
- **Model allowlist, capability/compat model, per-operation cost tiering, served-window comparison, script-aware token estimation**: no SDK equivalents.
- **Failover retry + circuit breaker + provider health**: Comis classifies on the HTTP-status axis for failover; the SDK's `isRetryableAssistantError` is a different axis (in-conversation retry). Complementary, not duplicate.
- **Sessions**: Comis wraps SDK `SessionManager` and adds tenant isolation, exactly-once inbound provenance, forged-marker/redaction-replay defenses, cross-process locks. Keep the wrap.
- **MCP**: the pi SDK has no MCP support; Comis's client/server on the official SDK with OSV scanning and SSRF policy stands alone.
- **Spend/cost**: Comis consumes SDK `usage.cost` and normalizes per-token pricing for cache-TTL correction and chimeric-model detection; the kill-switch and budgets are multi-tenant mechanisms the SDK does not have.
- **MCP, sub-agents, approvals, plan mode, background tasks**: the SDK's own documentation declares these deliberate non-capabilities — the maintainers expect them as extensions or host machinery. Comis's MCP hardening, sub-agent orchestration, approval flows, and background-task manager have no SDK counterpart to fold into, by upstream design.

### Consolidation (Comis-internal, SDK-adjacent)

- **Two model catalogs**: `@comis/core`'s `ModelCatalog` and the pi catalog coexist; consolidating reads onto `ModelRuntime`/`getBuiltin*` (compat's `getModel(s)`/`getProviders` are now deprecated aliases) removes a drift class.
- **Four hand-rolled `auth.openai.com/oauth/token` POSTs** (device-code, browser login, token-manager codex bypass, doctor/gateway probes): unify onto one Comis-owned codex-protocol module — natural follow-on to the vendored browser flow, and it retires the stale "0.71 discards the wire body" rationale.

## Sequencing

1. **Now (this branch)**: the 0.80.10 upgrade (done).
2. **Next small PRs, in order of risk-reduction per line**: (4) scrubbers off private internals; (1) overflow-pattern adoption; (2) thinking-level clamping; (3) session-stats delegation.
3. **Spike before committing**: (7) dynamic-tool-loading cache path — measure real cache-read/write deltas on a live drive.
4. **With the generic-runtime redesign** (owns these boundaries anyway): skill-loader delegation (8), catalog consolidation, codex-protocol unification.
5. **Upstream asks**: `originator` option on codex `OAuthAuth.login`; a public export of `InitialModelResult` (Comis still mirrors the shape locally because `core/model-resolver` is not on the exports map).
