---
phase: "01"
plan: "03"
subsystem: security/provider-catalog
tags:
  - injection-engine
  - tdd
  - security
  - INJECT-01
  - INJECT-02
dependency_graph:
  requires:
    - 01-01 (types.ts — InjectionRule discriminated union)
    - 01-02 (matcher.ts — context; no direct import)
  provides:
    - applyInjections (exported)
    - InjectionInput (exported interface)
    - applySetParam (private helper)
  affects:
    - packages/core/src/security/provider-catalog/index.ts (will re-export applyInjections)
    - packages/core/src/security/index.ts (will re-export via provider-catalog barrel)
tech_stack:
  added: []
  patterns:
    - WHATWG Headers (Node 22 built-in) for case-normalised header mutation
    - WHATWG URL (Node 22 built-in) for raw string query append
    - TDD RED/GREEN (no REFACTOR needed — implementation was clean on first pass)
key_files:
  created:
    - packages/core/src/security/provider-catalog/injection-engine.ts
    - packages/core/src/security/provider-catalog/injection-engine.test.ts
  modified: []
decisions:
  - "applySetParam uses raw string concatenation (NOT url.searchParams.set) to preserve verbatim query bytes per T-03-02"
  - "replaceHeader is a strict no-op when target header is absent — the INJECT-02 security invariant that prevents credential injection into unintended requests"
  - "CRLF rejection (T-03-03) is delegated to WHATWG Headers, not guarded in application code"
  - "Engine is pure (zero logger imports) — secret value is never passed to any log call"
metrics:
  duration: "~10 minutes"
  completed: "2026-05-29"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
  tests_added: 27
  tests_passing: 27
---

# Phase 1 Plan 03: Injection Engine Summary

**One-liner:** Pure injection engine — applyInjections applies header/param rules with replaceHeader no-op security invariant and verbatim-preserving raw-append setParam.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 469777d | RED | `test(01-03): add RED injection-engine edge-case suite` |
| 3dca149 | GREEN | `feat(01-03): implement injection-engine (applyInjections + applySetParam)` |

## TDD Gate Compliance

- RED commit `469777d` — `test(01-03):` prefix, module not found confirmed before implementation.
- GREEN commit `3dca149` — `feat(01-03):` prefix, 27/27 tests pass.

## Test Cases Written (27 total)

### applyInjections — default-Bearer (INJECT-01)
1. injects Authorization: Bearer <secret> when no rules are provided
2. does not set other headers when using empty rules default

### applyInjections — setHeader raw format
3. sets the named header to the raw secret value
4. does not change any header other than the named one

### applyInjections — setHeader bearer format
5. sets the named header to Bearer <secret>

### applyInjections — setHeader with removeAuthorization (T-03-01)
6. sets the named header and removes the authorization header when removeAuthorization is true
7. does not remove authorization when removeAuthorization is false
8. does not remove authorization when removeAuthorization is absent

### applyInjections — setHeader raw GitHub Basic pattern
9. sets raw value verbatim without Base64-wrapping (caller constructs the value)

### applyInjections — replaceHeader when header is present
10. replaces the header value when the header already exists

### applyInjections — replaceHeader absent = no-op (INJECT-02 critical security invariant)
11. does not set the header when it is absent — no credential injection into unintended requests
12. does not touch other headers when replaceHeader target is absent

### applyInjections — removeHeader
13. removes the named header when it is present
14. is a no-op when the named header is not present

### applyInjections — removeHeader case-insensitive (T-03-04)
15. removes Authorization header set with capital A when rule uses lowercase 'authorization'

### applyInjections — setParam delegates to applySetParam
16. appends the query param to a URL with no existing query
17. preserves the URL fragment after setParam injection

### applyInjections — multiple rules, cumulative
18. applies setHeader and removeHeader in sequence so both take effect
19. last-wins: two setHeader rules on same name — second value prevails

### applyInjections — CRLF tamper guard (T-03-03)
20. CRLF injection via setHeader either throws or leaves the injected name absent

### applySetParam — no existing query
21. creates the query string from scratch when URL has no query

### applySetParam — existing query preserved verbatim
22. appends the new param to an existing query without disturbing it
23. existing query bytes preserved verbatim — percent-encoded slash is NOT double-encoded (T-03-02)
24. SIGNED_URL: full AWS pre-signed URL retains both existing params verbatim

### applySetParam — special characters in secret value are percent-encoded
25. URL-encodes ampersand and equals in the injected secret value

### applySetParam — fragment preservation
26. preserves the URL fragment when URL has no existing query
27. preserves the URL fragment when URL has an existing query

## Verification Results

### RED Gate
```
cd packages/core && CI=true pnpm test -- --reporter=verbose 2>&1 | grep -E "FAIL|injection-engine"
```
Result: `FAIL src/security/provider-catalog/injection-engine.test.ts — Error: Cannot find module './injection-engine.js'`

### GREEN Gate
```
cd packages/core && CI=true pnpm vitest run src/security/provider-catalog/injection-engine.test.ts
```
Result: `1 passed (1) — Tests 27 passed (27)`

### Verbatim-preservation spot check
```
pnpm vitest run src/security/provider-catalog/injection-engine.test.ts --reporter=verbose 2>&1 | grep "verbatim"
```
Result: 4 verbatim tests passing:
- "sets raw value verbatim without Base64-wrapping (caller constructs the value)"
- "appends the new param to an existing query without disturbing it"
- "existing query bytes preserved verbatim — percent-encoded slash is NOT double-encoded (T-03-02)"
- "SIGNED_URL: full AWS pre-signed URL retains both existing params verbatim"

### No-logger check
```
grep -c "import.*logger\|console\." packages/core/src/security/provider-catalog/injection-engine.ts
```
Result: **0** — zero logger or console references in executable code (2 occurrences are in JSDoc comments documenting the prohibition)

### No searchParams.set in executable code
```
grep -n "searchParams\.set" packages/core/src/security/provider-catalog/injection-engine.ts
```
Result: Both occurrences are on comment/JSDoc lines 17 and 46 — zero in executable code.

### Full packages/core test suite
```
cd packages/core && CI=true pnpm test
```
Result: **178 test files, 4184 tests — all passed**

### Repo build
```
pnpm build
```
Result: **All packages built successfully**

## Deviations from Plan

None — plan executed exactly as written. The edge-case matrix from design doc §7-P0 was fully covered. The implementation matched the algorithm specified in the plan's `<implementation>` block without modification.

## Known Stubs

None. The injection engine is fully wired. `applyInjections` and `InjectionInput` are ready to be exported from `provider-catalog/index.ts` (planned in a subsequent task, not this plan's scope).

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The engine is a pure in-memory mutation function with no I/O. Threat mitigations T-03-01 through T-03-04 from the plan's `<threat_model>` are all verified by RED tests.

## Self-Check: PASSED
