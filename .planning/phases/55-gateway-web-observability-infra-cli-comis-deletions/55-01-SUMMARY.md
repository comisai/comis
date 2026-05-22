---
phase: 55-gateway-web-observability-infra-cli-comis-deletions
plan: 01
subsystem: api
tags: [gateway, json-rpc, webhook, mtls, rate-limit, hono, deletion]

# Dependency graph
requires:
  - phase: 52
    provides: gateway baseline (createDynamicMethodRouter, createMappedWebhookEndpoint already canonical)
provides:
  - "Single RPC router factory (createDynamicMethodRouter) — static createMethodRouter/createStubMethods deleted"
  - "Single webhook factory (createMappedWebhookEndpoint) — strict-schema createWebhookEndpoint deleted"
  - "Slimmer GatewayServerDeps (webhookDeps/oauthCallbackDeps/hookRunner removed)"
  - "extractClientCN + validateCertificates + CertPaths barrel-exported from @comis/gateway"
  - "Rate-limiter keys exclusively by IP (dead c.get('clientId') derivation removed)"
  - "config.set RPC accepts only canonical {section, key, value} (path alias removed)"
affects: [55-02, 55-03, 55-04, 55-05, 55-06, 55-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Inline-stub literal seeding for JSON-RPC router tests (replaces createStubMethods anti-pattern; per RESEARCH Pitfall 3)"
    - "Rate-limiter tests drive key variation through mockGetConnInfo IP injection (replaces synthetic-auth middleware)"

key-files:
  created: []
  modified:
    - "packages/gateway/src/rpc/method-router.ts (deleted createMethodRouter + createStubMethods; preserved type metadata)"
    - "packages/gateway/src/rpc/method-router.test.ts (rewrote test seeding via makeInlineStubs helper)"
    - "packages/gateway/src/rpc/ws-handler.test.ts (retargeted createMethodRouter → createDynamicMethodRouter inline-stub)"
    - "packages/gateway/src/rpc/rpc-adapters.ts (tightened config.set Zod contract to {section, key, value} only)"
    - "packages/gateway/src/webhook/webhook-endpoint.ts (deleted createWebhookEndpoint + WebhookPayloadSchema + WebhookPayload/WebhookHandler)"
    - "packages/gateway/src/webhook/webhook-endpoint.test.ts (deleted createWebhookEndpoint describe block, preserved createMappedWebhookEndpoint)"
    - "packages/gateway/src/server/hono-server.ts (deleted 3 dead GatewayServerDeps branches + /hooks mount + /oauth mount + hookRunner lifecycle)"
    - "packages/gateway/src/index.ts (added validateCertificates + extractClientCN + CertPaths barrel)"
    - "packages/gateway/src/rate-limit/rate-limiter.ts (deleted c.get('clientId') fallback in keyGenerator)"
    - "packages/gateway/src/rate-limit/rate-limiter.test.ts (deleted synthetic-auth middleware in createTestApp + retargeted 6 tests to mockGetConnInfo)"
    - "packages/web/src/views/scheduler-controller.ts (renamed setConfig 'path' parameter to 'key' + canonical payload shape)"
    - "packages/web/src/views/scheduler-controller.test.ts (asserts canonical {section, key, value} shape)"
    - "test/integration/gateway/mtls-handshake.test.ts (deleted inline extractClientCN copy + imports from @comis/gateway)"
    - "test/support/public-api-policy.ts (tracked 3 new gateway exports + 2 newly-orphaned core HookGateway*Context types)"

key-decisions:
  - "Combined Task 2 Commits B + C into a single atomic commit because hono-server.ts imports + consumes the deleted webhook factory; splitting would leave the build red between commits (Rule 3 sequencing fix)"
  - "Added validateCertificates + extractClientCN + CertPaths to test/support/public-api-policy.ts because the public-export-consumers architecture gate scans only packages/ (not test/integration/); the integration test consumer doesn't satisfy the gate even though it's a real consumer"
  - "Added HookGatewayStartContext + HookGatewayStopContext to @comis/core baseline-orphan policy because deleting deps.hookRunner?.runGateway{Start,Stop}() removed the only in-repo consumers"

patterns-established:
  - "makeInlineStubs(methods: readonly RpcMethodName[]): RpcMethodMap — typed inline-stub factory for JSON-RPC router tests, seeds only methods the test exercises (anti-pattern guard against re-introducing createStubMethods shape)"
  - "Rate-limiter test pattern: mockGetConnInfo.mockReturnValue({ remote: { address: 'X.X.X.X' } }) — drive IP-keyed test variation via the TCP-socket mock, not via synthetic auth middleware"

requirements-completed:
  - DEAD-MOD-16
  - DEAD-MOD-17
  - DUP-CONS-12
  - BC-REM-11

# Metrics
duration: 34min
completed: 2026-05-22
---

# Phase 55 Plan 01: Gateway dead-code + duplication + BC-shim deletions Summary

**Single-router/single-webhook gateway: deleted createMethodRouter + createStubMethods + createWebhookEndpoint + 3 dead `GatewayServerDeps` branches; barrel-exported `extractClientCN`; tightened `config.set` to `{section, key, value}` canonical shape.**

## Performance

- **Duration:** 34 min
- **Started:** 2026-05-22T05:38:14Z
- **Completed:** 2026-05-22T06:11:58Z
- **Tasks:** 3 (executed as 6 atomic commits + 1 deviation commit)
- **Files modified:** 13 (12 source/test + 1 architecture policy)

## Accomplishments

- **DEAD-MOD-16 closed:** Static-schema RPC router factory `createMethodRouter` + its stub-seed helper `createStubMethods` deleted (production already used `createDynamicMethodRouter` exclusively via `setup-gateway-rpc.ts:537`). Preserved `RpcMethodName` / `METHOD_SCOPES` / `RpcMethodMap` / `RpcMethodHandler` type metadata that `rpc-adapters.ts` and the dynamic router still consume.
- **DEAD-MOD-17 closed:** Strict-schema `createWebhookEndpoint` factory + `WebhookPayloadSchema` + 3 dead `GatewayServerDeps` branches (`webhookDeps`, `oauthCallbackDeps`, `hookRunner`) + the `/hooks` mount + the `/oauth/callback` mount + the `hookRunner?.runGatewayStart()` / `runGatewayStop()` lifecycle calls all deleted. Daemon was never constructing any of them; webhooks are mounted post-construction via `setup-gateway-routes.ts:122` calling `createMappedWebhookEndpoint`.
- **DUP-CONS-12 closed:** `extractClientCN` + `validateCertificates` + `CertPaths` barrel-exported from `@comis/gateway`. Integration test `test/integration/gateway/mtls-handshake.test.ts` no longer inlines a 7-line copy of `extractClientCN` — imports the canonical implementation.
- **BC-REM-11 closed:** Rate-limiter's dead `c.get("clientId") ?? ...` fallback removed (never set in production code, only by a synthetic auth middleware in the test). `config.set` RPC contract narrowed to accept only `{section, key, value}` (the `{section, path, value}` alias was a backward-compatibility shim; web caller updated atomically).

## Task Commits

1. **Task 1: Delete createMethodRouter + createStubMethods + retarget tests** — `53ea05b1` (refactor)
2. **Task 2a: Barrel-export extractClientCN; remove integration-test inline copy** — `8b384282` (refactor)
3. **Task 2b+c (combined): Delete createWebhookEndpoint + 3 dead GatewayServerDeps branches** — `1b7fcd13` (refactor)
4. **Task 3a: Delete dead clientId derivation in rate-limiter + rewrite tests** — `527bd10d` (refactor)
5. **Task 3b: Delete config.set {path} alias + retarget web scheduler-controller** — `4d2df8a8` (refactor)
6. **Deviation (Rule 3): Track new gateway exports + orphaned Hook*Context in public-api-policy** — `4aa1fd43` (chore)

## Files Created/Modified

### Modified — Gateway source

- `packages/gateway/src/rpc/method-router.ts` — Deleted `createMethodRouter` (lines 61-84) and `createStubMethods` (lines 271-304). Refreshed stale JSDoc reference. **Net: -64 LOC.**
- `packages/gateway/src/rpc/rpc-adapters.ts` — Tightened `config.set` to accept only `{section, key, value}` (deleted the `path` alias mapper). Refreshed JSDoc reference. **Net: -3 LOC.**
- `packages/gateway/src/webhook/webhook-endpoint.ts` — Deleted `createWebhookEndpoint`, `WebhookPayloadSchema`, `WebhookPayload`, `WebhookHandler`, `WebhookEndpointDeps`, and the `z` (zod) import. Preserved `createMappedWebhookEndpoint`. **Net: -119 LOC.**
- `packages/gateway/src/server/hono-server.ts` — Deleted `webhookDeps?`, `oauthCallbackDeps?`, `hookRunner?` optional fields from `GatewayServerDeps`; deleted `/hooks` + `/oauth` mounts; deleted `hookRunner?.runGatewayStart()` + `hookRunner?.runGatewayStop()` calls; deleted associated imports (`createWebhookEndpoint`, `WebhookHandler`, `HookRunner`, `HookGatewayStartContext`, `HookGatewayStopContext`, `HmacAlgorithm`, `OAuthCredentialStorePort`, `createOAuthCallbackRoute`, `PendingFlow`). Refreshed JSDoc routes list. **Net: -47 LOC.**
- `packages/gateway/src/index.ts` — Added new `// Auth -- mTLS` barrel block exporting `validateCertificates`, `extractClientCN`, and `type CertPaths`. **Net: +3 LOC.**
- `packages/gateway/src/rate-limit/rate-limiter.ts` — Deleted `const clientId = c.get("clientId") ...` and the `clientId ?? ` fallback; `keyGenerator` now returns `getClientIp(c, trustedProxies)` directly. Refreshed JSDoc. **Net: -6 LOC.**

### Modified — Gateway tests

- `packages/gateway/src/rpc/method-router.test.ts` — Deleted `describe("createMethodRouter", ...)` block (~80 lines) and `describe("createStubMethods", ...)` block (~24 lines); added `makeInlineStubs` helper; rewrote `describe("createDynamicMethodRouter", ...)` to consume the helper. **Net: -113 LOC.**
- `packages/gateway/src/rpc/ws-handler.test.ts` — Replaced `createMethodRouter(createStubMethods())` with `createDynamicMethodRouter({...})` seeding only the 2 methods the tests exercise (`agent.execute`, `memory.search`). **Net: -7 LOC.**
- `packages/gateway/src/webhook/webhook-endpoint.test.ts` — Deleted `describe("createWebhookEndpoint", ...)` block (~200 lines, 14 tests); deleted `makeRequest` helper used only by the deleted block; deleted `WebhookPayload` type import. Preserved `signBody` (still used by mapped-endpoint HMAC test) and `describe("createMappedWebhookEndpoint", ...)` block. **Net: -226 LOC.**
- `packages/gateway/src/rate-limit/rate-limiter.test.ts` — Deleted the synthetic-auth middleware in `createTestApp` (5 lines reading `c.req.query("clientId")` and calling `c.set("clientId", ...)`); rewrote 6 test bodies to drive key variation via `mockGetConnInfo.mockReturnValue({ remote: { address: "..." } })`; renamed 3 test descriptions ("tracks different clients independently" → "tracks different IPs independently", "falls back to anonymous key when no clientId" → "falls back to 'unknown' key when no IP is resolvable"). **Net: -5 LOC + structural rewrite.**

### Modified — Web

- `packages/web/src/views/scheduler-controller.ts` — Renamed `setConfig` parameter `path` → `key` on the interface declaration and the implementation; canonical `{section, key, value}` payload to `rpcClient.call("config.set", ...)`. **Net: 0 LOC (rename only).**
- `packages/web/src/views/scheduler-controller.test.ts` — Renamed test description and updated the assertion to expect `{section, key, value}` instead of `{section, path, value}`. **Net: 0 LOC.**

### Modified — Tests + architecture

- `test/integration/gateway/mtls-handshake.test.ts` — Deleted the inline `extractClientCN` function (7 lines) and the explanatory comment; added `import { extractClientCN } from "@comis/gateway";`. **Net: -6 LOC.**
- `test/support/public-api-policy.ts` — Added `validateCertificates`, `extractClientCN`, `CertPaths` to the `@comis/gateway` policy entry (consumed by `test/integration/gateway/mtls-handshake.test.ts`, which the architecture walker excludes from scanning). Added `HookGatewayStartContext`, `HookGatewayStopContext` to the `@comis/core` baseline-orphan set (their last consumer was the deleted `hookRunner` lifecycle calls in `hono-server.ts`). **Net: +15 LOC.**

## Decisions Made

1. **Combined Task 2 Commits B + C into a single atomic commit.** The plan called for three separate commits in Task 2 (barrel, then `createWebhookEndpoint` deletion, then `GatewayServerDeps` cleanup). However, `hono-server.ts` *imports* and *consumes* the deleted webhook factory, so any commit that deletes the factory without simultaneously removing the consumer leaves the build red. The plan's verification requirement (`pnpm validate` exits 0 after every commit) cannot be met with the proposed split. Combined the two source-side commits into one (`1b7fcd13`) and kept the barrel-export as a separate commit (`8b384282`) because that one is independently green. Documented in the commit body as a Rule 3 (sequencing) deviation.

2. **Added orphaned `HookGatewayStartContext` + `HookGatewayStopContext` to the `@comis/core` baseline-orphan policy rather than deleting them from core.** Deleting them is technically the better outcome, but it's outside Plan 55-01's scope (the plan touches gateway + one web file only) and may break a future plan that intends to wire gateway lifecycle hooks. Their paired `Event` types (`HookGatewayStartEvent`, `HookGatewayStopEvent`) were already baseline-orphaned in `@comis/core`'s policy, so this preserves symmetry.

3. **Did not run `pnpm validate` as a single command** because of a pre-existing `lint:security` error in `packages/agent/src/safety/validation-error-formatter.ts:38` (verified by `git stash`-rerun against the spawn base `c700e5c0` — unchanged behaviour). Logged the pre-existing failure to `.planning/phases/55-.../deferred-items.md`. The plan's `<verification>` requirement of `pnpm validate` exits 0 cannot be met until this pre-existing issue is fixed independently; meanwhile this plan's contribution to validate is green (build green, test green, cycles green).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Sequencing] Combined Task 2 Commits B + C atomically**
- **Found during:** Task 2 (after deleting `createWebhookEndpoint` from `webhook-endpoint.ts`)
- **Issue:** Plan called for separate Commit B (delete `createWebhookEndpoint` from `webhook-endpoint.ts`) and Commit C (delete dead branches from `hono-server.ts`). But `hono-server.ts` imports `createWebhookEndpoint` and `WebhookHandler` from `webhook-endpoint.ts` and constructs them at `hono-server.ts:227`. Splitting the deletion leaves the build red between the commits.
- **Fix:** Performed both deletions in a single atomic commit (`1b7fcd13`); documented in the commit body.
- **Files modified:** `packages/gateway/src/webhook/webhook-endpoint.ts`, `packages/gateway/src/webhook/webhook-endpoint.test.ts`, `packages/gateway/src/server/hono-server.ts`
- **Verification:** `pnpm --filter @comis/gateway build` + `pnpm --filter @comis/gateway test` (474 passed) + `pnpm build` (full workspace) all green at the single commit point.
- **Committed in:** `1b7fcd13`

**2. [Rule 3 — Blocking] Added new gateway exports + orphaned core types to public-api-policy.ts**
- **Found during:** Plan-level verification (`pnpm test` after all task commits)
- **Issue:** `test/architecture/public-export-consumers.test.ts` fired with 5 violations:
  - `@comis/gateway`: 3 new exports (`validateCertificates`, `extractClientCN`, `CertPaths`) — flagged because the architecture walker scans only `packages/` (not `test/integration/`), and the only consumer is `test/integration/gateway/mtls-handshake.test.ts`.
  - `@comis/core`: 2 newly-orphaned types (`HookGatewayStartContext`, `HookGatewayStopContext`) — their last consumer was the deleted `deps.hookRunner?.runGatewayStart()` / `runGatewayStop()` lines in `hono-server.ts`.
- **Fix:** Added the 3 gateway names to `@comis/gateway`'s policy entry and the 2 core types to `@comis/core`'s baseline-orphan set, each with a rationale comment.
- **Files modified:** `test/support/public-api-policy.ts`
- **Verification:** `npx vitest run test/architecture/public-export-consumers.test.ts` → 11 passed.
- **Committed in:** `4aa1fd43` (separate commit because it's a follow-up architecture-policy update, not a refactor)

### Deferred (out of scope)

**1. Pre-existing `lint:security` error in `packages/agent/src/safety/validation-error-formatter.ts:38`**
- **Type:** Pre-existing — verified by `git stash` + rerun against the spawn base `c700e5c0` (commit before this plan started). The error pre-dates Plan 55-01.
- **Reason for deferral:** Per the SCOPE BOUNDARY rule, only auto-fix issues DIRECTLY caused by the current task's changes. The error is in `packages/agent/` which Plan 55-01 does not touch.
- **Logged to:** `.planning/phases/55-gateway-web-observability-infra-cli-comis-deletions/deferred-items.md`
- **Recommendation:** Fix in a dedicated cleanup plan or independently before the next `pnpm validate` gate.

---

**Total deviations:** 2 auto-fixed (both Rule 3 — sequencing / blocking) + 1 deferred (out of scope)
**Impact on plan:** All 4 requirements (DEAD-MOD-16, DEAD-MOD-17, DUP-CONS-12, BC-REM-11) closed exactly as the plan specified. Auto-fixes preserved the plan's intent (every commit ships with green build, test, and cycles); the only verification gap is the pre-existing unrelated lint:security error.

## Issues Encountered

- **Architecture-test failure after Task 2.** The `public-export-consumers.test.ts` gate scans only `packages/` and treats integration tests as non-consumers. The new mTLS barrel exports failed the gate even though they have a legitimate consumer in `test/integration/gateway/mtls-handshake.test.ts`. Resolved by adding policy entries (documented Rule 3 deviation above).
- **Deleting `hookRunner` lifecycle calls in `hono-server.ts` orphaned 2 `@comis/core` types.** The dead `deps.hookRunner?.runGatewayStart()` / `runGatewayStop()` calls were the only in-repo consumers of `HookGatewayStartContext` and `HookGatewayStopContext`. Resolved by adding them to the core baseline-orphan policy (documented Rule 3 deviation above).
- **pnpm test reported "1 error" on first run with worker-exit message + intermittent happy-dom `URL is not a constructor` noise.** Re-running `pnpm test` produced 1311/1311 file pass with 24268/24280 test pass (12 skipped) and no errors. The "URL is not a constructor" is happy-dom stdout noise from unrelated tests exercising download-link click handlers (the tests themselves pass — happy-dom's window.open shim is incomplete).

## Verification Commands Run

| Command | Result |
| --- | --- |
| `pnpm vitest run packages/gateway/src/rpc/method-router.test.ts packages/gateway/src/rpc/ws-handler.test.ts` | 488 passed (full gateway suite at Task 1 checkpoint) |
| `pnpm --filter @comis/gateway test` (after each task) | 474 passed / 32 files (post-deletion baseline) |
| `pnpm --filter @comis/web test` (after Task 3) | 2379 passed / 140 files |
| `pnpm --filter @comis/daemon test` (after Task 2) | 2524 passed / 128 files |
| `pnpm build` (full workspace, after each commit) | All packages green |
| `pnpm cycles` | No circular dependency found |
| `pnpm test` (full workspace, after architecture fix) | 1311 files / 24268 tests passed (12 skipped) |
| `npx vitest run test/architecture/public-export-consumers.test.ts` | 11/11 passed |
| `grep -rn 'createMethodRouter\|createStubMethods\|createWebhookEndpoint\|WebhookPayloadSchema' packages/ test/ --include='*.ts' --exclude-dir=dist` | Only clarifying comments remain |
| `grep -rn 'webhookDeps\|oauthCallbackDeps\|hookRunner' packages/gateway/src --include='*.ts'` | 0 matches |
| `grep -nE 'c\.get\(.clientId.\)' packages/gateway/src/rate-limit/rate-limiter.ts` | 0 matches |
| `grep -nE 'config\.set.*path' packages/web/src/views/scheduler-controller.ts` | 0 matches |
| `grep -n 'extractClientCN' packages/gateway/src/index.ts` | 1 match (barrel ADD landed) |
| `grep -n 'from "@comis/gateway"' test/integration/gateway/mtls-handshake.test.ts` | 1 match (inline copy gone) |

## Threat Surface Scan

No new security-relevant surface introduced. All changes are deletions or contract tightening:
- `extractClientCN` barrel export: pure parser (TLS socket → string CN), no new attack surface (function already exposed via the integration test's inline copy).
- `config.set` Zod tightening: REDUCES surface (web caller updated atomically — no transient "loose accept" window).
- `createWebhookEndpoint` deletion: REMOVES a strict-schema enforcement point, but the path was dead — daemon only mounts `createMappedWebhookEndpoint`.
- Rate-limiter IP-only keying: matches the documented behaviour; the `clientId` derivation was never live.

Plan's `<threat_model>` register: all 5 STRIDE entries resolved as `mitigate` (T-55-01-01) or `accept` (T-55-01-02 through T-55-01-05). No deviations from the planned threat dispositions. Severity remains LOW.

## Self-Check: PASSED

Verified each claim:

- [x] `git log --oneline c700e5c0..HEAD` shows 6 commits matching Plan 55-01's task structure.
- [x] `git show 53ea05b1 --stat` confirms Task 1 modified 4 files (-180 +67 LOC).
- [x] `git show 8b384282 --stat` confirms Task 2a modified 2 files (+5 -11 LOC).
- [x] `git show 1b7fcd13 --stat` confirms Task 2b+c modified 3 files (+5 -392 LOC).
- [x] `git show 527bd10d --stat` confirms Task 3a modified 2 files (+33 -38 LOC).
- [x] `git show 4d2df8a8 --stat` confirms Task 3b modified 3 files (+7 -9 LOC).
- [x] `git show 4aa1fd43 --stat` confirms the policy follow-up modified 1 file (+15 LOC).
- [x] All requirements (DEAD-MOD-16, DEAD-MOD-17, DUP-CONS-12, BC-REM-11) addressed per their per-task acceptance criteria.
- [x] No SUMMARY.md / STATE.md / ROADMAP.md modifications during execution (worktree mode; orchestrator owns these).

## Known Stubs

None. No hardcoded empty values, no placeholder text, no TODO/FIXME markers introduced.

## Next Phase Readiness

- **Gateway public surface is tighter and matches production exactly.** Plans 55-02 through 55-07 inherit a known-good baseline.
- **No blockers for parallel waves.** This plan touches gateway src/test + one web caller; no overlap with other 55-XX plans (which target web router, observability, infra, CLI, comis umbrella).
- **Deferred work:** Pre-existing `lint:security` error in `packages/agent/src/safety/validation-error-formatter.ts:38` (see `.planning/phases/55-.../deferred-items.md`).

---
*Phase: 55-gateway-web-observability-infra-cli-comis-deletions*
*Completed: 2026-05-22*
