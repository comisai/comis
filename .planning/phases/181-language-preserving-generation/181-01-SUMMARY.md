---
phase: 181-language-preserving-generation
plan: 01
subsystem: api
tags: [det-02, reply-language, scriptShares, i18n, config-schema, zod, executor]

# Dependency graph
requires:
  - phase: 179-script-classification
    provides: "scriptShares / dominantScript / classifyCodepoint in @comis/core"
provides:
  - "resolveReplyLanguage — the pure DET-02 reply-language resolver (config>USER.md>script he/ar/ru on strict >0.5 majority>en); the dependency root for GEN-02 (181-03) and GEN-03 (181-04/05)"
  - "agents.<id>.language config key (z.string().optional(), BCP-47 or display name) on AgentConfigSchema → PerAgentConfig"
  - "PostExecutionParams.userMdLanguage (tier-2) threaded prompt-assembly → pi-executor → postExecution"
affects: [181-03, 181-04, 181-05, GEN-02, GEN-03, degraded-reply-i18n, DOC-01]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure total text-primitive value fn (plain string, never throws, no I/O/log) — mirrors dominantScript"
    - "scriptShares + strict >0.5 majority of non-neutral codepoints for language detection (NOT dominantScript's 0.30 floor)"
    - "z.string().optional() config-key (transcription-hint shape) reaching PerAgentConfig via AgentConfigSchema.extend"
    - "Thin call-site in allowlisted executor files; resolver body in a sibling module"

key-files:
  created:
    - "packages/agent/src/executor/resolve-reply-language.ts"
    - "packages/agent/src/executor/resolve-reply-language.test.ts"
  modified:
    - "packages/core/src/config/schema-agent/schema-agent-runtime.ts"
    - "packages/core/src/config/schema-agent/schema-agent-runtime.test.ts"
    - "packages/agent/src/executor/prompt-assembly.ts"
    - "packages/agent/src/executor/pi-executor/pi-executor.ts"
    - "packages/agent/src/executor/executor-post-execution.ts"
    - "packages/agent/src/executor/executor-post-execution.test.ts"
    - "docs/reference/config-yaml.mdx"

key-decisions:
  - "Tier-3 calls scriptShares directly with a strict >0.5 check — NOT dominantScript (its 0.30 non-Latin floor returns hebrew for a 40%-Hebrew message; live-verified divergence pinned by the keystone test)"
  - "Unknown config/USER.md values fall through to the next tier (never short-circuit to en); only a known closed-set key wins early"
  - "Resolver returns a plain string (text-primitive convention), NOT Result<T,E> — a total pure fn needs no error channel"
  - "ExecutionPromptResult gained userLanguage?: string (the return-type interface had to carry the field) — Rule 3 blocking fix"

patterns-established:
  - "DET-02 closed table key (en|he|ar|ru) via normalizeToTableKey: lowercase + primary BCP-47 subtag + English display-name + iw alias"
  - "Parent-cache reuse path returns userLanguage: undefined to keep the assembler return type uniform"

requirements-completed: [DET-02]

# Metrics
duration: 11min
completed: 2026-06-13
---

# Phase 181 Plan 01: Language-preserving generation (DET-02 resolver) Summary

**Pure `resolveReplyLanguage` resolver (config → USER.md → script he/ar/ru on a strict >0.5 majority of non-neutral codepoints → en) plus the `agents.<id>.language` config key and the tier-2 `userMdLanguage` threading — the deterministic dependency root for GEN-02/GEN-03.**

## Performance

- **Duration:** ~11 min (active work; +~10 min fresh-worktree install/build)
- **Started:** 2026-06-13T09:33:42Z (first commit)
- **Completed:** 2026-06-13T09:40:46Z (last commit)
- **Tasks:** 3
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments
- **`resolveReplyLanguage`** — a pure, total, never-throwing 4-tier resolver. Tier-3 uses `scriptShares` with a STRICT `> 0.5` majority of non-neutral codepoints (mapping hebrew→he, arabic→ar, cyrillic→ru; cjk and every other class fall through), deliberately NOT reusing `dominantScript`'s 0.30 non-Latin floor. Unknown config/USER.md values fall through (never short-circuit to en). No conversation-level rolling state.
- **`agents.<id>.language`** config key on `AgentConfigSchema` (`z.string().optional()`, BCP-47 or English display name), reaching `PerAgentConfig` via the existing `AgentConfigSchema.extend` — no second edit. Documented in `config-yaml.mdx` in the same change-set (Docs-Current).
- **`PostExecutionParams.userMdLanguage`** (tier-2) threaded `prompt-assembly` → `pi-executor` → `postExecution` with thin edits to the two file-size-allowlisted executor files (no allowlist add). `en`/undefined path byte-identical (I1).

## Task Commits

Each task committed atomically (TDD RED→GREEN per task):

1. **Task 1: Pure resolver + config key** — `2f69cbb1` (test RED) → `c96b74d7` (feat GREEN)
2. **Task 2: Thread tier-2 userMdLanguage** — `1de1a480` (test RED) → `5c71e8ab` (feat GREEN)
3. **Task 3: Docs — agents.<id>.language** — `92a81954` (docs)

_Plan metadata commit (this SUMMARY) follows separately._

## Files Created/Modified
- `packages/agent/src/executor/resolve-reply-language.ts` — NEW. The pure DET-02 resolver (`resolveReplyLanguage`, `ReplyLanguage`, `ResolveReplyLanguageInput`) + private `normalizeToTableKey` / `scriptDefault`.
- `packages/agent/src/executor/resolve-reply-language.test.ts` — NEW. Full resolution-order matrix incl. the plurality-not-majority Hebrew→en keystone, the exact-50/50→en boundary, and cjk→en.
- `packages/core/src/config/schema-agent/schema-agent-runtime.ts` — `AgentConfigSchema` += `language: z.string().optional()`.
- `packages/core/src/config/schema-agent/schema-agent-runtime.test.ts` — DET-02 config-key triplet (optional-absent / valid / invalid non-string).
- `packages/agent/src/executor/prompt-assembly.ts` — `ExecutionPromptResult` += `userLanguage?: string`; full return carries the in-scope const; parent-cache reuse path returns `userLanguage: undefined`.
- `packages/agent/src/executor/pi-executor/pi-executor.ts` — destructure `userLanguage` off `promptResult`; pass `userMdLanguage: userLanguage` into the `postExecution({...})` call (thin: +1 net line).
- `packages/agent/src/executor/executor-post-execution.ts` — `PostExecutionParams` += `userMdLanguage?: string` (thin: +3 lines; no resolver call — 181-03 wires that).
- `packages/agent/src/executor/executor-post-execution.test.ts` — DET-02 tier-2 type contract (`expectTypeOf`) + 3 source-grep wiring pins (interface field, prompt-assembly return, pi-executor threading).
- `docs/reference/config-yaml.mdx` — `agents.<id>.language` per-key AgentConfig reference row.

## Decisions Made
- **scriptShares >0.5, not dominantScript** — verified live before any code: `scriptShares("שלום שלום docker test 12345")` → Hebrew 0.4444 / Latin 0.5556 while `dominantScript` returns `hebrew`. The strict-majority rule is the load-bearing DET-02 difference; the keystone test asserts `en` for this and the exact-0.5 case.
- **Fall-through, not en-shortcut** — an unsupported config value (e.g. `"fr"`) must let a lower tier win (all-Hebrew inbound still → `he`), pinned by a dedicated test.
- **Plain string return** — the resolver is a total text-primitive value fn (like `dominantScript`/`scriptTokenFactor`); no `Result<T,E>`, "en" is the floor.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extended `ExecutionPromptResult` with `userLanguage?: string`**
- **Found during:** Task 2 (Thread tier-2 userMdLanguage)
- **Issue:** `assembleExecutionPrompt` has an explicit `ExecutionPromptResult` return-type interface (prompt-assembly.ts:628). Adding `userLanguage` to the two return object literals failed `tsc` (TS2353 "Object literal may only specify known properties") and the destructure in pi-executor failed (TS2339). The plan named the return-object edits but not the interface edit.
- **Fix:** Added `userLanguage?: string` to the `ExecutionPromptResult` interface with a doc comment.
- **Files modified:** `packages/agent/src/executor/prompt-assembly.ts`
- **Verification:** `tsc -b packages/agent` clean; `executor-post-execution.test.ts` 122/122 green.
- **Committed in:** `5c71e8ab` (Task 2 GREEN commit)

**2. [Rule 1 - Lint hygiene] Suppressed a `security/detect-object-injection` warning with justification**
- **Found during:** Task 1 (resolver GREEN)
- **Issue:** `SCRIPT_TO_LANGUAGE[cls]` (dynamic bracket access) raised a `security/detect-object-injection` warning. The codebase's consistent practice is to suppress it with a documented justification rather than leave the security-lint output dirty.
- **Fix:** `// eslint-disable-next-line security/detect-object-injection -- cls is a closed ScriptClass union key from scriptShares, never user-controlled`. Matches the established precedent (e.g. `signature-block-scrubber.ts`).
- **Files modified:** `packages/agent/src/executor/resolve-reply-language.ts`
- **Verification:** `eslint --config eslint.config.js resolve-reply-language.ts` → 0 warnings; full `lint:security` → 0 errors.
- **Committed in:** `c96b74d7` (Task 1 GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 lint hygiene)
**Impact on plan:** Both were required to land the planned wiring/file cleanly. No scope creep — no behavior beyond the plan; the resolver remains unused at runtime until 181-03 (expected this wave).

## Issues Encountered
- **Fresh-worktree environment** — the worktree had no `node_modules`/`dist`; the first sandboxed `pnpm install` no-op'd against the parent checkout. Resolved by re-running `pnpm install` + `pnpm build` (sandbox disabled), which materialized the worktree's `node_modules`/`dist` and the `vitest` binary.
- **Plan-base typo** — the orchestrator passed base `26f2ee69…`; the real Phase-180-merged feature-branch tip is `26f2ea69…` (one-char `a`/`e` difference). The worktree HEAD was several commits behind it. Corrected via the `<worktree_branch_check>` reset to `26f2ea69993a41f2805b5c0fc816830ee36efb07` (the documented allowed reset).

## Verification (all green)
- `vitest run` resolve-reply-language.test.ts + schema-agent-runtime.test.ts + executor-post-execution.test.ts → **159 passed**.
- `tsc -b packages/core packages/agent` → clean.
- `pnpm docs:check` → 159 docs clean.
- `pnpm lint:security` → **0 errors** (2099 pre-existing warnings tree-wide; no `--max-warnings`).
- `file-size.test.ts` → 51/51 (both executor files allowlisted; **no allowlist entry added** — shrink-only honored). Thin-edit deltas: executor-post-execution +3, pi-executor +1 net.
- `no-tracked-ignored-files.test.ts` → pass (no `.planning` leak).

## Known Stubs
None. The `return undefined` paths in `normalizeToTableKey`/`scriptDefault` are intentional fall-through logic, not stubs. The resolver is unused at runtime until 181-03 (GEN-02) wires it at the degraded-reply chokepoint — that is the planned wave sequencing, not a stub.

## Next Phase Readiness
- **181-03 (GEN-02)** can now `import { resolveReplyLanguage } from "./resolve-reply-language.js"` and call it at the degraded block in `executor-post-execution.ts`, passing `{ inboundText: msg.text, configLanguage: config.language, userMdLanguage: params.userMdLanguage }`. All three tier inputs are in scope (config tier-1, userMdLanguage tier-2 now threaded, msg.text tier-3).
- **181-04/05 (GEN-03)** reuse the same resolution at the parent for `RequestContext.resolvedLanguage`.
- No blockers.

## Self-Check: PASSED

- All 2 created files present (`resolve-reply-language.ts` + its test).
- All 5 modified files present.
- All 5 task commits present in git (`2f69cbb1`, `c96b74d7`, `1de1a480`, `5c71e8ab`, `92a81954`).

---
*Phase: 181-language-preserving-generation*
*Completed: 2026-06-13*
