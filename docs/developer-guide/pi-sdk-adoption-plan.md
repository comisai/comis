# pi SDK capability adoption plan

Status: reviewed assessment and sequencing plan. The 0.80.10 upgrade described in "Completed" is implemented on this branch, and the six "Adopt (worth it)" items are resolved — 1–4 landed test-first, 5–6 evaluated and declined with pinned rationale (see the per-item outcomes below). Remaining items are proposals that must land test-first with a concrete caller, per the [generic agent architecture](./generic-agent-architecture.md) boundary rules.

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

### Adopt (worth it) — resolved, outcome per item

1. **Context-overflow detection** — **ADOPTED.** The detection axis in `safety/context-truncation-recovery.ts` now rides the SDK's `isContextOverflow` (per-provider catalog plus non-overflow exclusions); Comis keeps the error-shape candidate extraction and the recovery *strategy*. Two corrections landed with it: Bedrock throttling / rate-limit messages that mention tokens no longer classify as overflow (truncating on a transient throttle destroys context), and `String(error)` was demoted to a true fallback — its `Error: ` prefix defeated the SDK's line-anchored throttling exclusions.
2. **Initial model resolution + thinking-level clamping** — **ADOPTED.** `resolveInitialModel` accepts an optional requested thinking level and clamps it via the SDK's `clampThinkingLevel`: pass-through when the model supports the level, nearest supported tier otherwise (`xhigh`/`max` are per-model opt-ins that must never reach the provider verbatim), `"off"` on non-reasoning models. Default request stays `"medium"`. The Comis allowlist gate is unchanged.
3. **Session-stats derivation** — **ADOPTED AS SEMANTICS, NOT AS DELEGATION.** The SDK's stats derivation lives on `AgentSession.getSessionStats()`, which needs a live agent; Comis's `getSessionStats` reads JSONL offline, so direct delegation cannot express it, and `getLastAssistantUsage`/`calculateContextTokens` answer a different question (current context size, not cumulative counts). The real defect the review surfaced: both Comis derivations counted the Anthropic wire names (role `"tool"`, block type `"tool_use"`) while pi-written sessions carry `"toolResult"`/`"toolCall"` — `toolCalls`/`toolResults` reported 0 forever, and the daemon `session.history` handler additionally read `usage.input_tokens`/`output_tokens` where pi reports `usage.input`/`output`, zeroing token stats while marking them authoritative. Both now mirror the SDK's own counting semantics (legacy wire names stay accepted for preserved entries).
4. **Session security scrubbers off private internals** — **LANDED AS GUARDED BOUNDARY + REAL-SDK CANARY.** The public `entryTransforms`/`entryProjectors` seam this item originally named does not exist at 0.80.10, and no public seam can express in-place repair of already-persisted entries — the SDK session surface is append-only. All three scrubbers now access `fileEntries`/`_rewriteFile` exclusively through `session/session-manager-internals.ts`; its real-SDK contract test pins both existence and end-to-end persisted repair (mutate → rewrite → reopen), so an SDK-internal rename fails CI loudly instead of silently disabling the scrubbers. The executor/context-engine paths (llm-compaction, observation-masker, schema-stripping, executor-context-engine-setup, executor-tool-assembly) touch the same internals through structurally-typed params; the canary covers that shared dependency, and routing them through the boundary is a cosmetic follow-up. The sibling risk — the executor's `session.agent` hook/state mutation surface, previously exercised only through mocks — is pinned by a real-SDK contract test (`agent-session-contract.test.ts`), which also documents that `state.messages` assignment copies the top-level array rather than adopting it.
5. **Frontmatter parsing in skills** — **NOT ADOPTED (evaluated).** The SDK's `parseFrontmatter` returns a silent empty frontmatter for a missing or unterminated block and throws a raw `YAMLParseError` on malformed YAML. Comis skill manifests need the descriptive `Result` contract (unterminated marker, empty block, non-object YAML) so a SKILL.md authoring mistake surfaces as actionable operator feedback rather than a skill that silently loads without metadata. A contract-preserving wrapper would re-implement the marker detection and save only the one-line `yaml.parse` call. The divergence is pinned in `manifest/parser.test.ts` so a future delegation attempt trips over the contract it would drop.
6. **Tool-parallelism mutex** — **NOT ADOPTED (evaluated).** Verified in the 0.80.10 agent loop: one `executionMode: "sequential"` tool call in an assistant batch flips the ENTIRE batch to sequential execution, read-only calls included. Comis's `createMutationSerializer` is strictly finer-grained — read-only tools keep running concurrently while mutating tools serialize against each other, and the `isConcurrencySafe` metadata distinguishes mutating-but-independent tools. Adopting would coarsen that to whole-batch serialization.

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
2. **Done (this branch, test-first)**: (4) scrubbers behind the guarded internals boundary + canary; (1) overflow-detector adoption; (2) thinking-level clamping; (3) session-stats naming/semantics fix; (5) and (6) evaluated and declined with pinned rationale.
3. **Spike before committing**: (7) dynamic-tool-loading cache path — measure real cache-read/write deltas on a live drive.
4. **With the generic-runtime redesign** (owns these boundaries anyway): skill-loader delegation (8), catalog consolidation, codex-protocol unification.
5. **Upstream asks**: `originator` option on codex `OAuthAuth.login`; a public export of `InitialModelResult` (Comis still mirrors the shape locally because `core/model-resolver` is not on the exports map).
