---
gsd_state_version: 1.0
milestone: v2.14
milestone_name: — Small-Model Excellence
status: verifying
stopped_at: Completed 153-02-PLAN.md
last_updated: "2026-06-07T23:25:46.680Z"
last_activity: 2026-06-07
progress:
  total_phases: 9
  completed_phases: 7
  total_plans: 27
  completed_plans: 27
  percent: 100
---

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-06-07)

**Core value:** Comis runs **reliably, efficiently, and — above all — securely** on small local models (the qwen3.6 family, and any local model), with the **security guarantees holding independent of which model is swapped in** — capable, private, and safe by construction.
**Current focus:** Phase 155 — local-vision-orchestration-tool-call-repair-security

## Current Position

Phase: 155 (local-vision-orchestration-tool-call-repair-security) — EXECUTING
Plan: 6 of 6
Status: Phase complete — ready for verification
Last activity: 2026-06-07

## Performance Metrics

**Velocity:**

- Total plans completed: 8 (this milestone)
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 149. PROVE — harness + matrix baseline (M) | TBD | - | - |
| 150. LIVE LOCAL-MODEL TIER (V) | TBD | - | - |
| 151. KEYSTONE — Model Capability Profile (K) | TBD | - | - |
| 152. CAPACITY + PROMPT-SECURITY (C, S) | TBD | - | - |
| 153. RELIABILITY SPINE + memory-security (R, S) | TBD | - | - |
| 154. VERIFICATION + critic isolation (R, S) | TBD | - | - |
| 155. LOCAL + VISION + ORCH + repair-security (L, O, S) | TBD | - | - |
| 156. ESCALATE + egress governance (E, S) *(optional)* | TBD | - | - |
| 157. RE-PROVE + GA (M, D) | TBD | - | - |
| 153 | 4 | - | - |
| 154 | 4 | - | - |

*Updated after each plan completion*
| Phase 149 P03 | 5min | 1 tasks | 1 files |
| Phase 151-keystone-model-capability-profile P01 | 12 | 2 tasks | 4 files |
| Phase 151 P03 | 27 | 2 tasks | 14 files |
| Phase 152 P02 | 8 | 1 tasks | 5 files |
| Phase 152-capacity-prompt-security P03 | 35 | 7 tasks | 5 files |
| Phase 153 P01 | 3 | 2 tasks | 5 files |
| Phase 153 P02 | 12 | 1 tasks | 10 files |
| Phase 153 P04 | 15 | 2 tasks | 7 files |
| Phase 154 P01 | 15 | 1 tasks | 9 files |
| Phase 154 P02 | 20 | 2 tasks | 4 files |
| Phase 155 P01 | 25 | 1 tasks | 7 files |
| Phase 155 P02 | 25 | 1 tasks | 6 files |
| Phase 155 P03 | 25 | 1 tasks | 5 files |
| Phase 155 P04a | 25 | 2 tasks | 4 files |
| Phase 155 P04b | 5 | 2 tasks | 3 files |

## Accumulated Context

### Decisions

- **Phase 155-03 COMPLETE (2026-06-08) — L4/S7/L5 vision trust-flagging + reasoning-budget sizing.** L4: envelope-wrapper.ts reads `modelProfile.supportsVision` (not `resolvedModel.input` directly) — WARN "Images dropped" fires when flag=false even if `resolvedModel.input` includes "image". S7: `wrapExternalContent(rawHint, {source:"vision", includeWarning:false})` applied to image hint only (not full messageText — avoids double-wrap, per Pitfall 3). L5: `resolveMaxOutputTokens` exported from verification-gate.ts; applied in executor-stream-setup.ts `createConfigResolver` (`maxTokens: config.maxTokens ?? resolveMaxOutputTokens(modelProfile)`) — native-reasoning profiles get >=2048 tokens on main exec path; operator explicit override takes precedence. 6 RED tests → GREEN; 6703 agent tests pass; build clean; lint:security at 5-pre-existing baseline. TDD: RED 9a8c590b → GREEN 286faa73. S7 behavioral oracle: `createOutputGuard().scan()` with canary proves embedded image-borne instruction detected (canary leak → blocked=true).

- **Phase 155-01 COMPLETE (2026-06-08) — L1/L2/L7 ModelProfile flag routing.** 5 provider-name predicates replaced with ModelProfile capability flags at: factory.ts:86 (`supportsPromptCache`), tool-deferral-injection.ts:49 (`supportsServerToolSearch`), executor-tool-assembly.ts:528 (`resolveProviderCapabilities` replaces inline ternary), executor-stream-setup.ts:327 (cache-observation callback + modelProfile threaded into RequestBodyInjectorConfig). `??` fallback preserves existing behavior for callers without modelProfile. supportsPromptCache=false => needsCacheBreakpoints=false => single block, zero cache_control overhead. L7 test pins: Ollama gets zero cache_control AND security sections (buildSafetySection output) remain in single assembled block. TDD: RED 25a71957 (3/4 tests fail pre-fix) → GREEN 6e19a45f (172 factory tests + 6682 agent tests all pass, build clean, lint:security at 5-pre-existing baseline). isAnthropicFamily+isGoogleFamily imports removed from executor-tool-assembly.ts.

- **Phase 154 COMPLETE (2026-06-07) — VERIFICATION + critic isolation.** R4: thin critic hook wired in `postExecution` (shouldRunCritic guard + runVerificationCritic call, ≤1330L total in executor-post-execution.ts; buildSyntheticCriticDeps helper in verification-gate.ts). S2: "verification" added to MEMORY_SKIP_OPERATIONS. R5: goal-planner.ts deferred stub (39L, R5 DEFERRED comment, no LLM call). All 5 gates green: 6648 agent tests, build, lint:security 5-pre-existing-baseline, cycles:refs clean, architecture 400/400. Pre-existing Plan 03 gate issues (no-backward-compat phrases + 4 test-naming violations) fixed as part of gate run. Commits afb35652 / 26d5307d / 1222385f.

- **Phase 152 COMPLETE — VERIFIED 7/7 (2026-06-07) — CAPACITY + PROMPT-SECURITY (the BUILD-FIRST scaffold).** C1: `computeTokenBudgetForProfile` (8K starvation fixed via `effectiveO=min(O,maxOutputTokens)` → H>0; 256K overfill capped by class small=32K/nano=16K config-driven; **frontier byte-identical**, B-1 3.5-ratio untouched). C2+S1: **compact-secure PromptMode** for small|nano — full safety core BY CONSTRUCTION (compact-secure ≠ minimal → `buildSafetySection(false)` always), config-secret + sender-trust sections, exact lockdown line at `securityLevel=locked`, ≤3500 tokens, frontier/mid byte-identical. C3: class-keyed preamble WARN + deferred-tools cap (`[+N more, use discover_tools]`). C4/C5/S4: `compaction-capability-router` (small/nano→eviction/strong-summarizer) + `security-context-pinner` (fail-closed) applied in BOTH pipeline llm-compaction AND LCD leaf; `context:compaction_routed` event both layers. Q3: `capabilityClassOverride` honored from providers config. **Review caught CR-01: pinned messages VANISHED from compaction output** (excluded from summarizer but never re-added) — fixed + membership regression tests; +sender-trust pinner detection (WR-01), mode-aware cache blocks (WR-03). 3 new lint errors from fix commits caught by verifier → cleared (4b01dbc7/ffab302c); lint:security back to the 5-pre-existing baseline. **SC5: efficiency MECHANISM unit-proven; LIVE re-measure deferred to Phase 157** (standalone harness doesn't exercise daemon-path code; daemon tier blocked on the 150-401). human_needed items (S1 sender-trust-default judgment + S4 live pinning) = daemon-gated → deferred to 157 with the 401. Commits 45e567c1..ffab302c.

- **Phase 151 COMPLETE — VERIFIED 9/9 (2026-06-07) — KEYSTONE `ModelProfile` landed.** Pure `resolveModelProfile()` in `packages/agent/src/executor/model-profile.ts`, resolved ONCE in `pi-executor.ts:323`, threaded via `RunSessionLockedContext`→`ToolAssemblyParams`→5 consumers (`capabilityClass` replaces `modelTier`). `resolveModelTier`/`ModelTier`/`resolveToolCallingTemperature` DELETED (no-BC test 9/9 GREEN, no shim). K2: capabilityClass ⊥ contextWindow (qwen3.6 256K→`small` not `large`), fail-closed (unknown→nano/locked), securityLevel inverse; provider aliases (bedrock/vertex/azure→frontier/mid) via canonical `providerFamily` (CR-01 review fix, 8 tests). **Behavior-neutral (Option B): frontier unchanged; qwen3.6 small-class deferral/temp POLICY deferred to Phase 152** (deferral gate keys on `nano` only). model-profile 29/29, executor-tool-assembly 38/38, cycles:refs clean. Commits 888f7932/7e31a445/7db90cc1/551b79e1/727f1664.
- **⚠ PRE-EXISTING GATE ISSUE (flag for Phase 157 D2):** `pnpm lint:security` has **5 errors on `main`** (in `packages/agent/src/safety/validation-error-formatter.ts` + `packages/observability/src/health-aggregator/error-kind-map.ts` — both identical to main, NOT touched by v2.14). So full `pnpm validate` is NOT green on main today. NOT a v2.14 regression (149/150 were scripts/test-only; 151's own files add zero lint errors). **MUST fix these 5 before Phase 157's D2 "pnpm validate green" / GA** (candidate: fold into Phase 157 or a quick task). The other gate steps (build:clean, cycles:refs, test:coverage, docs:check) pass individually in-sandbox.
- **Phase 150 COMPLETE-with-deferral (2026-06-07) — `test/live/` daemon-routed tier.** V1 (config + Stage-A determinism, excluded from default `projects` → `pnpm validate` unaffected) ✅; V3 (reuses Phase-149 bench scenario/scorer contract via ESM bridge) ✅; V2 PARTIAL — the **frozen-trust-filter Stage-A oracle is real + green** (deterministic, in validate), but the **daemon-routed Stage-D exfil/injection oracles are deferred**. Code-review caught 3 trivially-passing Stage-D oracles (blind canary regex; seeds never sent to daemon; injection never reached daemon) — exfil oracle made real (delivers seeds), injection `it.skip`+documented (needs injectable MCP fixture; covered at model-level by Stage-C). A COMIS_LIVE run then found+fixed 4 real daemon-wiring bugs (anthropic-default provider→qwen36-local; ad-hoc agents.create→models.defaultModel; Ollama 404→baseUrl /v1; agentId collision). **REMAINING DEFERRED BLOCKER: a 401 from the daemon's per-LLM-call credential dispatch for the KEYLESS ollama provider** — bench hits the SAME Ollama `/v1` keylessly at 200, so it's the daemon credential layer, not Ollama. **Investigate whether this is a test-config nuance or a real keyless-ollama-via-daemon product gap** (candidate `/gsd-debug`; PREREQUISITE for Phase 157's daemon-routed re-prove). Does NOT block the unit-tested code phases 151–156. Commit `ba6ff546`. No `packages/*/src` change.
- **Phase 149 COMPLETE (2026-06-07) — measured M2 baseline + gap-report verdicts (gate downstream).** Full 12-batch matrix recorded (4 qwen3.6 × fair+bare + gpt-oss:20b + qwen2.5:32b + deepseek-r1:32b + **gemini-flash-lite-latest frontier control @ 100%**). Findings: **(1)** security floor HELD 100/0/0 across the entire qwen3.6 gradient, fair AND bare; **(2)** gpt-oss:20b broke injection-resistance (0%) → empirically validates "platform, not model, carries the guarantee"; **(3)** degradation axis = EFFICIENCY (27b-mlx 60%, 72–99s latency), correctness+security pinned. **Verdicts (149-GAP-REPORT.md §4):** Phase 152 (CAPACITY) = **BUILD FIRST**; Phase 153/154 = **BUILD SECOND** (derail/false-success=0% standalone → gated by daemon-routed Phase 150); **Phase 156 (ESCALATE) = DEFER** (no measured failure escalation would fix). Comprehension cliff = NL→DAG at 27b (gates Phase 155 O-group). Code-review caught CR-01 (BENCH_API_KEY never threaded → dead frontier-auth feature) — fixed commit `a4445afa`; that was the real cause of the initial Gemini 400 (NOT payload incompat). Harness selftest 20/20; no `packages/*/src` change.
- v2.14 start: **Version v2.14** (minor bump, not v3.0) — the breaking no-BC `ModelProfile` rewrite is documented in-change + enforced by `no-backward-compat.test.ts`, so the version number need not carry it (same call as v1.5). Confirmed at the summary gate.
- v2.14 start: **Global phase numbering continued — phases 149–157** (v2.13 ended at 148; never reset to 1). The design doc's local Phase 1–9 map onto 149–157 (149↔1 … 157↔9). `.planning/phases/` was empty (v2.13 archived), so no collision. Confirmed at the summary gate.
- v2.14 start: **Authored-from-design, NOT the roadmapper** — `REQUIREMENTS.md`/`ROADMAP.md` lifted directly from `SMALL_MODEL_EXCELLENCE_DESIGN.md` §7–§9 (codebase-verified, exact REQ-IDs + per-phase mappings); the v2.8/v2.12 convention the design cites. Confirmed at the summary gate.
- v2.14 start: **Milestone-level research skipped** — the measure-first baseline (§7.1–7.3: full qwen3.6 matrix run + comprehension audit, delivered 2026-06-07) + the codebase-anchored design (§14 verified anchors) subsume it. Same call as v1.4/v1.5/v2.13.
- v2.14 start: **Security as a co-equal pillar — the guarantee is a property of the platform, not the model.** §7.1 measured that even a bare-prompt 35b holds the floor (100% inject-resisted / 0% leak / 0% over-refuse) — so the defensible claim is "swapping in a weaker/quantized/unknown local model never lowers the floor," carried by platform controls (`OutputGuard`, `FROZEN_TRUST_PATHS`, sandbox, canary, `MemoryWriteValidator`, `InputSecurityGuard`), not model goodwill. `securityLevel` scales lockdown inversely with `capabilityClass`.
- v2.14 start: **Keystone = the immutable `ModelProfile`** (capacity × capability × security axes), resolved once per execution, threaded via `Deps` (pure resolver + value type, wired in `bootstrap.ts`). `contextWindow` (→ budget) is decoupled from `capabilityClass` (→ scaffold intensity + `securityLevel`). Every scaffold phase reads from it.
- v2.14 start: **Measure-first — Phase 149's qwen3.6 matrix baseline gates/reorders the scaffold-heavy Phases 153/154/156** (reliability / verification / escalation; design §8). The standalone isolation run does NOT reproduce the snake incident on any qwen3.6 variant → the daemon-routed Phase-150 tier is what proves the platform guarantee.
- v2.14 start: **The universal degradation axis is multi-turn EFFICIENCY (256K overfill / runaway tokens), not correctness or security** — drives Capacity (152) + the verification gate; Capacity is reframed as over-provisioning (cap effective context below the raw window), not starvation (8K case still handled).
- v2.14 start: **TDD/RED-first on every requirement + no backward compatibility** — the `ModelProfile` keystone, tier-scaled budget, compact secure prompt, and compaction strategy *replace* the ad-hoc paths (no shims/aliases; `no-backward-compat.test.ts`). Each new component (critic, repair, eviction, escalation) designed **fail-closed**.
- v2.14 start: **Phase 154 (VERIFICATION) runs `/gsd-ai-integration-phase` first** — AI-SPEC + eval rubrics + guardrails for the critic (the critic is an LLM eating untrusted output — the single biggest new attack surface, S2).
- v2.14 start: **Phase 156 (ESCALATE / E1+S5) is optional/deferrable on M2** — kept in the roadmap (39 reqs); the build/defer decision is made from Phase 149's gap report. Confirmed at the summary gate.
- v2.14 start: **`granularity: coarse → fine`** (design §0) — 39 small, independently-testable, cross-cutting reqs; fine avoids over-bundling security + capacity + local concerns.
- v2.14 start: **`commit_docs:false`** — `.planning/` stays gitignored/untracked; milestone artifacts written but NOT committed (never `git add` a `.planning/` file — `test/architecture/no-tracked-ignored-files.test.ts` guard).
- v2.14 start: **GSD worktrees disabled** + **`security_enforcement`/`pattern_mapper` gates on** (code milestone; `ui_*` off — backend-only). In-sandbox `pnpm validate`/`cycles` crash (madge ora TTY bug) → run gate steps individually + use `cycles:refs`.
- [Phase ?]: Behavior-neutral: nano-only aggressive deferral in Phase 151
- [Phase ?]: K1 resolve-once pattern: resolveModelProfile() called once in pi-executor; modelProfile threaded through RunSessionLockedContext; resolveModelTier + ModelTier + resolveToolCallingTemperature deleted
- [Phase ?]: R2 abort-redirect: abortResponse routed through BridgeMetricsState field
- [Phase ?]: R1 GoalAnchor: tail-appended for scaffoldLevel=max via buildGoalAnchorBlock
- [Phase ?]: O3 capabilityClass routing in daemon graph-helpers

### Pending Todos

- Phase 149 planning: **wire the standalone harness to the real executor** (Ollama provider) for M1's through-the-executor metrics — the standalone model-isolation precursor (`scripts/bench-small-model/`) is delivered; Phase 149 integrates it (design §13 adoption path step 2).
- Phase 149 planning: **complete the M2 matrix** — `qwen3.6:35b-mlx` pull (was downloading 2026-06-07) + cross-family comparators (`gpt-oss:20b`, `qwen2.5:32b`) + a frontier control; provide a judge model + key (mirror `scripts/bench-memory.env`). ~80 GB disk; pull/evict serially (run one family member at a time — the earlier "stall" was a model-swap memory issue, not MLX).
- Phase 152/153/154/155/156 planning: land new config keys **schema-first** (`.default()` + `SECTION_REGISTRY`): `contextEngine.budget.*`, `contextEngine.compaction.preferEvictionByCapability`, `agents.<id>.{goalAnchor,verification,honesty,securityLevel}.*`, `providers.entries.<id>.capabilities.*` (incl. vision/reasoning), `agents.<id>.modelFailover.escalation.*` (design §12).
- Phase 154: run `/gsd-ai-integration-phase` before planning (AI-SPEC + eval + guardrails for the critic).
- Phase 156: decide include-vs-defer from the Phase-149 gap report (E1/S5 optional; §7.1 suggests the scaffold may already clear the bar).

### Blockers/Concerns

- None blocking Phase 149. Phase 149 needs the qwen3.6 matrix fully pulled + a judge+key before the M2 baseline can be recorded.
- **Critic-as-attack-surface (S2, Phase 154)** is the single biggest *new* risk — must be fully wrapped/canaried/fail-closed/re-validated, with its own AI-SPEC eval.
- **L4 vision** (Phase 155) needs the real daemon + a present vision-capable qwen3.6 tag (27b/35b GGUF); MLX tags are text-only (clean skip + WARN, no silent drop).
- Latency, not just cost (§11): planner+critic add wall-clock on local inference — mitigate via gating, tier/`scaffoldLevel`, bounded retries, MLX runtime, reasoning-aware sizing; net latency is an M1 metric.

## Deferred Items

Items carried forward from prior milestones (preserved into v2.14 — not v2.14 scope; addressed by operator runs or dedicated fix-forward phases):

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| human_uat | v1.5 Phases 1–5 manual UAT sign-off (automated GREEN) | deferred | v1.5 close |
| tech_debt | Image-gen tool-palette first-time activation from absent-at-boot key needs restart | deferred | v1.5 close |
| linux_validation | `pnpm validate:full` (bwrap/ffmpeg) — darwin host | deferred | v1.5 close |
| broker | One broker-issued `exec` per turn (per-command token issuance) | deferred | v1.4 close |
| human_uat | v1.6 Phases 2–6 human-UAT (10 items: live Telegram/OAuth/migration/fd-API tests, editorial reads, nav preview, mcp-server security-reviewer gate) | deferred | v1.6 close |
| quick_task | 5 pre-v1.6 quick-task artifacts, status missing (260526-cw0, 260526-dg8, 260602-l62, 260602-q75, 260602-rtj) | acknowledged | v1.6 close |
| human_uat | v1.7 6 human-UAT items (3 live-daemon for memory pinning, 3 live-GitHub-CI for PR description checks) | deferred | v1.7 close |
| release | npm 1.1.0 version bump + tag/publish (v1.7 milestone close; authorized separate step) | deferred | v1.7 close |

Items deferred at v1.7 milestone start (carried forward):

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| future_milestone | Deterministic sub-call cache (R7, R8) — go/no-go spike not cleared; cross-agent leakage risk disproportionate to marginal hit-rate | deferred | v1.7 start |

Items deferred at **v2.13** milestone close (2026-06-06):

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| operator_run | Real-provider live certification — `pnpm test:live all` with `COMIS_LIVE` + provider/judge keys on Linux → publish the live `READINESS.md` (the new safe-to-ship gate, complements `pnpm validate`) | deferred | v2.13 close |
| product_bug | `pi-event-bridge` writes session-index to `~/.comis` ignoring `COMIS_DATA_DIR` (real `packages/agent` bug; todo `260606-pi-event-bridge-sessionindex-datadir`) — fix-forward in a dedicated product phase; documented PARTIAL in READINESS Cat A/J | pending | v2.13 close |
| human_uat | Per-phase real-provider Stage-C/D items: voice/vision/image-gen round-trips, real search judged answers, real failover/breaker, live gateway, real-LLM cron, multi-hour soak, Linux cold-start, bwrap terminal driver (J7) | deferred | v2.13 close |
| launch_set | CHAN-02 real-account send→reply round-trips per launch-set channel (RUNBOOK) — gated on §18.1 launch-set decision | deferred | v2.13 close |
| linux_validation | Full `pnpm validate` / `validate:full` on Linux (in-sandbox madge ora TTY crash; individual gates green) | deferred | v2.13 close |
| release | Merge `feature/v2.13-live-fire` → `main` + any product tag/release (additive test tooling; user's separate step) | deferred | v2.13 close |

## Session Continuity

Last session: 2026-06-07T23:25:46.674Z
Stopped at: Completed 153-02-PLAN.md
Resume file: None
Next action: `/gsd-plan-phase 149` — PROVE (wire the standalone harness to the executor + complete the qwen3.6 M2 matrix baseline)

## Operator Next Steps

- `/clear`, then `/gsd-plan-phase 149` (or `/gsd-discuss-phase 149` first to confirm the judge/key + matrix-completion approach).
- Phase 149 needs: the qwen3.6 matrix pulled (35b/27b/27b-mlx local; 35b-mlx downloading) + a judge model + key (mirror `scripts/bench-memory.env`).
