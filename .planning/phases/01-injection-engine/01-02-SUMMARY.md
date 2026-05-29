---
phase: 01-injection-engine
plan: "02"
subsystem: security/provider-catalog
tags: [tdd, matcher, host-matching, path-matching, security, credential-broker]
dependency_graph:
  requires: [01-01]
  provides: [normalizeHost, hostRuleMatches, pathAllowed, resolveBinding]
  affects: [injection-engine.ts (plan 03), CredentialBroker (phase 2)]
tech_stack:
  added: []
  patterns: [pure-function module, section-divider comments, two-pass priority resolution]
key_files:
  created:
    - packages/core/src/security/provider-catalog/matcher.ts
    - packages/core/src/security/provider-catalog/matcher.test.ts
  modified: []
decisions:
  - "Segment wildcard /repos/*/issues implemented via before/after split on wildcard position — not regex — matching apps.rs port provenance"
  - "Two-pass resolveBinding scans path-scoped rules first (immediate return), then falls back to first host-only candidate — no second full scan needed"
  - "normalizeHost detects IPv6 via leading [ bracket check before any colon scan — fixes OneCLI gateway.rs:866 port-split corruption bug"
  - "JSDoc backtick quoting removed from glob pattern examples — oxc parser misinterprets backtick+quote as template literal in JSDoc"
metrics:
  duration: "~20 minutes"
  completed: "2026-05-29"
  tasks: 2
  files: 2
---

# Phase 1 Plan 02: Matcher — normalizeHost, hostRuleMatches, pathAllowed, resolveBinding

**One-liner:** Pure host/path matcher with IPv6-safe normalization, length-guard suffix matching, four-form glob pathAllowed, and two-pass fail-closed resolveBinding — TDD RED-first, 91.66% branch coverage.

## TDD Gate Compliance

RED commit (ab62676): `test(01-02): add RED matcher edge-case suite` — matcher.test.ts written before matcher.ts; all tests failed with "Cannot find module ./matcher.js".

GREEN commit (ca1c131): `feat(01-02): implement matcher.ts GREEN — all 34 tests pass` — full implementation; 34/34 tests pass.

## Test Cases Written

### normalizeHost (6 tests)

| Test | Behavior |
|------|----------|
| strips the port from a plain hostname:port authority | `api.anthropic.com:443` → `api.anthropic.com` |
| lowercases mixed-case hostname without port | `API.Anthropic.COM` → `api.anthropic.com` |
| strips FQDN trailing dot from a hostname ending with period | `api.anthropic.com.` → `api.anthropic.com` |
| extracts bare IPv6 address from bracketed IPv6 with port without port-split corruption | `[2606:4700::1]:443` → `2606:4700::1` (T-02-04) |
| strips brackets from bare bracketed IPv6 with no port | `[::1]` → `::1` |
| returns empty string for empty authority input | `""` → `""` |
| lowercases a malformed bracketed IPv6 with no closing bracket | graceful fallback (no crash) |

### hostRuleMatches (7 tests)

| Test | Behavior |
|------|----------|
| matches when hostname equals the exact host value in the rule | `exact("api.anthropic.com")` matches `api.anthropic.com` |
| rejects a hostname that is a subdomain of the exact host value | `exact("api.anthropic.com")` rejects `evil.api.anthropic.com` |
| rejects a hostname that differs from exact host by a leading subdomain | `exact("github.com")` rejects `api.github.com` |
| matches a hostname that is strictly longer than the suffix | suffix match for `us-central1-aiplatform.googleapis.com` |
| rejects the bare suffix itself (length guard, T-02-01) | `-aiplatform.googleapis.com` against its own suffix rule |
| rejects mid-string containment (T-02-02) | `notamazonaws.com.evil.com` does not end with `.amazonaws.com` |
| rejects non-suffix terminal substring | `amazonaws.com.evil.io` |

### pathAllowed (14 tests)

| Test | Behavior |
|------|----------|
| allows any path when rule has no pathPolicy | undefined → open policy |
| allows any path when pathPolicy contains bare wildcard | `*` → allow all |
| allows path with at least one trailing segment under boundary glob | `/v1/*` matches `/v1/messages` |
| rejects path in different namespace under boundary glob | `/v1/*` rejects `/v1beta` |
| rejects prefix-only path under boundary glob | `/v1/*` rejects `/v1` |
| allows path starting with literal prefix glob | `/v1/messages*` matches `/v1/messages/123` |
| allows single-segment wildcard match | `/repos/*/issues` matches `/repos/foo/issues` |
| rejects multi-segment path against single-segment wildcard | `/repos/*/issues` rejects `/repos/foo/bar/issues` |
| allows path with query string under boundary glob (T-02-05) | `/v1/x?token=LEAK` matched against `/v1/*` after strip |
| allows exact path match in policy | `/v1/status` matched by exact pattern |
| rejects path not exactly matching non-wildcard pattern | `/v1/status/extra` against `/v1/status` |
| rejects path missing trailing suffix required by mid-pattern wildcard | `/repos/myrepo` against `/repos/*/issues` |
| rejects all paths when pathPolicy is empty array | fail-closed (deny-by-omission) |

### resolveBinding (7 tests)

| Test | Behavior |
|------|----------|
| returns undefined when bindings list is empty (T-02-03) | fail-closed for unknown host |
| returns undefined when host matches no binding in non-empty list | fail-closed |
| selects path-scoped rule over host-only rule on same hostname | two-pass priority |
| returns undefined when only path-scoped bindings exist but path misses | no fallback to undefined host-only |
| matches any path when rule has no pathPrefix | host-only rule open policy |
| resolves first matching binding when multiple bindings overlap | first-match determinism |
| resolves hand-written binding with no preset (INJECT-01) | provider-agnostic arbitrary host |

## Verification Results

RED gate:
```
FAIL src/security/provider-catalog/matcher.test.ts
Error: Cannot find module './matcher.js'
```
All 0 tests (file-level fail), confirming RED.

GREEN gate:
```
Test Files  1 passed (1)
Tests       34 passed (34)
```

Full core suite:
```
Test Files  177 passed (177)
Tests       4153 passed (4153)
```

Wave gate (branch coverage):
```
matcher.ts | 95.08 | 91.66 | 100 | 100 |
```
Branch coverage: **91.66%** (above the 90% target). Functions: **100%**. Lines: **100%**.

Build:
```
pnpm build — all packages pass
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] JSDoc oxc parse failure on backtick+quote in glob pattern examples**
- **Found during:** Task 1 (GREEN phase first test run)
- **Issue:** oxc parser treating `\`"/repos/*/issues"\`` in JSDoc as unterminated template literal, failing to transform the file
- **Fix:** Removed quotes and backtick wrappers from glob pattern examples in JSDoc comments; used plain text descriptions instead
- **Files modified:** `packages/core/src/security/provider-catalog/matcher.ts`
- **Commit:** ca1c131 (included in GREEN commit)

**2. [Rule 2 - Coverage] Added branch-coverage tests for three uncovered paths**
- **Found during:** Task 2 (post-GREEN coverage run showing 85.41% branches)
- **Issue:** Three code branches uncovered — malformed IPv6 fallback (line 49), segment wildcard with no trailing slash (line 157), exact path match (line 169)
- **Fix:** Added 4 targeted tests to cover these branches, raising branch coverage from 85.41% to 91.66%
- **Files modified:** `packages/core/src/security/provider-catalog/matcher.test.ts`
- **Commit:** ca1c131 (included in GREEN commit alongside matcher.ts)

## Edge Cases Discovered Beyond Design Doc Matrix

1. **Malformed bracketed IPv6 (no closing bracket):** The design doc mentions `[2606:4700::1]:443` and `[::1]` but not malformed inputs like `[2001:db8::1`. Added a test and defensive branch that lowercases the full string rather than crashing.

2. **Path matching with no segment after wildcard slot:** Pattern `/repos/*/issues` against `/repos/myrepo` — the path has no slash after the wildcard slot, so `segmentEnd === -1`. The code correctly returns false (after is `/issues`, not empty). Added an explicit test case.

3. **Exact path matching in pathAllowed:** The design doc's matrix focuses on glob forms; the exact-match fallthrough in `matchPathPattern` needed explicit test coverage. Added two tests.

## Known Stubs

None. All exported functions are fully implemented.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries introduced. All functions are pure, in-memory, no I/O.

## Self-Check: PASSED
