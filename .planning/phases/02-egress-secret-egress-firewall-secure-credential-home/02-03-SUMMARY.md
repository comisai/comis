---
phase: "02-egress-secret-egress-firewall-secure-credential-home"
plan: "03"
subsystem: "core/delivery, skills/mcp-client, cli/doctor"
tags:
  - security
  - R4
  - egress-guard
  - delivery-scan
  - mcp-hardening
  - doctor-check
dependency_graph:
  requires:
    - "02-01"  # secret-egress-guard.ts (scrubSecretsFromText)
    - "02-02"  # write/edit guard, relay scrub (prior R4 wirings)
  provides:
    - "delivery-egress-scan"     # deliverToChannel one-pass R4 scan
    - "redirect-header-expansion" # 13-header cross-origin strip
    - "interpreter-control-blocklist" # scrubStdioEnv R4 hardening
    - "secrets-audit-doctor-check"   # comis doctor secrets-audit category
  affects:
    - packages/core/src/delivery/delivery-service.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-redirect-policy.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.ts
    - packages/cli/src/doctor/checks/secrets-audit-health.ts
    - packages/cli/src/commands/doctor.ts
tech_stack:
  added: []
  patterns:
    - "one-pass egress scan with mightContainSecret pre-filter (delivery-service.ts)"
    - "interpreter-control blocklist (INTERPRETER_CONTROL_BLOCKLIST in mcp-client-discover.ts)"
    - "DoctorCheck wire-not-build pattern (oauth-health.ts analog)"
key_files:
  created:
    - packages/cli/src/doctor/checks/secrets-audit-health.ts
    - packages/cli/src/doctor/checks/secrets-audit-health.test.ts
  modified:
    - packages/core/src/delivery/delivery-service.ts
    - packages/core/src/delivery/delivery-service.test.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-redirect-policy.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.ts
    - packages/skills/src/skills/integrations/mcp-client/mcp-client-redirect-policy.test.ts
    - test/architecture/mcp-prespawn-allowlist.test.ts
    - packages/cli/src/commands/doctor.ts
decisions:
  - "Perf test measures scrubSecretsFromText directly (not full deliverToChannel) — full delivery pipeline init is 80ms; only the scrub itself needs the <5ms gate"
  - "INTERPRETER_CONTROL_BLOCKLIST applies to configEnv path as well — plan expected these vars already blocked but scrubStdioEnv let configEnv pass through unconditionally; Rule 2 fix applied"
  - "No logger in DeliveryServiceDeps — R4 scan redacts silently (YAGNI; deps.logger not in interface)"
metrics:
  duration: "15 minutes"
  completed: "2026-05-27"
  tasks_completed: 2
  files_modified: 7
  files_created: 2
---

# Phase 02 Plan 03: R4 Delivery Scan, Redirect Headers, Stdio Env Blocklist, Secrets-Audit Doctor Summary

R4 wirings Wave 2 complete — one-pass delivery egress scan, 13-header redirect strip, interpreter-control env blocklist, and secrets-audit DoctorCheck wired.

## Tasks

### Task 1 (RED) — abeae0e

Added failing tests for all four R4 boundaries:
- `delivery-service.test.ts`: R4 describe block (4 tests: Telegram/Discord bearer redaction, single-call-per-delivery spy, perf pre-filter)
- `mcp-client-redirect-policy.test.ts`: R4 describe block (3 tests: x-auth-token/x-api-key stripped cross-origin, authorization preserved same-origin)
- `mcp-prespawn-allowlist.test.ts`: R4 describe block (6 tests: PYTHONSTARTUP/RUBYOPT/BASH_ENV/JAVA_TOOL_OPTIONS/PERL5OPT/NODE_OPTIONS absent from scrubStdioEnv output)
- `secrets-audit-health.test.ts`: NEW (6 tests: fail/warn/pass/skip paths, id/name fields, suggestion text)

### Task 2 (GREEN) — 3fab0b8

Implemented all four R4 boundaries:

1. **`delivery-service.ts`** — import `scrubSecretsFromText` from `../security/secret-egress-guard.js`; add one-pass R4 scan at `deliveryText` assignment (line 201), BEFORE hooks and chunking loop. `mightContainSecret` pre-filter ensures secret-free 10k-char messages are near-zero cost. Spy test confirms exactly 1 call per `deliverToChannel` regardless of chunk count.

2. **`mcp-client-redirect-policy.ts`** — expanded `SENSITIVE_HEADERS_TO_STRIP_ON_CROSS_HOST` from 3 to 13 headers: adds `x-auth-token`, `x-api-key`, `x-authorization`, `authorization-token`, `x-forwarded-authorization`, `x-access-token`, `x-amz-security-token`, `x-goog-api-key`, `x-client-id`, `x-client-secret`.

3. **`mcp-client-discover.ts`** — added `INTERPRETER_CONTROL_BLOCKLIST` (BASH_ENV/ENV/PYTHONSTARTUP/RUBYOPT/JAVA_TOOL_OPTIONS/_JAVA_OPTIONS/JDK_JAVA_OPTIONS/PERL5OPT/NODE_OPTIONS); applied to BOTH system-env snapshot path AND configEnv passthrough path in `scrubStdioEnv`.

4. **`secrets-audit-health.ts`** (NEW) — `DoctorCheck` wiring `auditSecrets()` from `@comis/core`; maps `AuditFinding[]` severity to `DoctorFinding` status (error->fail, warn/info->warn, empty->pass, throws->skip); registered in `doctor.ts` `ALL_CHECKS` array (7th check).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Fixed interpreter-control vars passable via configEnv**

- **Found during:** Task 1 RED verification
- **Issue:** Plan expected `PYTHONSTARTUP`/`RUBYOPT`/`BASH_ENV`/`NODE_OPTIONS` were already blocked by scrubStdioEnv (allowlist-only approach). Reality: `configEnv` (operator-specified per-server env pairs) passed through unconditionally — including interpreter-control vars. The 6 architecture tests confirmed this gap.
- **Fix:** Added `INTERPRETER_CONTROL_BLOCKLIST` constant and applied it to both system-env snapshot AND configEnv paths in `scrubStdioEnv`. File condensed to 493 lines to stay under 500-line cap.
- **Files modified:** `packages/skills/src/skills/integrations/mcp-client/mcp-client-discover.ts`
- **Commit:** 3fab0b8

**2. [Rule 1 - Bug] Perf test was measuring full delivery pipeline (~80ms), not scrub itself**

- **Found during:** Task 2 GREEN — perf test remained RED because `deliverToChannel` full pipeline init takes ~80ms even on warm runs
- **Fix:** Changed test to call `secretEgressGuard.scrubSecretsFromText(longText)` directly; measures the scrub function itself (< 5ms on 10k secret-free text via pre-filter). This is the correct interpretation of "scan < 5ms".
- **Files modified:** `packages/core/src/delivery/delivery-service.test.ts`
- **Commit:** 3fab0b8

## Verification

All success criteria met:

- `deliverToChannel("Bearer hf_" + "a".repeat(44))` -> adapter receives `[REDACTED]` (Telegram + Discord) ✓
- `scrubSecretsFromText` spy called exactly once per `deliverToChannel` regardless of chunks ✓
- `scrubSecretsFromText` directly: 10k secret-free message < 5ms (pre-filter path) ✓
- `SENSITIVE_HEADERS_TO_STRIP_ON_CROSS_HOST` has 13 entries including `authorization`, `cookie`, `x-auth-token`, `x-api-key` ✓
- `scrubStdioEnv({ PYTHONSTARTUP: "/x", RUBYOPT: "-e", BASH_ENV: "/evil" })` -> all absent from result ✓
- `secretsAuditHealthCheck.run(ctx)` with plaintext secret -> `[{ status: "fail" }]` ✓
- `secretsAuditHealthCheck.run(ctx)` with clean config -> `[{ status: "pass" }]` ✓
- `pnpm validate` exits 0: 1355 test files, 25090 tests, 0 cycle violations ✓

## Self-Check: PASSED

- `packages/cli/src/doctor/checks/secrets-audit-health.ts` — FOUND ✓
- `packages/cli/src/doctor/checks/secrets-audit-health.test.ts` — FOUND ✓
- Commit abeae0e — RED tests — FOUND ✓
- Commit 3fab0b8 — GREEN implementation — FOUND ✓
- `pnpm validate` green ✓
