---
phase: 25-sync-tooling-cli
plan: 01
subsystem: cli
tags:
  - sync-tooling
  - yaml-ast
  - cli-helpers
  - phase-25

# Dependency graph
requires:
  - phase: 23-tooling-capability-port
    provides: "Daemon-side ToolCapabilityPort + tooling.* config schema (capabilityClusters, mcp.capabilityHints, skills.capabilityHints, installDetours, capabilityIndex) — what these helpers materialize into config.yaml"
  - phase: 24-phase-8-integration-behavioral-metrics
    provides: "Test-fixture pattern under packages/agent/src/__tests__/fixtures/phase-8-skill-variants — template for SKILL.md fixture shape"
provides:
  - "Pure helper modules for `comis config sync-tooling` — discover.ts (MCP + skill discovery), generate.ts (yaml@2.8.4 AST mutators), diff.ts (inspect-mode renderers)"
  - "Test fixtures: config-no-tooling.yaml, config-with-tooling.yaml, skills/stub-skill/SKILL.md"
  - "Verified yaml@2.8.4 AST patterns: doc.createNode for empty maps, Scalar key + commentBefore for `# TODO` comments on `replacesPackages`, byte-identical roundtrip on unchanged configs, Pitfall 9 doc.contents=null guard"
affects:
  - "Plan 25-02 (atomic write + backup + daemon guard) — consumes generate.applyToDocument output"
  - "Plan 25-03 (Commander wiring) — consumes diff.renderInspect{Human,Json} for inspect mode"
  - "Plan 25-04 (integration test) — uses these fixtures and the full helper pipeline"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "yaml@2.8.4 AST mutation with comment + key-order preservation (Document/parseDocument roundtripping)"
    - "Inline frontmatter parser (split on `---` markers + yaml.parse) — avoids @comis/skills internal coupling per RESEARCH Pitfall 3"
    - "doc.createNode({}) for empty maps so subsequent setIn calls can traverse (yaml's setIn refuses to walk into a bare JS object value)"
    - "Replace string Pair keys with Scalar(name) before assigning commentBefore — yaml represents map keys as raw strings by default after setIn"

key-files:
  created:
    - "packages/cli/src/sync-tooling/discover.ts"
    - "packages/cli/src/sync-tooling/discover.test.ts"
    - "packages/cli/src/sync-tooling/generate.ts"
    - "packages/cli/src/sync-tooling/generate.test.ts"
    - "packages/cli/src/sync-tooling/diff.ts"
    - "packages/cli/src/sync-tooling/diff.test.ts"
    - "packages/cli/src/sync-tooling/__tests__/fixtures/config-no-tooling.yaml"
    - "packages/cli/src/sync-tooling/__tests__/fixtures/config-with-tooling.yaml"
    - "packages/cli/src/sync-tooling/__tests__/fixtures/skills/stub-skill/SKILL.md"
  modified: []

key-decisions:
  - "Pitfall 6: generate.ts ALWAYS emits `description: \"TODO\"` literal for newly-generated MCP hints (McpServerEntrySchema has NO description field; the daemon-side hint schema requires non-empty string, so the operator-friendly stub is `\"TODO\"`)"
  - "Pitfall 7: discover.ts reads `comis.capability.summary` (NOT `comis.capability.description`, which does not exist in ComisCapabilityBlockSchema). Priority: summary > frontmatter.description > undefined; the stub fires later in generate.ts"
  - "RESEARCH Open Question 1: discoverSkills UNIONS discoveryPaths across all agents (not per-agent), deduped by skill name with first-loaded-wins. Matches the intent that a skill installed for any agent is materially \"installed\" from a sync perspective"
  - "doc.createNode({}) over bare {} for empty maps — empirically required because yaml@2.8.4's setIn walks YAMLMap nodes but rejects plain JS objects (verified via runtime spike)"
  - "Operator-note commentBefore is attached to the yfinance Pair's key in the fixture by placing yfinance as the SECOND entry in the capabilityHints map (between two siblings) — when the comment is at the start of the map, yaml attaches it to the map node itself, not the first entry's key"
  - "applyToDocument incremental branch ONLY creates parent maps (`tooling.mcp.capabilityHints`, `tooling.skills.capabilityHints`) when there's something to add — preserves byte-identity for unchanged configs (REQ-7)"
  - "applyToDocument overwrite branch GUARDS deleteIn calls with hasIn checks — yaml's deleteIn throws on missing intermediate paths, breaking partial-block configs (e.g. tooling.mcp present but tooling.skills absent)"

patterns-established:
  - "Pattern 1: Pitfall 9 doc.contents=null guard — `if (doc.contents == null) doc.contents = doc.createNode({})` before any setIn on an empty file"
  - "Pattern 2: commentBefore on a setIn-created Pair — find the Pair, replace its raw-string key with `new Scalar(name)`, then assign `key.commentBefore`"
  - "Pattern 3: First-loaded-wins dedupe via Map (mirrors @comis/skills/src/registry/discovery.ts:382-384 without importing it)"
  - "Pattern 4: Inline frontmatter parser is preferred over @comis/skills/src/manifest/parser.ts because parser.ts is not barrel-exported (RESEARCH Pitfall 3)"
  - "Pattern 5: chalk.level=1 in vitest beforeAll — vitest pipes stdout, chalk auto-detects no-TTY and disables colors; tests that assert SGR codes need explicit level"

requirements-completed:
  - SPEC-2
  - SPEC-3
  - SPEC-4
  - SPEC-5
  - SPEC-7

# Metrics
duration: 11min
completed: 2026-05-10
---

# Phase 25 Plan 01: Sync-Tooling Helpers Summary

**Pure-function YAML AST helpers (`discover.ts`, `generate.ts`, `diff.ts`) for `comis config sync-tooling` — MCP/skill discovery, four-section skeleton emission, append-only AST mutation with comment + key-order preservation, and inspect-mode rendering.**

## Performance

- **Duration:** 11 min (07:37–07:48 local)
- **Started:** 2026-05-10T04:37:44Z
- **Completed:** 2026-05-10T04:48:02Z
- **Tasks:** 3 (all green; TDD RED → GREEN per task)
- **Files created:** 9 (3 source, 3 test, 3 fixture)

## Accomplishments

- All 28 vitest cases pass (10 discover + 11 generate + 7 diff). `cd packages/cli && pnpm exec vitest run src/sync-tooling/` exits 0.
- `pnpm build` exits 0 — no TS errors; cli's tsconfig already includes `src/**` so the new directory ships in `dist/`.
- `pnpm lint:security` exits 0 errors (1483 warnings, all pre-existing across the repo; sync-tooling adds 2 object-injection-sink warnings consistent with surrounding codebase).
- Full repo `pnpm test` passes: 1034 test files, 20751 tests passed — no regressions in any other package.
- All four anti-regression greps return 0 (no js-yaml, no process.env, no path.join, no comis.capability.description).
- Verified empirically (runtime spikes) that `doc.toString()` is byte-identical to the input on unchanged configs (REQ-7) and that `key.commentBefore` renders as `# TODO: ...` after Scalar-wrapping the key (Pitfall 5).

## Task Commits

Each task was committed atomically (TDD RED → GREEN per task):

1. **Task 1: discover.ts + tests + fixtures**
   - RED: `c857912` (test) — 10 failing vitest cases + 3 fixtures
   - GREEN: `c807262` (feat) — readMcpServers + discoverSkills implementation

2. **Task 2: generate.ts AST mutators**
   - RED: `536697b` (test) — 11 failing vitest cases for skeleton/plan/apply
   - GREEN: `9aabc26` (feat) — buildSkeleton + computeMutationPlan + applyToDocument; updated fixture so the operator-note commentBefore attaches to yfinance's Scalar key

3. **Task 3: diff.ts inspect-mode renderers**
   - RED: `59f5506` (test) — 7 failing vitest cases
   - GREEN: `75f7548` (feat) — renderInspectHuman + renderInspectJson + renderUnifiedDiff

## Files Created

### Source (3)

- `packages/cli/src/sync-tooling/discover.ts` — `readMcpServers` (pure config read) + `discoverSkills` (filesystem walk + frontmatter parse + first-loaded-wins dedupe + agent-paths union). Uses `safePath` for all path composition; never throws (silent-skip on malformed input).
- `packages/cli/src/sync-tooling/generate.ts` — `buildSkeleton` (four-section block init), `computeMutationPlan` (read-only diff against existing AST), `applyToDocument` (skeleton / incremental / overwrite branches). Strict adherence to D-17 (managed sections only), D-19 (capabilityClusters preserved verbatim), D-22 (existing entries never overwritten).
- `packages/cli/src/sync-tooling/diff.ts` — `renderInspectHuman` (D-04 section list), `renderInspectJson` (deterministic key order), `renderUnifiedDiff` (50-line capped, mirrors daemon's `last-known-good.ts:101-127`). Pure functions — no console, no I/O.

### Tests (3)

- `packages/cli/src/sync-tooling/discover.test.ts` — 10 cases covering MCP enumeration (incl. defensive skip on malformed), skill walk + dedupe, Pitfall 7 description priority, per-agent path union (RESEARCH Open Question 1).
- `packages/cli/src/sync-tooling/generate.test.ts` — 11 cases covering skeleton, MCP/skill hint emission with commentBefore on `replacesPackages`, computeMutationPlan, append-only preservation (`# operator note` survives slack-mcp addition), pruning (Pitfall 4 — commentBefore dies with the Pair), D-17/D-19/D-22 invariants, REQ-7 byte-identical roundtrip on unchanged config.
- `packages/cli/src/sync-tooling/diff.test.ts` — 7 cases covering human format zero-state, count rendering, REQ-2 acceptance (literal `tooling:` substring), JSON shape, ANSI-color smoke test, unified-diff +/- prefixes.

### Fixtures (3)

- `packages/cli/src/sync-tooling/__tests__/fixtures/config-no-tooling.yaml` — config with `integrations.mcp.servers: [yfinance]` and `agents.default.skills.discoveryPaths: [./skills]`, no `tooling:` key. Used by skeleton tests + Wave 4 integration test.
- `packages/cli/src/sync-tooling/__tests__/fixtures/config-with-tooling.yaml` — config with operator-customized tooling block (`data-fetching-financial` cluster, `placeholder-mcp` + `yfinance` hints, `# operator note` commentBefore, custom `replacesPackages`). Used by append-only preservation + comment-preservation + overwrite tests.
- `packages/cli/src/sync-tooling/__tests__/fixtures/skills/stub-skill/SKILL.md` — minimal SKILL.md with `comis.capability.summary` AND `comis.capability.cluster`. Exercises the Pitfall 7 priority chain.

## Drift Items Reconciled

### Pitfall 6 — McpServerEntrySchema has no `description` field

CONTEXT D-06 originally referenced an "MCP server config's optional `description` field" as a fallback source. RESEARCH §5.5 verified `McpServerEntrySchema` is `z.strictObject` with NO description field. **Reconciliation in this plan:** `discover.readMcpServers` returns `description: undefined` for all MCPs; `generate.addMcpHint` always writes the literal `description: "TODO"`. Tests verify the literal stub is present (Test 3, generate.test.ts).

### Pitfall 7 — Skill description from `summary`, not `description`

CONTEXT D-05 originally referenced a `comis.capability.description` field. RESEARCH §5.7 verified `ComisCapabilityBlockSchema` has only `summary`, not `description`. **Reconciliation in this plan:** `discover.discoverSkills` reads `comis.capability.summary` first, then `frontmatter.description`, then `undefined`. The stub fallback fires in `generate.addSkillHint` (`description ?? "TODO"`). Tests 5 + 6 + 7 (discover.test.ts) verify the priority chain.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Empty maps require `doc.createNode({})`, not bare `{}`**

- **Found during:** Task 2 (generate.ts test 9 — overwrite mode)
- **Issue:** `doc.setIn(["tooling", "mcp", "capabilityHints"], {})` stores a plain JS object as the value; subsequent `setIn(["tooling", "mcp", "capabilityHints", "slack-mcp", ...], ...)` throws `Expected YAML collection at capabilityHints` because yaml@2.8.4's setIn refuses to walk into a non-Collection value.
- **Fix:** All empty-map assignments in `generate.ts` use `doc.createNode({})` (returns a YAMLMap) instead of bare `{}`. Verified via runtime spike before the test fix.
- **Files modified:** `packages/cli/src/sync-tooling/generate.ts`
- **Commit:** `9aabc26`

**2. [Rule 3 - Blocking] applyOverwrite must guard deleteIn for missing intermediate paths**

- **Found during:** Task 2 (test 9 — fixture has no `tooling.skills` block)
- **Issue:** `doc.deleteIn(["tooling", "skills", "capabilityHints"])` throws `Expected YAML collection at skills. Remaining path: capabilityHints` when the parent doesn't exist.
- **Fix:** Wrap each deleteIn in `if (doc.hasIn(...))`. The four managed sections (`mcp.capabilityHints`, `skills.capabilityHints`, `installDetours`, `capabilityIndex`) are now individually guarded; `capabilityClusters` continues to be skipped per D-19.
- **Files modified:** `packages/cli/src/sync-tooling/generate.ts`
- **Commit:** `9aabc26` (same commit as fix 1)

**3. [Rule 1 - Bug] Incremental branch leaked an empty `tooling.skills.capabilityHints: {}` into byte-identical roundtrip**

- **Found during:** Task 2 (test 11 — REQ-7 byte-identity assertion)
- **Issue:** Original code unconditionally created `tooling.mcp.capabilityHints` and `tooling.skills.capabilityHints` parent maps before applying adds, even when the discovery set yielded zero adds. The fixture has no `tooling.skills` section, so the unchanged roundtrip produced an extra `skills:\n  capabilityHints: {}` block.
- **Fix:** Only create the parent map if `plan.mcpAdds.length > 0` (resp. `skillAdds`). Now an unchanged config roundtrips byte-identical.
- **Files modified:** `packages/cli/src/sync-tooling/generate.ts`
- **Commit:** `9aabc26`

**4. [Rule 2 - Missing critical functionality] Fixture commentBefore was attached to the map, not the yfinance Pair**

- **Found during:** Task 2 (test 7 — pruning expects `# operator note` to die with the Pair)
- **Issue:** When a comment appears at the START of a YAMLMap (before any entries), yaml@2.8.4 attaches it to the map node itself, not to the first entry's key. The original fixture had `# operator note` immediately above `yfinance:` (the only entry), so deleting yfinance left an orphan comment on `capabilityHints`.
- **Fix:** Restructure the fixture to place a `placeholder-mcp:` entry BEFORE the comment + `yfinance:` block. Now the comment is between two siblings and attaches to yfinance's Scalar key. Updated affected tests (Test 5/6/7/10/11) to include `placeholder-mcp` in the discovered set.
- **Files modified:** `packages/cli/src/sync-tooling/__tests__/fixtures/config-with-tooling.yaml`, `packages/cli/src/sync-tooling/generate.test.ts`
- **Commit:** `9aabc26`

**5. [Rule 1 - Bug] chalk colors disabled in vitest stdout**

- **Found during:** Task 3 (test 6 — chalk-color smoke test)
- **Issue:** Vitest pipes stdout, so chalk auto-detects no-TTY and sets `chalk.level = 0`. The test asserted `raw.length > stripped.length`, which failed because chalk was emitting plain text.
- **Fix:** Add `beforeAll(() => { chalk.level = 1; })` in the diff.test.ts file. Forces 16-color mode so SGR codes are emitted; the renderer code itself is unchanged (operators see real colors when TTY).
- **Files modified:** `packages/cli/src/sync-tooling/diff.test.ts`
- **Commit:** `75f7548`

## Anti-Regression Greps (all return 0)

```bash
grep -rn "from 'js-yaml'" packages/cli/src/sync-tooling/ | grep -v '^#' | wc -l   # 0 — no js-yaml (D-15)
grep -rn 'process\.env'   packages/cli/src/sync-tooling/ | grep -v '^#' | grep -v test | wc -l   # 0 — no raw process.env
grep -rn 'path\.join'     packages/cli/src/sync-tooling/ | grep -v '^#' | grep -v test | wc -l   # 0 — no raw path.join (safePath used)
grep -rn 'comis\.capability\.description' packages/cli/src/sync-tooling/ | grep -v '^#' | wc -l   # 0 — Pitfall 7 honored
```

Plus: `grep -rn '@comis/skills' packages/cli/src/sync-tooling/ | grep -v test` returns 0 (Pitfall 3 — keeps the cli/skills boundary clean and avoids pulling in the `ignore` package transitively).

## Open Items Deferred to Wave 2/3/4

- **Plan 25-02 (Wave 2):** atomic-write.ts (temp + fsync + rename + parent-dir fsync), backup.ts (D-12 fail-fast with `crypto.randomBytes(3)` 6-hex suffix per D-10), daemon-guard.ts (`system.ping` per RESEARCH Pitfall 1; 1s timeout via `Promise.race` per Pitfall 2).
- **Plan 25-03 (Wave 3):** Inline `comis config sync-tooling` sub-subcommand in `packages/cli/src/commands/config.ts` (D-01); flags `--write`, `--overwrite`, `--format <human|json>`, `--config <path>` (D-03); usage-error exit 1 for `--overwrite` without `--write`; post-write summary line per D-23/D-24.
- **Plan 25-04 (Wave 4):** Daemon-harness integration test (`test/integration/cli-sync-tooling.test.ts`) that boots a fixture-config daemon, runs the CLI, asserts `Dynamic preamble assembled` log fires with the expected cluster count.

## Verification Commands

```bash
cd packages/cli && pnpm exec vitest run src/sync-tooling/   # 28/28 pass
pnpm build                                                  # 0 errors
pnpm lint:security                                          # 0 errors
pnpm test                                                   # 20751/20751 pass (no regressions)
```

## Self-Check: PASSED

**Files exist:**
- packages/cli/src/sync-tooling/discover.ts — FOUND
- packages/cli/src/sync-tooling/discover.test.ts — FOUND
- packages/cli/src/sync-tooling/generate.ts — FOUND
- packages/cli/src/sync-tooling/generate.test.ts — FOUND
- packages/cli/src/sync-tooling/diff.ts — FOUND
- packages/cli/src/sync-tooling/diff.test.ts — FOUND
- packages/cli/src/sync-tooling/__tests__/fixtures/config-no-tooling.yaml — FOUND
- packages/cli/src/sync-tooling/__tests__/fixtures/config-with-tooling.yaml — FOUND
- packages/cli/src/sync-tooling/__tests__/fixtures/skills/stub-skill/SKILL.md — FOUND

**Commits exist (verified via git log --oneline a58c43b..HEAD):**
- c857912 — FOUND (RED Task 1)
- c807262 — FOUND (GREEN Task 1)
- 536697b — FOUND (RED Task 2)
- 9aabc26 — FOUND (GREEN Task 2)
- 59f5506 — FOUND (RED Task 3)
- 75f7548 — FOUND (GREEN Task 3)
