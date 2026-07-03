---
phase: 228-headline-slice-triage-reducer-doctor-compose-safe-writer-off
plan: 01
subsystem: cli
tags: [zod, strictObject, schema, support-bundle, result-type, parser]

# Dependency graph
requires: []
provides:
  - "HostSnapshotSchema / HostSnapshot — content-free host/install facts (no hostname, env, or repo state)"
  - "SupportBundleWarningSchema / SupportBundleWarning — recoverable section-level failure record (source/code/count/rows?/message)"
  - "SupportTriageStatusSchema / SupportTriageStatus — closed 4-value verdict enum (insufficient_evidence outranks healthy)"
  - "SupportTriageSchema / SupportTriage — deterministic triage verdict; schemaVersion literal 1; optional fleetSummary?/explainSummary?"
  - "SupportBundleManifestSchema / SupportBundleManifest — manifest index with pinned redaction fingerprint + optional warnings[]"
  - "parseSupportTriage() / parseSupportBundleManifest() — Result<T, z.ZodError> wrappers over safeParse"
affects: [228-03 triage reducer, 228-04 host-snapshot, 228-05 render-issue, 228-06 writer/orchestrator, 230 fleet enrichment, 231 explain enrichment]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "z.strictObject + z.infer + parseX()->Result<T, z.ZodError> (mirrors domain/durable-run.ts + agent-response.ts)"
    - "Shared sub-schema const to keep two artifacts from drifting on a common shape (PrivacyDeclarationSchema)"

key-files:
  created:
    - packages/cli/src/support-bundle/types.ts
    - packages/cli/src/support-bundle/types.test.ts
  modified: []

key-decisions:
  - "DoctorStatus was NOT imported: the prescribed schema shape never references it (doctorSummary uses numeric counts + string categories), and an unused import would break the tsc build. The plan gated the import on 'only if referenced'."
  - "doctorSummary.failing is z.array(z.string()) holding distinct failing check CATEGORIES (a pure reducer only ever holds category labels, not per-check ids)."
  - "The shared privacy shape was extracted to a single const (PrivacyDeclarationSchema) and reused by both triage and manifest — the plan's REFACTOR dedup step."

patterns-established:
  - "Interface-first Wave-1 contract: the schema module is authored before its consumers so later plans build against a fixed shape."
  - "strictObject unknown-key rejection is the input-validation floor a later reader of a possibly-corrupt artifact relies on."

requirements-completed: [TRIAGE-01, TRIAGE-02, BUNDLE-05]

# Metrics
duration: 10min
completed: 2026-07-03
---

# Phase 228 Plan 01: Support-bundle schema module Summary

**z.strictObject contract for the support bundle — HostSnapshot, SupportTriage, and SupportBundleManifest with `parseSupportTriage()`/`parseSupportBundleManifest()` returning `Result`, unknown-key rejection and literal/enum pins as the input-validation floor every downstream plan imports.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-03T15:19:00+03:00
- **Completed:** 2026-07-03T15:28:00+03:00
- **Tasks:** 2 (5 commits — TDD RED/GREEN plus one REFACTOR)
- **Files modified:** 2 created

## Accomplishments
- Defined the four `z.strictObject` schemas + `z.infer` types the rest of the bundle reads/writes against: `HostSnapshot`, `SupportBundleWarning`, `SupportTriage`, `SupportBundleManifest`.
- `parseSupportTriage()` and `parseSupportBundleManifest()` wrap `safeParse` and return `Result<T, z.ZodError>` — call sites chain by early-return and never touch `.parse()`.
- Pinned the trust-boundary invariants: `schemaVersion` is the literal `1`, `status` is the closed four-value enum, and `redaction`/`privacy.redaction` are the literal `"platform-aware-v1"` — so a drifted or forged artifact fails to parse.
- Declared `fleetSummary?`/`explainSummary?` as optional extension points (accepted when present, omittable now) so later enrichment needs no schema-version bump.
- 14 contract tests prove: valid-accept, unknown-key reject (top-level and nested), closed-enum reject, literal-version reject, optional-summary omit/accept, and the pinned redaction-policy reject.

## Task Commits

Each task was committed atomically (TDD RED before GREEN, then one REFACTOR):

1. **Task 1 (RED): failing triage contract test** - `6461d77e` (test)
2. **Task 1 (GREEN): triage + host-snapshot + warning schemas + parseSupportTriage()** - `1e53eac5` (feat)
3. **Task 2 (RED): failing manifest contract test** - `f33b48e0` (test)
4. **Task 2 (GREEN): manifest schema + parseSupportBundleManifest()** - `3b559c84` (feat)
5. **REFACTOR: extract shared PrivacyDeclarationSchema** - `ed8d79b8` (refactor)

## Files Created/Modified
- `packages/cli/src/support-bundle/types.ts` (177 lines) - The schema contract: 4 `z.strictObject` schemas, their `z.infer` types, `SupportTriageStatus` enum, a shared `PrivacyDeclarationSchema`, and the two `parseX()` Result-returning helpers.
- `packages/cli/src/support-bundle/types.test.ts` - 14 contract tests with local `makeValidTriage()`/`makeValidManifest()` factories exercising accept + reject (unknown-key / bad-status / bad-version / bad-policy) and optional-field paths.

## Decisions Made
- **`DoctorStatus` not imported.** The plan gated the import on "only if referenced"; the prescribed `SupportTriage` shape references no doctor type (`doctorSummary` is numeric counts + a `failing: string[]` of categories), and importing an unused type would fail the strict tsc build. No re-derivation of upstream shapes occurred.
- **`doctorSummary.failing` = distinct fail categories.** Encoded as `z.array(z.string())`; a pure reducer only ever holds `finding.category` labels, not per-check ids.
- **Shared privacy shape.** The identical `{ redaction: literal, excludes: string[] }` object in both triage and manifest was extracted to one `PrivacyDeclarationSchema` const so the fingerprint + exclusion contract cannot drift between the two artifacts.
- **strictObject over the report-contract style.** These are brand-new internal schemas with no older-consumer forward-compat need, so `z.strictObject` (unknown-key rejection) is used throughout — never the non-strict object builder.

## Deviations from Plan

None - plan executed exactly as written. The REFACTOR (shared privacy sub-schema) was explicitly anticipated by the plan's own verify note ("dedupe sub-schemas if any").

## Issues Encountered
- **Worktree had no `node_modules`.** A fresh git worktree does not inherit the main checkout's install. Ran `pnpm install` at the worktree root (fast — the pnpm store was already populated from the same lockfile, so it linked rather than downloaded/compiled).
- **Workspace packages were unbuilt (no `dist/`).** Unit tests resolve `@comis/*` via package `exports` -> `dist/`, so the first GREEN run failed to resolve `@comis/shared`. Built `@comis/shared` to unblock the test, then ran the full `pnpm build` (all packages, project references, exit 0) to satisfy the clean-build verification. `pnpm --filter @comis/cli build` is clean and the module compiled to `dist/support-bundle/types.{js,d.ts}`.

Both are environment-setup steps, not code changes — no production behavior was affected.

## Known Stubs
None. `fleetSummary?`/`explainSummary?` are declared-but-unpopulated **by design** (optional extension points for later phases, per the plan's deferred scope) — they are accepted when present and omittable now, not placeholder stubs.

## Verification
- `cd packages/cli && CI=true pnpm vitest run src/support-bundle/types.test.ts` -> **14 passed (14)**.
- `pnpm --filter @comis/cli build` -> clean (tsc, no errors); full `pnpm build` -> exit 0.
- Grep gates (all pass): `grep -c "z.strictObject"` = 10 (>= 2); `parseSupportTriage`/`parseSupportBundleManifest` present; `z.literal(1)` + `z.literal("platform-aware-v1")` present; no non-strict object builder; no §2.12 residue (`deerflow|openclaw|hermes|parity|SUPPORT-BUNDLE-DESIGN|TRIAGE-0|BUNDLE-0`) in either file.

## Next Phase Readiness
- The contract is fixed and importable: the triage-reducer plan can build against `SupportTriage`/`HostSnapshot`; the writer/orchestrator plans can validate `triage.json`/`manifest.json` on read via the two parsers.
- No blockers. `fleetSummary?`/`explainSummary?` are ready to be populated by later enrichment without a schema change.

## Self-Check: PASSED
- FOUND: packages/cli/src/support-bundle/types.ts
- FOUND: packages/cli/src/support-bundle/types.test.ts
- FOUND commits: 6461d77e, 1e53eac5, f33b48e0, 3b559c84, ed8d79b8

---
*Phase: 228-headline-slice-triage-reducer-doctor-compose-safe-writer-off*
*Completed: 2026-07-03*
