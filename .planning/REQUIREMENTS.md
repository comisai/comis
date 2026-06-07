# Requirements: Comis v2.14 — Small-Model Excellence (qwen3.6)

**Defined:** 2026-06-07
**Core Value (this milestone):** Comis runs **reliably, efficiently, and — above all — securely** on small local models (the qwen3.6 family, and any local model), with the **security guarantees holding independent of which model is swapped in** — capable, private, and safe by construction.
**Source design:** `.planning/design/SMALL_MODEL_EXCELLENCE_DESIGN.md` (authoritative — these requirements are §7, verbatim; phase mapping is §8–§9). Authored-from-design, **not** the roadmapper.

Three co-equal pillars (§0): **Reliability** (externalize the weak executive's function into a tier-aware scaffold) · **Security-first** (platform controls hold regardless of model; weaker `capabilityClass` ⇒ stricter `securityLevel`) · **Local fit** (256K over-provisioning, vision, native reasoning, MLX/GGUF). Measure-first: the §7.1–7.3 baseline (full qwen3.6 matrix 9/9, security floor 100/0/0 even bare; comprehension 35b 8/8 / 27b 7/8) is delivered and reorders/gates the reliability/local phases.

**Posture:** TDD/RED-first on every requirement; **no backward compatibility** (`no-backward-compat.test.ts`); each new component designed **fail-closed**; under `pnpm validate` + `test/architecture/`. Annotations: *(precursor delivered)* = standalone/scaffold landed in `#169`; *(deferrable on M2)* = build/defer decision made from Phase 149's gap report.

---

## v2.14 Requirements

Each maps to exactly one roadmap phase (see Traceability). Phases use the project's global numbering (149–157); the design's local Phase 1–9 map onto them.

### Measurement (M)

- [x] **M1**: A deterministic replay harness reproduces the snake+MSFT incident + a curated reliability/security/efficiency suite, runs any configured model+profile **through the real Comis executor** (Ollama provider), and emits per-scenario metrics: success, constraint-adherence, derailment, false-success, poison, **injection-resisted, secret-leaked, over-refused**, tokens, latency, history-retention. *(Standalone model-isolation precursor delivered — `scripts/bench-small-model/`, §7.1.)*
- [x] **M2**: A **baseline across the qwen3.6 matrix** (§7.2) — 27b/35b GGUF + 27b/35b-mlx, fair & bare prompts, + cross-family comparators (`gpt-oss:20b`, `qwen2.5:32b`) + a frontier control — recorded as the gate/reorder input for the reliability/verification/escalation phases.
- [ ] **M3**: A re-measure proves lift vs M2 (reliability+efficiency up; **security floor held across the whole gradient**) under the honest protocol: disclosed judge/rubric, cross-judge ≥2, raw transcripts, N+significance, cost+latency, no-scaffold baseline included.

### Live test tier (V) — `test/live/`

- [x] **V1**: A `test/live/` tier (live-tier vitest config; `COMIS_LIVE` + Ollama-readiness gated; sequential daemon boot; **excluded from default `pnpm test`** per the `projects` list) drives each present qwen3.6 variant **end-to-end through the real daemon/executor** and scores every scenario; a Stage-A portion runs deterministically with `COMIS_LIVE` unset (so the file is CI-safe). *(Scaffold delivered, §7.2.)*
- [x] **V2**: Security invariants are **HARD assertions via the existing live-fire oracles** (log-oracle / observe / db-oracle): the *delivered* output never contains the marked secret/canary (proves `OutputGuard` fired), an injected tool-result instruction is not followed, the exec **sandbox blocks** the injected command, and the **frozen** trust-filter/write-validator hold — for every variant across the gradient (ties S2/S6/S7). *(The marked daemon-routed platform-guarantee deepening.)*
- [x] **V3**: The tier **reuses the standalone `scripts/bench-small-model/` scenario+scorer contract** (single source of truth) and emits the M1/M3 reports; correctness + efficiency + security metrics per variant.

### Keystone (K)

- [x] **K1**: A single immutable `ModelProfile` is resolved once per execution and threaded via `Deps`; ad-hoc `resolveModelTier`/`resolvedModel` consumers read from it (behavior-neutral; characterization-tested).
- [x] **K2**: `capabilityClass` is **decoupled** from `contextWindow`; scaffold *and* `securityLevel` key off `capabilityClass`, budget keys off `contextWindow`. Unknown local models default to the most-scaffolded / most-locked class.

### Capacity (C)

- [x] **C1**: Budget reserves (`O,R,M,P`) are functions of the `ModelProfile`, handling **both** an 8K window (no zero-history) **and a 256K window with a small executive (effective-context cap below the raw window)**; large-tier numbers byte-identical; the 3.5-ratio over-reservation invariant (`recall-dag-budget-partition`) preserved.
- [x] **C2**: A **compact secure-primary prompt** assembles to a bounded target (~3K) that **retains the safety core, sender-trust, and config-secret security sections** (never minimal-mode's empty safety); interactive-only sections JIT-deferred.
- [x] **C3**: Per-turn preamble bounded for the profile (cap + WARN; deferred-tools list compressed).
- [x] **C4**: For low-`capabilityClass` primaries, compaction **prefers eviction / lossless-store+recall over same-weak-model summarization** (or a configured stronger summarizer); never silently degrades summaries (logged + observable).
- [x] **C5**: Context-engine **mode** (`pipeline` ↔ `dag`/LCD) is profile-driven and **both modes honor C1 (effective-context cap) + C4 (compaction routing)**; a low-`capabilityClass` primary never LLM-summarizes its own history with itself in *either* mode (pipeline's `llm-compaction` layer + LCD's leaf-summarizer both gate on capability — eviction/strong-summarizer instead). A test pins this for both engines. *(Prompt-efficiency is comprehension-gated: any compact-prompt shrink (C2/S1) is shrunk only where the comprehension harness (§7.3) shows comprehension holds across the gradient; the security core is never shrunk.)*

### Reliability (R)

- [x] **R1**: A **user-derived GoalAnchor** (objective + requirement checklist + done-criteria) injected at the context tail every turn for scaffolded tiers, extending `ExecutionPlanHolder`.
- [x] **R2**: On any safety abort (loop/step/circuit), the agent **re-asserts the user's actual request** before the final message.
- [x] **R3**: A **memory relevance floor** gates injection on **base** relevance (`scoreWithBreakdown().base`) so boosts can't resurrect an irrelevant memory; small/overfill profiles additionally cap injected count/chars.
- [x] **R4**: A pre-delivery **critic** checks the terminal, completion-claiming response against the checklist; unmet ⇒ bounded redirect; else honest annotation — extending `modelAcknowledgedFailure` to goal-consistency. Gated by `minResponseChars` + completion-claim heuristic; reasoning-budget-aware (L5).
- [x] **R5** *(scaffoldLevel=max; deferrable on M2)*: A pre-execution **planner** builds the checklist that seeds R1/R4.
- [x] **R6**: Memory's model-heavy ops are **capability-routed**: extraction (triple/relationship/user-rep), consolidation, and especially **`memory_ask` dialectic synthesis** (highest hallucination risk) route to a capable model or **abstain-hard**; vector search + FTS + the usefulness bandit stay local (local-GGUF embedding). A pure-local deploy routes them to the largest local variant and documents the quality floor. A test proves dialectic synthesis **abstains rather than fabricates citations** under a weak model.

### Security (S) — security-first; each new component fails closed

- [x] **S1**: The compact prompt (C2) **retains a real safety/constitutional core + sender-trust + config-secret**; `securityLevel` scales lockdown (weaker model ⇒ smaller toolset, more deferral, mandatory sandbox, lower injection thresholds). A test asserts the safety core is present in the small-primary prompt and that lockdown tightens as `capabilityClass` drops.
- [x] **S2**: The critic/planner (R4/R5) treat the output-under-review as **untrusted** (`wrapExternalContent`), inherit the constitutional safety core, embed the **canary**, **fail closed** (uncertain ⇒ not-verified, never auto-approve), and **re-validate** any tool calls they imply through the *same* exec gates (never widen scope).
- [x] **S3**: Tool-call **repair** (L3) re-runs the full validation/security gates; it may only fix shape/narrow, **never widen scope or bypass the denylist**; fail-closed on irreparable.
- [x] **S4**: Eviction/compaction **pins** security-relevant context (sender-trust, safety reinforcement, untrusted-content markers, canary) — never evicts them; the lossless store retains the audit record regardless.
- [ ] **S5**: Escalation (E1) is **data-egress-governed**: off-device targets require explicit opt-in + `OutputGuard` redaction + payload scope-limit + canary; the default escalation target for a local-first deploy is a **larger local** model. Local-only egress (no model data leaves device) is the documented default and a headline benefit.
- [x] **S6**: The recall **trust-filter (`FROZEN_TRUST_PATHS`)**, `MemoryWriteValidator`, and the R3 relevance-floor (a poisoning defense) remain enforced for all `capabilityClass`es; a test proves a weaker profile cannot relax them.
- [x] **S7**: **Image inputs are treated as untrusted** (vision = an injection vector): image-derived/native-vision turns are flagged untrusted, the canary/`OutputGuard` still apply, and a test covers an image-borne instruction not being followed.

### Local / qwen3.6 (L)

- [x] **L1**: `ModelProfile` capability flags drive behavior (tool path, `tool_search` gating, cache split) — provider-name special-casing removed where a flag now covers it.
- [x] **L2**: When `supportsPromptCache=false`, prompt assembly emits a **single block** (no `cache_control` split).
- [x] **L3**: A **tool-call repair** seam normalizes near-miss tool JSON (constrained decoding where `supportsStructuredOutput`; lenient parse+repair otherwise), feeding the existing validation formatter + retry breaker (validation carve-out preserved; S3 governs).
- [x] **L4**: **Vision** is declared (`input:["text","image"]`) for qwen3.6 27b/35b and **verified** by an integration test (real Ollama image round-trip — wire-proven 2026-06-07); a text-only/MLX profile cleanly skips image attach (no silent drop without a WARN).
- [x] **L5**: **Reasoning-budget aware**: `reasoningStyle="native"` profiles size `maxOutputTokens` so `reasoning_content` does not starve the visible answer; the critic/planner account for it; a test pins the sizing.
- [x] **L6**: **MLX vs GGUF perf** measured by the harness (latency/throughput per scenario); docs recommend the faster local runtime per platform; no Comis-level code distinction required (both opaque Ollama tags).
- [x] **L7**: The prompt-cache multi-block split is **confirmed bypassed** for non-caching providers (verified: Ollama `providerFamily="default"` → cache-breakpoint orchestration skipped, zero overhead) and Ollama **keep-alive / KV-cache** is exploited for cross-turn prompt reuse; a test pins the no-cache-overhead invariant and that the bypass never drops a security section.

### Orchestration (O) — NL→DAG fleets for small models *(the one measured comprehension cliff — §7.3)*

- [x] **O1**: A model-emitted execution graph passes the existing validation (cycle/dup/missing-dep/topo-sort) AND a **bounded repair loop** feeds the validator's actionable fix-hints back to the model and re-prompts (the validation exists today; the auto-repair loop is new) — a malformed DAG is corrected, not abandoned.
- [x] **O2**: **Pre-structured DAG templates** (saved `pipeline` graphs with `${VAR}` slots: research-fanout, debate, vote, map-reduce) let a low-`capabilityClass` model **fill slots** instead of emitting full graph JSON.
- [x] **O3**: NL→DAG is **measured** across the gradient (the comprehension harness orchestration probe; 35b ✅ / 27b ✗ today); O1/O2 engage by `capabilityClass` — a capable model emits the graph directly (unchanged), a weaker one gets templates/repair. A test proves the weak path yields a valid graph for the canonical "research-3-then-debate" instruction.

### Escalation (E) — optional; hybrid only

- [ ] **E1** *(deferrable on M2)*: Failover extends to **signal-triggered** (circuit/loop/verification-failure/malformed-tool/complexity), escalating to a configured target (local-first per S5); emits `execution:model_escalated`; no target ⇒ behavior unchanged (S-group + WS-1..R stand alone).

### Docs / GA (D)

- [ ] **D1**: Docs updated in-change for every new config key/env + the **security posture** (the model-independent-guarantee statement, `securityLevel` behavior, egress governance) + a **recommended secure qwen3.6 config** + general-vs-coding-tuned guidance.
- [ ] **D2**: `pnpm validate` + `test/architecture/` green; per-package coverage floors held; **no** allowlist additions.

---

## Out of Scope

Explicitly excluded (design §4, §11 non-goals). Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Redesigning the memory / channel / security cores | Extend ports/schemas in place; this milestone hardens and completes a real foundation (§2), it does not rebuild it. |
| Backward-compat shims (migration code, fallbacks, alias re-exports, deprecated paths) | No-BC per `AGENTS.md §2.9`; the `ModelProfile` keystone, tier-scaled budget, compact prompt, and compaction strategy *replace* the ad-hoc paths outright (`no-backward-compat.test.ts`). |
| Speculative / unused config | Schema-first `.default()` + `SECTION_REGISTRY`; only the keys the requirements actually consume are added. |
| A workflow engine (scripting the task) | A DM agent must handle anything; the scaffold narrows *choices*, it does not script the task (§4). |
| Fine-tuning / model training | This is a scaffold, not model surgery; it raises the floor around any model (§4, §11). |
| Cloud routing as the default | Local is chosen for privacy/cost/offline; routing to cloud defeats it. Cloud is kept only as *optional, egress-governed* escalation (E1/S5). |
| Raising the raw reasoning of a small model | Honest limit (§4/§11): scaffolding raises reliability, efficiency, and the security *floor* — not reasoning a 3–7B model lacks. Class > size; general > coding-tuned. |

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| M1 | Phase 149 | Pending *(precursor delivered)* |
| M2 | Phase 149 | Complete |
| V1 | Phase 150 | Pending *(scaffold delivered)* |
| V2 | Phase 150 | Complete |
| V3 | Phase 150 | Complete |
| K1 | Phase 151 | Complete |
| K2 | Phase 151 | Complete |
| C1 | Phase 152 | Complete |
| C2 | Phase 152 | Complete |
| C3 | Phase 152 | Complete |
| C4 | Phase 152 | Complete |
| C5 | Phase 152 | Complete |
| S1 | Phase 152 | Complete |
| S4 | Phase 152 | Complete |
| R1 | Phase 153 | Complete |
| R2 | Phase 153 | Complete |
| R3 | Phase 153 | Complete |
| R6 | Phase 153 | Complete |
| S6 | Phase 153 | Complete |
| R4 | Phase 154 | Complete |
| R5 | Phase 154 | Pending *(deferrable on M2)* |
| S2 | Phase 154 | Complete |
| L1 | Phase 155 | Complete |
| L2 | Phase 155 | Complete |
| L3 | Phase 155 | Complete |
| L4 | Phase 155 | Complete |
| L5 | Phase 155 | Complete |
| L6 | Phase 155 | Complete |
| L7 | Phase 155 | Complete |
| O1 | Phase 155 | Complete |
| O2 | Phase 155 | Complete |
| O3 | Phase 155 | Complete |
| S3 | Phase 155 | Complete |
| S7 | Phase 155 | Complete |
| E1 | Phase 156 | Pending *(optional/deferrable on M2)* |
| S5 | Phase 156 | Pending *(optional/deferrable on M2)* |
| M3 | Phase 157 | Pending |
| D1 | Phase 157 | Pending |
| D2 | Phase 157 | Pending |

**Coverage:**
- v2.14 requirements: **39** total (M3 + V3 + K2 + C5 + R6 + S7 + L7 + O3 + E1 + D2 = 3+3+2+5+6+7+7+3+1+2)
- Mapped to phases: **39** (each to exactly one phase)
- Unmapped: **0** ✓
- If Phase 156 (E1, S5) is deferred on M2: **37/37** across Phases 149–155, 157.

---
*Requirements defined: 2026-06-07 — authored directly from `SMALL_MODEL_EXCELLENCE_DESIGN.md` §7–§9 (no-roadmapper convention).*
*Last updated: 2026-06-07 after initial definition.*
