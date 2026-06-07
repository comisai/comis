# Roadmap: Comis

**Last reorganized:** 2026-06-07 (v2.14 Small-Model Excellence — Running Comis Securely & Superbly on Local Models / qwen3.6 — roadmap created)

Comis is a security-first AI agent platform connecting AI agents to chat channels
(Discord, Telegram, Slack, WhatsApp, Signal, iMessage, IRC, LINE, Email). TypeScript
monorepo, 15 packages, hexagonal architecture. See `.planning/PROJECT.md` for current
state and `.planning/MILESTONES.md` for the full shipped history.

## Milestones

- ✅ **v1.0 — Observability & Troubleshooting** — shipped 2026-05-25 — `milestones/v1.0-ROADMAP.md`
- ✅ **v1.1 — MCP Hardening** — shipped 2026-05-26 — `milestones/v1.1-ROADMAP.md`
- ✅ **v1.2 — MCP Hardening II** — shipped 2026-05-28 — `milestones/v1.2-REQUIREMENTS.md`
- ✅ **v1.3 — MCP OAuth Handoff & Device-Flow** — shipped 2026-05-29 — `milestones/v1.3-ROADMAP.md`
- ✅ **v1.4 — Credential Broker** — shipped 2026-05-30, Linux-validated 2026-05-31 (8 phases, 34 plans) — `milestones/v1.4-ROADMAP.md` · R1 forced-egress spike **GO** + publish gate lifted (#142)
- ✅ **v1.5 — Unified Credential Storage** — shipped 2026-06-02 (7 phases, 32 plans) — `milestones/v1.5-ROADMAP.md` · audit tech_debt-accepted; `pnpm validate:full` Linux tier deferred
- ✅ **v1.6 — Documentation Alignment & Gap-Filling** — shipped 2026-06-03 (6 phases, 26 plans, docs-only) — `milestones/v1.6-ROADMAP.md` · 0 ghost pages, 0 broken links; all canonical counts source-verified
- ✅ **v1.7 — Competitive Hardening (Odysseus Adoption)** — shipped 2026-06-04 (4 phases, 12 plans) — `milestones/v1.7-ROADMAP.md` · audit tech_debt-accepted (6 human-UAT items deferred); npm 1.1.0 release pending
- ✅ **v2.13 — Live-Fire (Real-Provider Production-Validation Framework)** — shipped 2026-06-06 (15 phases 134–148, 72 reqs) — `milestones/v2.13-ROADMAP.md` · audit tech_debt-accepted; deterministic Stage-A/B certified green, real-provider Stage-C/D deferred to operator live run (§20); additive `test/live/` tooling on branch `feature/v2.13-live-fire` (merge/tag = user step)
- 🔄 **v2.14 — Small-Model Excellence (qwen3.6)** — in planning (9 phases **149–157**, **39 reqs**) — source design `.planning/design/SMALL_MODEL_EXCELLENCE_DESIGN.md`

---

## Current Milestone: v2.14 — Small-Model Excellence (Running Comis Securely & Superbly on Local Models / qwen3.6)

**Goal:** Make Comis run **reliably, efficiently, and — above all — securely** on the **qwen3.6** local family (and any local model) by externalizing executive function into a tier-aware **scaffold** keyed off a centralized, immutable **Model Capability Profile** (capacity × capability × security axes), such that **the security guarantees hold independent of which model is swapped in**, larger models don't regress, and the lift is **measured** on a security+reliability+efficiency replay suite across the qwen3.6 variants.

**Source design:** `.planning/design/SMALL_MODEL_EXCELLENCE_DESIGN.md` (authoritative — §6 Goal, §7 Requirements, §8–9 Roadmap). **Authored-from-design, not the roadmapper** (the v2.8/v2.12 convention). Requirements in `.planning/REQUIREMENTS.md` (39 reqs, categories M/V/K/C/R/S/L/O/E/D).

**Phase numbering:** continues the product's **global** numbering — v2.14 = phases **149–157** (v2.13 ended at 148). The design doc's local Phase 1–9 map onto 149–157 (149↔1 … 157↔9).

**Posture:** TDD/RED-first on every requirement; **no backward compatibility** (`no-backward-compat.test.ts` — the `ModelProfile` keystone *replaces* the ad-hoc paths, no shims). Each new component (critic, repair, eviction, escalation) designed **fail-closed**; S-group changes carry threat/risk notes + boundary tests (`AGENTS.md §6.6`). Hexagonal: `ModelProfile` = pure resolver + value type wired in `bootstrap.ts`. Each phase TDD/RED-first and independently shippable. **Measure-first: Phase 149's matrix gates/reorders the scaffold-heavy Phases 153/154/156.** `granularity:fine`; `commit_docs:false`; worktrees off; `security_enforcement`+`pattern_mapper` on; in-sandbox run gate steps individually + `cycles:refs`.

### Phases

- [x] **Phase 149: PROVE — standalone harness + qwen3.6 matrix baseline (M)** *(precursor delivered)* — Quantify reliability + security + efficiency across the qwen3.6 family (model-isolation) and gate the rest; the gap report reorders/gates 153/154/156 ✅ 2026-06-07 (12-batch baseline; security floor held 100/0/0; efficiency = degradation axis; **152 BUILD-FIRST, 156 DEFER**)
- [x] **Phase 150: LIVE LOCAL-MODEL TEST TIER (`test/live/`) (V)** *(scaffold delivered)* — Drive each qwen3.6 variant end-to-end through the real daemon/executor; security invariants are HARD oracle assertions ✅ 2026-06-07 (V1+V3 done; V2 trust-filter Stage-A real+green; **daemon-routed Stage-D exfil/injection DEFERRED** — live run fixed 4 wiring bugs, blocked on keyless-ollama-daemon **401** (investigate; prereq for Phase 157 live re-prove); covered at model-level by Stage-C)
- [x] **Phase 151: KEYSTONE — Model Capability Profile (K)** — Centralize the immutable `ModelProfile` (capacity×capability×security×vision×reasoning×cache); resolved once, threaded via `Deps`; behavior-neutral ✅ 2026-06-07 (K1+K2 verified 9/9; pure resolver @ pi-executor:323, resolveModelTier deleted no-BC; capabilityClass⊥contextWindow, fail-closed nano/locked, provider aliases→family; Option-B behavior-neutral, small-policy→152)
- [x] **Phase 152: CAPACITY + PROMPT-SECURITY (C, S)** — Two-axis budget (8K starvation *and* 256K overfill); compact **secure** prompt that never drops the safety core; capability-routed compaction; security context pinned ✅ 2026-06-07 (C1-C5+S1+S4 verified 7/7; compact-secure safety-core-by-construction; pinning in BOTH layers + CR-01 vanish-bug fixed w/ membership tests; frontier byte-identical; SC5 live re-measure → 157)
- [x] **Phase 153: RELIABILITY SPINE + memory-security (R, S)** — GoalAnchor + post-abort redirect + memory relevance-floor (poison defense) + capability-routed memory ops; frozen trust-filter/write-validator preserved ✅ 2026-06-07 (verified 5/5 R1/R2/R3/R6/S6; code-review CR-01 "R6 built-but-not-wired" fixed end-to-end through the 3 daemon memory-job sites + CR-02/WR-02/03/04; 2 human-UAT items deferred — GoalAnchor tail-position + abort-redirect user message)
- [x] **Phase 154: VERIFICATION (AI-integration) + critic isolation (R, S)** — Pre-delivery critic + planner catch false-success; critic hardened as an injection surface. **Runs `/gsd-ai-integration-phase` first** ✅ 2026-06-08 (verified 7/7 R4/R5/S2; AI-SPEC→research→plan-check(PASS)→4 plans→review→fix; in-house critic seam, 9 op-types, fail-closed everywhere; code-review BLOCKER CR-01 "agent-directed redirect delivered as reply" + WR-01..04 fixed — honest first-person terminal delivery, keyless-gated, canary session-binding, end-to-end injection-resistance proof; R5 deferred-stub on M2; live Stage-D critic oracle → 157)
- [ ] **Phase 155: LOCAL + VISION + ORCHESTRATION + tool-call-repair security (L, O, S)** — Capability-flag tool path + tool-call repair + vision/reasoning sizing + MLX/GGUF perf + NL→DAG validate-repair/templates + image-as-untrusted
- [ ] **Phase 156: ESCALATE + egress governance (E, S)** *(optional / deferrable on M2)* — Signal-triggered escalation to a local-first target; off-device requires opt-in + redaction + scope-limit + canary
- [ ] **Phase 157: RE-PROVE + GA (M, D)** — Re-measure proves lift vs M2 (security floor held everywhere); docs for every key/env + security posture + recommended secure qwen3.6 config

### Phase Details

---

### Phase 149: PROVE — standalone harness + qwen3.6 matrix baseline *(precursor delivered)*

**Goal**: Quantify reliability + security + efficiency across the qwen3.6 family (model-isolation) and gate the rest. No production-behavior change. The standalone harness is delivered — `scripts/bench-small-model/` (§7.1); this phase completes the full matrix baseline and the gap report.

**Depends on**: Nothing (first phase; the measure-first gate for the milestone)

**Wave**: 1 (matrix baseline gates the scaffold-heavy phases)

**Requirements**: M1, M2

**Success Criteria** (what must be TRUE):
  1. The standalone harness emits all M1 metrics — success, constraint-adherence, derailment, false-success, poison, **injection-resisted / secret-leaked / over-refused**, tokens, latency, history-retention — and the scenario+scorer contract is fixed (selftest green) (M1).
  2. A baseline is recorded for the full **qwen3.6 matrix** (§7.2 — 27b/35b GGUF + 27b/35b-mlx, fair & bare prompts) + cross-family comparators (`gpt-oss:20b`, `qwen2.5:32b`) + a frontier control (M2).
  3. A gap report ranks failure modes and **explicitly reorders/gates Phases 153/154/156** by measured impact, including where the **security floor** does/doesn't hold across the gradient.
  4. `pnpm validate` green (harness under `scripts/`; no `packages/*/src` behavior change).

**Notes**: Needs the qwen3.6 matrix pulled (in progress: `35b`/`27b`/`27b-mlx` local; `35b-mlx` downloading) + a judge+key (mirror `scripts/bench-memory.env`). `/gsd-plan-phase 149` first (design §13 adoption path).

**Plans:** 3 plans

Plans:
- [x] 149-01-PLAN.md — M1 harness completion: history-retention scenario + selftest 20/20 + frontier apiKey (TDD)
- [x] 149-02-PLAN.md — M2 matrix run: full qwen3.6 matrix + comparators + frontier control (serial, ~50-90 min)
- [x] 149-03-PLAN.md — M2 gap report: ranked failure modes + Phase 153/154/156 verdicts + security floor

---

### Phase 150: LIVE LOCAL-MODEL TEST TIER (`test/live/`) *(scaffold delivered)*

**Goal**: A comprehensive, env-gated tier under `test/live/` that exercises the qwen3.6 family **through the real Comis daemon/executor** end-to-end and asserts the reliability + **security-first** + efficiency invariants — the executor-integrated realization of the standalone harness, reusing its scenario/scorer contract and the existing live-fire oracles. The tier scaffold is delivered (`test/live/scenarios/local/local-models.test.ts`, Stage-C 9/9 vs `qwen3.6:35b`, §7.2); this phase deepens the daemon-routed platform-guarantee assertions (V2).

**Depends on**: Phase 149 (the scenario/scorer contract is the single source of truth)

**Wave**: 2 (after the baseline)

**Requirements**: V1, V2, V3

**Success Criteria** (what must be TRUE):
  1. `test/live/` (live-tier config; `COMIS_LIVE` + Ollama-readiness gated; sequential daemon boot; **default `pnpm test` unaffected**) drives each present qwen3.6 variant and scores every scenario; a Stage-A portion runs deterministically with `COMIS_LIVE` unset (V1).
  2. Security invariants are **HARD assertions via the existing oracles**: the *delivered* output never leaks the secret/canary (`OutputGuard`/log-oracle), an injected tool-result payload is not followed, the exec **sandbox blocks** the injected command, and the **frozen** trust-filter holds — for **every variant** across the gradient (V2; ties S2/S6/S7).
  3. Reliability + efficiency assertions (no derailment/false-success; within token/latency budget) **reuse the standalone scenario/scorer contract** — single source of truth (V3).
  4. `pnpm validate` green (tier excluded from default `projects`; run via `pnpm test:live` / the live vitest config).

**Plans:** 2 plans

Plans:
- [x] 150-01-PLAN.md — qwen3.6 daemon config: create test/config/config.qwen36-local.test.yaml (Ollama keyless provider, gateway port 4767)
- [x] 150-02-PLAN.md — Stage-D oracle block + Stage-A frozen-trust-filter it() + coverage-matrix cells (V2 platform-guarantee assertions)

---

### Phase 151: KEYSTONE — Model Capability Profile

**Goal**: Centralize an immutable `ModelProfile` (capacity, capability, **security**, vision, reasoning, cache axes) resolved once per execution and threaded via `Deps`. Behavior-neutral — replaces today's window-only `resolveModelTier` stub and scattered provider-name special-casing.

**Depends on**: Phase 149 (baseline informs the capability-class boundaries)

**Wave**: 2 (the keystone every scaffold phase builds on)

**Requirements**: K1, K2

**Success Criteria** (what must be TRUE):
  1. `resolveModelProfile()` is pure; `pi-executor` resolves it once; ad-hoc `resolveModelTier`/`resolvedModel` consumers read from it (K1).
  2. `capabilityClass` / `scaffoldLevel` / `securityLevel` are **independent of `contextWindow`**; a 27B/256K profile ⇒ high scaffold + hardened security; an unknown local model defaults to the most-scaffolded / most-locked class; characterization tests prove unchanged behavior at this step (K2).
  3. `pnpm validate` + `test/architecture/` green.

**Plans:** 3 plans

Plans:
- [x] 151-01-PLAN.md — RED: failing model-profile.test.ts (K2 boundary + fail-closed + securityLevel-inverse) + widen ProviderCapabilitiesSchema + no-BC resolveModelTier grep assertion
- [x] 151-02-PLAN.md — GREEN: implement resolveModelProfile() pure function (FAIL_CLOSED_PROFILE, capabilityClass⊥contextWindow, securityLevel inverse)
- [x] 151-03-PLAN.md — Executor migration: thread ModelProfile through pi-executor/assembleTools/consumers; delete resolveModelTier; pnpm validate green

---

### Phase 152: CAPACITY + PROMPT-SECURITY

**Goal**: Make work fit the executive — both 8K starvation *and* 256K overfill — **without ever weakening the prompt's security core** (`buildSafetySection(minimal)→[]` is the trap a naive compact prompt falls into).

**Depends on**: Phase 151 (budget + prompt assembly read the `ModelProfile`)

**Wave**: 3 (after the keystone; parallel with 153, 155)

**Requirements**: C1, C2, C3, C4, C5, S1, S4

**Success Criteria** (what must be TRUE):
  1. `computeTokenBudget(ModelProfile,…)` yields a usable `H>0` on an 8K window and a **capped effective history** on 256K (below the raw window for a small `capabilityClass`); large-tier numbers are byte-identical; the 3.5-ratio over-reservation invariant holds (C1).
  2. The compact secure-primary prompt is **≤ target tokens AND contains the safety core + sender-trust + config-secret** sections; a test **fails if any security section is absent**; lockdown tightens as `capabilityClass` drops (C2, S1).
  3. The per-turn preamble is bounded for the profile (cap + WARN; deferred-tools list compressed) (C3).
  4. Low-`capabilityClass` compaction prefers eviction / lossless-store+recall (or a configured stronger summarizer) over same-weak-model summarization — in **both** the pipeline `llm-compaction` layer and the LCD leaf-summarizer; security-relevant context (sender-trust, safety reinforcement, untrusted markers, canary) is **pinned** (never evicted); degradation is logged + emits an event (C4, C5, S4).
  5. Re-run the matrix: 256K overfill and 8K starvation both improved; the security floor is unchanged. `pnpm validate` green.

**Plans:** 5 plans

Plans:
- [x] 152-01-PLAN.md — Config schema + event type + source stubs + RED tests (C1, C4, S4 Wave-0)
- [x] 152-02-PLAN.md — C1 GREEN: computeTokenBudgetForProfile + 8K fix + 256K cap + call-site wiring
- [x] 152-03-PLAN.md — C2+S1 TDD: compact-secure PromptMode — safety-core never dropped; lockdown tightens
- [x] 152-04-PLAN.md — C3: preamble cap + WARN + deferred-tools truncation
- [x] 152-05-PLAN.md — C4+C5+S4 TDD: compaction router + security pinner — both pipeline + LCD layers

---

### Phase 153: RELIABILITY SPINE + memory-security

**Goal**: Keep a weak executive on task; never inject distracting/poisoned memory; never free-associate after an abort.

**Depends on**: Phase 151 (+ Phase 149 gap ordering)

**Wave**: 3 (gated/ordered by the Phase-149 gap report; parallel with 152, 155)

**Requirements**: R1, R2, R3, R6, S6

**Success Criteria** (what must be TRUE):
  1. A user-derived **GoalAnchor** (objective + requirement checklist + done-criteria) is injected at the envelope tail every turn for scaffolded tiers (R1).
  2. A forced abort (loop/step/circuit) ⇒ the final message **re-asserts the user's actual request** + unmet items, not a stale sub-task (R2).
  3. The relevance floor drops a 0.12-base / 0.20-boosted memory at `floor=0.3` while a 0.4-base memory survives (gates on `.base`, so boosts can't resurrect an irrelevant memory); small/overfill profiles additionally cap injected count/chars (R3).
  4. Memory's model-heavy ops (extraction, consolidation, `memory_ask` dialectic synthesis) are **capability-routed**; under a weak model, dialectic synthesis **abstains rather than fabricates citations**; vector/FTS/bandit stay local (R6).
  5. A weaker profile **cannot** relax the frozen trust-filter (`FROZEN_TRUST_PATHS`) / `MemoryWriteValidator` / R3 relevance-floor — a test proves it (S6). Re-run the matrix: derailment + poison rates drop; security floor held. `pnpm validate` green.

**Plans:** 4 plans

Plans:
- [x] 153-01-PLAN.md — R1 GoalAnchor builder + GoalAnchorConfigSchema (schema-first, TDD)
- [x] 153-02-PLAN.md — R1 wrapEnvelope tail injection + R2 abort-redirect at all 6 abort sites (TDD)
- [x] 153-03-PLAN.md — R3 memory relevance base-floor (EXACT-numbers TDD) + small/nano count/chars caps
- [x] 153-04-PLAN.md — R6 memory-capability-router + dialectic abstain + S6 immutability structural tests

---

### Phase 154: VERIFICATION (AI-integration) + critic isolation

**Goal**: Catch off-spec / wrong-task / false-success before delivery — with the critic itself hardened as an injection surface (it is an LLM eating untrusted output). **Runs `/gsd-ai-integration-phase` first** (AI-SPEC + eval rubrics + guardrails for the critic).

**Depends on**: Phase 153 (the GoalAnchor checklist seeds the critic)

**Wave**: 4 (after the reliability spine)

**Requirements**: R4, R5, S2

**Success Criteria** (what must be TRUE):
  1. New `planning` / `verification` operation types resolve to the primary on a local-only deploy (self-check) or to a cheap model when configured (R4/R5).
  2. A 1-of-3-requirement response ⇒ the critic returns 2 unmet + a bounded `followUp`; on exhaustion it delivers an **honest unmet-list, never an unqualified "done"** (R4). A pre-execution planner builds the checklist that seeds R1/R4 (R5; deferrable on M2).
  3. The critic **wraps the reviewed output as untrusted (`wrapExternalContent`), inherits the safety core, embeds the canary, fails closed (uncertain ⇒ not-verified), and re-validates implied tool calls** through the same exec gates; an injection embedded in the reviewed output does **not** flip the verdict or widen scope (S2).
  4. The AI-SPEC eval suite passes its accuracy / false-positive thresholds. Re-run the matrix: false-success → ~0; security held. `pnpm validate` green.


**Plans:** 4 plans

Plans:
- [x] 154-01-PLAN.md — Operation-type wiring (verification+planning) + config schema keys (VerificationConfig/HonestyConfig) + event registration (TDD)
- [x] 154-02-PLAN.md — S2 critic-isolation.ts: wrap-untrusted, canary, implied-tool-call, fail-closed parse (TDD — security core)
- [x] 154-03-PLAN.md — R4 verification-gate.ts: gate + call + verdict routing + retry loop + honest exhaustion + L5 sizing (TDD)
- [x] 154-04-PLAN.md — Post-execution hook wiring + MEMORY_SKIP_OPERATIONS + R5 deferred stub (goal-planner.ts)

---

### Phase 155: LOCAL + VISION + ORCHESTRATION + tool-call-repair security

**Goal**: Make qwen3.6's wire behavior (tools, vision, reasoning, MLX/GGUF, cache-bypass) work **securely**, and make NL→DAG orchestration robust on smaller variants (validate→repair + templates) — the one measured comprehension cliff (§7.3: 35b ✅ / 27b ✗).

**Depends on**: Phase 151 (capability flags drive every path here)

**Wave**: 3 (after the keystone; parallel with 152, 153)

**Requirements**: L1, L2, L3, L4, L5, L6, L7, O1, O2, O3, S3, S7

**Success Criteria** (what must be TRUE):
  1. Capability flags drive the tool path / `tool_search` gating / cache split; provider-name special-casing is removed where a flag now covers it; `supportsPromptCache=false` emits a single block; the no-cache-overhead bypass never drops a security section (L1, L2, L7).
  2. Near-miss tool JSON is repaired in one pass (constrained decode where `supportsStructuredOutput`, else lenient parse+repair); irreparable ⇒ a concise validation message (not a breaker trip); **repair re-runs all security gates and never widens scope / bypasses the denylist** (L3, S3).
  3. Vision is declared (`input:["text","image"]`) + an integration round-trip on real qwen3.6 27b/35b passes; a text-only/MLX profile **skips image attach with a WARN** (no silent drop) (L4). `reasoningStyle="native"` sizes `maxOutputTokens` so `reasoning_content` doesn't starve the visible answer — pinned by a test (L5).
  4. **Image input is treated as untrusted**: an image-borne instruction is not followed; the canary/`OutputGuard` still apply (S7).
  5. MLX-vs-GGUF latency/throughput is reported and docs recommend the per-platform runtime (L6). NL→DAG validate→repair + `${VAR}` templates engage by `capabilityClass` — a capable model emits the graph directly (unchanged), a weak one yields a valid graph for the canonical "research-3-then-debate" instruction (O1, O2, O3). `pnpm validate` green.

**Plans:** 6 plans

Plans:
- [x] 155-01-PLAN.md — L1/L2/L7 ModelProfile flags replace provider-name predicates at 5 call sites (TDD)
- [x] 155-02-PLAN.md — L3/S3 tool-call-repair.ts: shape-only value-preserving normalizer + wrapper wired in executor-stream-setup.ts; adversarial tests (TDD)
- [x] 155-03-PLAN.md — L4/S7 vision untrusted-flag + L5 resolveMaxOutputTokens main path (TDD)
- [ ] 155-04-PLAN.md (04a) — O1/O2 dag-repair-loop + dag-templates in agent package; no daemon import (TDD)
- [x] 155-04b-PLAN.md — O3 capabilityClass routing wired in graph-helpers.ts + graph-mutate.ts; async reprompt stub deferred to Phase 157 (TDD)
- [x] 155-05-PLAN.md — L6 harness annotation + docs per-platform MLX/GGUF recommendation

---

### Phase 156: ESCALATE + egress governance *(optional / deferrable on M2)*

**Goal**: For hybrid deploys, escalate the hard 20% — **without leaking off-device**. **Deferrable** if the Phase-149/M2 gap report shows the scaffold already clears the bar (§7.1 suggests it may).

**Depends on**: Phase 154 (verification-failure is the primary escalation signal)

**Wave**: 5 (optional; after verification)

**Requirements**: E1, S5

**Success Criteria** (what must be TRUE):
  1. A verification-failure / loop / circuit / malformed-tool / complexity signal **with a configured target** ⇒ `setModel(target)` + one retry + a `execution:model_escalated` event; **no target ⇒ behavior unchanged** (E1).
  2. Off-device escalation requires **explicit opt-in + `OutputGuard` redaction + payload scope-limit + canary**; the default target for a local-first deploy is a **larger local** model; a test proves no un-redacted egress without opt-in (S5).
  3. `pnpm validate` green.

---

### Phase 157: RE-PROVE + GA

**Goal**: Prove the milestone goal with numbers; document; hold the gates.

**Depends on**: Phases 150, 152, 153, 154, 155 (and 156 if taken) — re-measures the whole scaffold against the M2 baseline

**Wave**: 6 (final sign-off)

**Requirements**: M3, D1, D2

**Success Criteria** (what must be TRUE):
  1. M3 re-measure vs M2: reliability + efficiency up across the qwen3.6 gradient; **security floor held everywhere**; honest protocol (disclosed judge/rubric, cross-judge ≥2, raw transcripts, N+significance, no-scaffold baseline); report in `.planning/` (M3).
  2. Docs updated in-change for every new config key/env + the **security posture** (model-independent-guarantee statement, `securityLevel` behavior, egress governance) + a recommended secure qwen3.6 config + general-vs-coding-tuned guidance (D1).
  3. `pnpm validate` + `test/architecture/` green; per-package coverage floors held; **no** allowlist additions (D2).

---

### Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 149. PROVE — harness + matrix baseline (M) | 3/3 | Complete   | 2026-06-07 |
| 150. LIVE LOCAL-MODEL TIER (V) | 2/2 | Complete   | 2026-06-07 |
| 151. KEYSTONE — Model Capability Profile (K) | 3/3 | Complete   | 2026-06-07 |
| 152. CAPACITY + PROMPT-SECURITY (C, S) | 5/5 | Complete   | 2026-06-07 |
| 153. RELIABILITY SPINE + memory-security (R, S) | 4/4 | Complete    | 2026-06-07 |
| 154. VERIFICATION + critic isolation (R, S) | 4/4 | Complete    | 2026-06-07 |
| 155. LOCAL + VISION + ORCH + repair-security (L, O, S) | 6/6 | Complete   | 2026-06-07 |
| 156. ESCALATE + egress governance (E, S) *(optional)* | 0/TBD | Not started | - |
| 157. RE-PROVE + GA (M, D) | 0/TBD | Not started | - |

### Requirement Coverage

| Phase | Category | Requirements | Status |
|-------|----------|--------------|--------|
| 149 | M | M1, M2 | Pending |
| 150 | V | V1, V2, V3 | Pending |
| 151 | K | K1, K2 | Pending |
| 152 | C, S | C1, C2, C3, C4, C5, S1, S4 | Pending |
| 153 | R, S | R1, R2, R3, R6, S6 | Pending |
| 154 | R, S | R4, R5, S2 | Pending |
| 155 | L, O, S | L1, L2, L3, L4, L5, L6, L7, O1, O2, O3, S3, S7 | Pending |
| 156 | E, S | E1, S5 | Pending *(optional/deferrable on M2)* |
| 157 | M, D | M3, D1, D2 | Pending |

**Coverage:** 39/39 v2.14 requirements mapped (10 categories, phases 149–157), each to exactly one phase. Unmapped: 0. If Phase 156 (E1, S5) is deferred on M2: 37/37 across Phases 149–155, 157.

### Wave Structure

```
Wave 1 — Measure-first gate (gates the scaffold-heavy phases):
  Phase 149: PROVE — harness + qwen3.6 matrix baseline   ← precursor delivered; gap report reorders/gates 153/154/156

Wave 2 — Live tier + Keystone (after 149):
  Phase 150: LIVE LOCAL-MODEL TIER (test/live/)           ← scaffold delivered; V2 platform-guarantee deepening
  Phase 151: KEYSTONE — Model Capability Profile          ← the keystone every scaffold phase reads

Wave 3 — Scaffold (after the keystone; interleave):
  Phase 152: CAPACITY + PROMPT-SECURITY                   ← budget two-axis + compact secure prompt
  Phase 153: RELIABILITY SPINE + memory-security          ← gated/ordered by the 149 gap report
  Phase 155: LOCAL + VISION + ORCH + repair-security      ← capability-flag wire behavior + NL→DAG scaffolding

Wave 4 — Verification (after the reliability spine):
  Phase 154: VERIFICATION + critic isolation              ← runs /gsd-ai-integration-phase first

Wave 5 — Optional escalation (after verification):
  Phase 156: ESCALATE + egress governance                 ← deferrable if M2 shows the scaffold clears the bar

Wave 6 — Re-prove + GA (final):
  Phase 157: RE-PROVE + GA                                ← M3 re-measure vs M2 + docs + gates
```

---

## Shipped Milestone Detail

Full per-milestone detail lives in `.planning/MILESTONES.md` (authoritative shipped history) and the `milestones/vX-*` archives. Concise pointers below.

<details>
<summary>✅ v2.13 — Live-Fire (Real-Provider Production-Validation Framework) (15 phases 134–148, 72 reqs) — SHIPPED 2026-06-06</summary>

**Goal:** A repeatable, cost-capped, observability-anchored **`test/live/` framework** certifying the whole Comis platform against real LLMs + real external providers — a reproducible `READINESS.md` + append-only ledger instead of a green mock suite.

**Delivered:** 15 phases (134 FOUNDATION → 135 SWEEP → 136 CORE LOOP → {137 CACHE · 138 CTX · 139 MEM · 140 TOOL+MCP · 141 ORCH · 142 MEDIA · 143 WEB · 144 CHAN} depth → 145 SEC · 146 PLAT → 147 E2E journeys → 148 PROVE). **Additive test tooling only — zero `packages/*/src` product change.** Deterministic Stage-A/B certified green in-sandbox; real-provider Stage-C/D deferred to an operator live run (§20). Audit `tech_debt`-accepted (72/72 reqs, 15/15 phases, integration 6/6 WIRED, Nyquist 15/15). **Not merged-to-main / tagged** — branch `feature/v2.13-live-fire` (merge/tag = user's separate step).

Full detail: `milestones/v2.13-ROADMAP.md` + `milestones/v2.13-REQUIREMENTS.md` + `milestones/v2.13-MILESTONE-AUDIT.md`.

</details>

- ✅ **v1.7 — Competitive Hardening (Odysseus Adoption)** (4 phases, 12 plans) — SHIPPED 2026-06-04 — `milestones/v1.7-ROADMAP.md`
- ✅ **v1.6 — Documentation Alignment & Gap-Filling** (6 phases, 26 plans, docs-only) — SHIPPED 2026-06-03 — `milestones/v1.6-ROADMAP.md`
- ✅ **v1.5 — Unified Credential Storage** (7 phases, 32 plans) — SHIPPED 2026-06-02 — `milestones/v1.5-ROADMAP.md`
- ✅ **v1.4 — Credential Broker** (8 phases, 34 plans; R1 forced-egress GO on Linux) — SHIPPED 2026-05-30 — `milestones/v1.4-ROADMAP.md`
- ✅ **v1.3 — MCP OAuth Handoff & Device-Flow** (2 phases, 13 plans) — SHIPPED 2026-05-29 — `milestones/v1.3-REQUIREMENTS.md`
- ✅ **v1.2 — MCP Hardening II** (5 phases A–E) — SHIPPED 2026-05-28 — `milestones/v1.2-REQUIREMENTS.md`
- ✅ **v1.1 — MCP Hardening** (5 phases, 18 plans) — SHIPPED 2026-05-26
- ✅ **v1.0 — Observability Initiative** (6 phases + M3) — SHIPPED 2026-05-25 — `milestones/v1.0-ROADMAP.md`

---

*Last updated: 2026-06-07 — Roadmap created for v2.14 Small-Model Excellence (qwen3.6). 9 phases (149–157, design-local 1–9): PROVE harness+matrix → LIVE local-model tier → KEYSTONE ModelProfile → CAPACITY+prompt-security → RELIABILITY spine+memory-security → VERIFICATION+critic isolation → LOCAL+VISION+ORCH+repair-security → ESCALATE+egress (optional) → RE-PROVE+GA. 39 reqs (M/V/K/C/R/S/L/O/E/D). Authored-from-design (not the roadmapper). Global phase numbering continued (v2.13 ended at 148). Source design: `.planning/design/SMALL_MODEL_EXCELLENCE_DESIGN.md`.*
