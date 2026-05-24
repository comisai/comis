
## Plan 01-04: Pre-existing pnpm validate failure

**File:** packages/web/src/views/setup-wizard.ts (happy-dom test environment)
**Error:** `TypeError: URL is not a constructor` in setup-wizard.ts:387
**Status:** Pre-existing — fails identically on the commit BEFORE Plan 01-04 changes (verified by git stash test)
**Out-of-scope:** Not caused by Plan 01-04 changes (orchestrator/channels only)
**Action required:** Investigate happy-dom URL constructor compatibility in packages/web test env
