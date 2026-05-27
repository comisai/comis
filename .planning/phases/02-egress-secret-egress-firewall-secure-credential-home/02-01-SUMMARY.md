---
phase: 02-egress-secret-egress-firewall-secure-credential-home
plan: "01"
subsystem: security
tags: [secret-detection, egress-guard, output-guard, memory-write-validator, config-schema, tdd, r4]

# Dependency graph
requires:
  - phase: 01-regr-critical-regressions
    provides: "PLAINTEXT_SECRET_PREFIXES + PREFIX_MIN_BODY_LENGTHS keystone (Phase 1 R0)"
provides:
  - "secret-egress-guard.ts: scrubSecretsFromText + mightContainSecret — shared R4 egress primitive"
  - "OutputGuard bearer_token: severity critical (REDACTS, not detect-only)"
  - "OutputGuard hf_token: new entry catching bare hf_ tokens"
  - "validateMemoryWrite: secret scan branch (pre-persist block via scrubSecretsFromText)"
  - "security.writeSecretGuard config knob: warn|block|off (default warn)"
  - "PREFIX_MIN_BODY_LENGTHS exported from secret-detection.ts"
affects:
  - "02-02 through 02-05 (Wave 2 wirings — all import scrubSecretsFromText from security/index)"
  - "delivery-service.ts, result-condenser.ts, write-tool.ts (Wave 2 callers)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Intra-core text scrubber: pure function over keystone prefix list, zero observability import"
    - "Pre-filter guard (mightContainSecret) gates expensive scrub loop — O(prefixes) fast path"
    - "scrubSecretsFromText as FIRST check in validateMemoryWrite (pre-persist block)"
    - "Config knob default=warn (not block) — false-positive safety for .env.example / test fixtures"
    - "eslint-disable no-restricted-syntax comment pattern for REDACTED sentinel in intra-core security"

key-files:
  created:
    - "packages/core/src/security/secret-egress-guard.ts"
    - "packages/core/src/security/secret-egress-guard.test.ts"
  modified:
    - "packages/core/src/security/output-guard.ts"
    - "packages/core/src/security/output-guard.test.ts"
    - "packages/core/src/security/memory-write-validator.ts"
    - "packages/core/src/security/memory-write-validator.test.ts"
    - "packages/core/src/security/secret-detection.ts"
    - "packages/core/src/security/index.ts"
    - "packages/core/src/config/schema-security.ts"
    - "packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap"

key-decisions:
  - "PREFIX_MIN_BODY_LENGTHS exported from secret-detection.ts (was private const): necessary for intra-core scrubber without re-duplicating the map"
  - "hf_token regex added with /g flag in SECRET_PATTERNS (required for exec() loop termination)"
  - "bearer_token severity: warning→critical per R4 spec; existing test updated to reflect new behavior"
  - "writeSecretGuard default=warn (LOCKED per RESEARCH.md Pitfall 5 false-positive constraint)"

patterns-established:
  - "R4 egress guard: scrubSecretsFromText as the shared text scrubber for Wave 2 wiring sites"
  - "Cycle invariant: @comis/core/security modules MUST NOT import from @comis/observability"
  - "Pre-filter pattern: mightContainSecret() gates full scrub so clean text pays O(prefixes)"

requirements-completed:
  - R4

# Metrics
duration: 23min
completed: 2026-05-27
---

# Phase 2 Plan 01: Secret Egress Guard Core Summary

**R4 core: new `secret-egress-guard.ts` with `scrubSecretsFromText`+`mightContainSecret` over the R0 keystone prefix list; `OutputGuard` bearer/hf_ upgraded to REDACT (critical); `validateMemoryWrite` adds secret-scan pre-persist branch; `security.writeSecretGuard` config knob added (default warn)**

## Performance

- **Duration:** 23 min
- **Started:** 2026-05-27T16:21:00Z
- **Completed:** 2026-05-27T16:44:31Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 9

## Accomplishments
- Built cycle-safe `secret-egress-guard.ts` in `@comis/core/security` — zero `@comis/observability` imports; confirmed by `pnpm cycles`, `no-cycles.test.ts`, `architecture-graph.test.ts`, and in-test source scan
- `OutputGuard.bearer_token` severity upgraded "warning"→"critical" so `sanitized` output now has token replaced (not just logged); added `hf_token` pattern with `/g` flag catching bare HuggingFace tokens
- `validateMemoryWrite` now checks `scrubSecretsFromText` FIRST (pre-persist) before injection scan — bearer token in memory content returns `{ severity: "critical" }`
- `security.writeSecretGuard: "warn" | "block" | "off"` config knob added to `SecurityConfigSchema` with default `"warn"` (safe for .env.example, test fixtures); Wave 2 write-tool wiring will consume it
- Exported `PREFIX_MIN_BODY_LENGTHS` from `secret-detection.ts` (was private const) — needed by the intra-core scrubber without duplicating the map

## Task Commits

1. **Task 1 RED: Failing tests** - `ddd1531` (test)
2. **Task 2 GREEN: Implementation** - `e647ded` (feat)

## Files Created/Modified
- `packages/core/src/security/secret-egress-guard.ts` - NEW: shared R4 egress text scrubber
- `packages/core/src/security/secret-egress-guard.test.ts` - NEW: RED tests (12 assertions)
- `packages/core/src/security/output-guard.ts` - bearer_token severity critical; hf_token entry added (with /g flag)
- `packages/core/src/security/output-guard.test.ts` - R4 redact behavior tests; updated bearer_token test to match new critical behavior
- `packages/core/src/security/memory-write-validator.ts` - scrubSecretsFromText as FIRST check
- `packages/core/src/security/memory-write-validator.test.ts` - R4 secret scan branch tests
- `packages/core/src/security/secret-detection.ts` - export PREFIX_MIN_BODY_LENGTHS
- `packages/core/src/security/index.ts` - re-export ScrubResult, mightContainSecret, scrubSecretsFromText, PREFIX_MIN_BODY_LENGTHS
- `packages/core/src/config/schema-security.ts` - writeSecretGuard knob added
- `packages/core/src/config/__snapshots__/section-registry-parity.test.ts.snap` - updated for new config field

## Decisions Made
- Exported `PREFIX_MIN_BODY_LENGTHS` from `secret-detection.ts`: the plan's interfaces section declared it exported, but it was a private `const`. Required for `secret-egress-guard.ts` to use the same length gates without duplicating the map.
- Added `/g` flag to `hf_token` regex in `SECRET_PATTERNS`: the existing scan loop uses `exec()` in a `while` loop; without `/g`, `exec()` returns the same match infinitely (caused OOM in test worker). All other `SECRET_PATTERNS` entries use global regexes — the new entry must too.
- Updated the existing bearer_token "warning" test to match new "critical" behavior: the plan explicitly changes this severity, making the old test incorrect. The updated test documents the R4 behavior change clearly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exported PREFIX_MIN_BODY_LENGTHS from secret-detection.ts**
- **Found during:** Task 2 GREEN (implementing secret-egress-guard.ts)
- **Issue:** Plan's interface spec says `export const PREFIX_MIN_BODY_LENGTHS` but the existing file had it as a private `const`. The import in `secret-egress-guard.ts` would fail at runtime with "undefined is not a Map".
- **Fix:** Added `export` keyword to `PREFIX_MIN_BODY_LENGTHS` in `secret-detection.ts`; added to `security/index.ts` re-export barrel.
- **Files modified:** `packages/core/src/security/secret-detection.ts`, `packages/core/src/security/index.ts`
- **Commit:** `e647ded` (part of GREEN task commit)

**2. [Rule 1 - Bug] Added /g flag to hf_token regex in SECRET_PATTERNS**
- **Found during:** Task 2 GREEN (running output-guard tests)
- **Issue:** Pattern defined as `/\bhf_[A-Za-z0-9_]{18,}\b/` (non-global). The scan loop calls `exec()` in a `while` loop — without the `/g` flag, `exec()` always returns the same match (infinite loop → OOM crash in test worker).
- **Fix:** Changed to `/\bhf_[A-Za-z0-9_]{18,}\b/g`.
- **Files modified:** `packages/core/src/security/output-guard.ts`
- **Commit:** `e647ded` (part of GREEN task commit)

**3. [Rule 1 - Bug] Updated existing bearer_token "warning" test to match new "critical" behavior**
- **Found during:** Task 2 GREEN (plan explicitly changes bearer_token severity)
- **Issue:** Existing test asserted `severity: "warning"` and `blocked: false` for bearer tokens. After R4, severity is "critical" so this test correctly fails (it was testing pre-R4 behavior). The plan says "Do NOT modify existing tests" but this test was testing behavior the plan explicitly replaces.
- **Fix:** Updated the test description and assertions to reflect the new critical/redact behavior. Documented as deviation per CLAUDE.md's rule that plan-mandated changes take precedence.
- **Files modified:** `packages/core/src/security/output-guard.test.ts`
- **Commit:** `e647ded` (part of GREEN task commit)

**4. [Rule 2 - Missing] Added eslint-disable comment for REDACTED sentinel**
- **Found during:** Task 2 GREEN (test suite ran architecture source-rules test)
- **Issue:** `source-rules.test.ts` forbids bare `"[REDACTED]"` literals in production source (use maskToken instead). `secret-egress-guard.ts` defines `const REDACTED = "[REDACTED]"` for use as a scrubber sentinel (not the Pino censor literal).
- **Fix:** Added `// eslint-disable-next-line no-restricted-syntax -- R4 egress scrubber sentinel` comment, same pattern as `secret-detection.ts:365`.
- **Files modified:** `packages/core/src/security/secret-egress-guard.ts`
- **Commit:** `e647ded` (part of GREEN task commit)

**5. [Rule 1 - Bug] Fixed test-naming violations in secret-egress-guard.test.ts**
- **Found during:** Task 2 GREEN (test-naming architecture test)
- **Issue:** "scrubs hfr_ prefix token" and "scrubs sk-ant- prefix token" contained no VERB_FORMS word (neither "hfr", "hfr_", "sk", nor "ant" are in VERB_FORMS; "from" at line 528 would have saved them).
- **Fix:** Renamed to "scrubs token with hfr_ prefix from text" and "scrubs token with sk-ant- prefix from text" respectively.
- **Files modified:** `packages/core/src/security/secret-egress-guard.test.ts`
- **Commit:** `e647ded` (part of GREEN task commit)

---

**Total deviations:** 5 auto-fixed (1 Rule 3 blocking, 2 Rule 1 bugs, 1 Rule 2 missing, 1 Rule 1 test naming)
**Impact on plan:** All auto-fixes necessary for correctness/security/tests. No scope creep. The most significant is the PREFIX_MIN_BODY_LENGTHS export — the plan's interface spec anticipated it as exported but the existing code didn't match.

## Issues Encountered
- `PREFIX_MIN_BODY_LENGTHS` was a private const in secret-detection.ts despite the plan's interface spec showing it exported — resolved by exporting it (Rule 3)
- Non-global regex in hf_token pattern caused infinite loop / OOM in test worker — caught by running tests and fixed immediately (Rule 1)

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns introduced. All changes are intra-`@comis/core/security` — pure functions returning typed results, no external I/O.

## Known Stubs

None — `security.writeSecretGuard` is wired to the schema (default `"warn"`) but not yet consumed by the write/edit tools. That is intentional: consumption is Wave 2's job (plans 02-02+). The config knob itself is complete and correctly defaulted.

## Self-Check: PASSED

- `packages/core/src/security/secret-egress-guard.ts` FOUND
- `packages/core/src/security/secret-egress-guard.test.ts` FOUND
- RED commit `ddd1531` FOUND
- GREEN commit `e647ded` FOUND
- `pnpm validate` passed (build + test + lint:security + cycles)
- Zero observability imports in secret-egress-guard.ts confirmed
- `no-cycles.test.ts` + `architecture-graph.test.ts` passed

## Next Phase Readiness
- Wave 2 wiring sites (delivery-service.ts, result-condenser.ts, write-tool.ts, edit-tool.ts, memory-store-tool.ts) can now import `scrubSecretsFromText` from `@comis/core`
- `security.writeSecretGuard` config knob available for write-tool to read
- All R4 Wave 1 deliverables complete; no blockers for 02-02 onward

---
*Phase: 02-egress-secret-egress-firewall-secure-credential-home*
*Completed: 2026-05-27*
