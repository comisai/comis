---
phase: 01-regr-critical-regressions
reviewed: 2026-05-27T15:05:00Z
remediated: 2026-05-27T18:10:00Z
depth: standard
status: fixed
files_reviewed: 13
files_reviewed_list:
  - packages/core/src/security/secret-detection.ts
  - packages/core/src/security/secret-detection.test.ts
  - packages/core/package.json
  - packages/core/vitest.config.ts
  - packages/infra/src/logging/pipeline-redact-stage.ts
  - packages/infra/src/logging/logger.ts
  - packages/infra/src/logging/logger.test.ts
  - packages/infra/package.json
  - packages/daemon/src/observability/log-infra.ts
  - packages/daemon/src/observability/log-infra.test.ts
  - packages/skills/src/tools/builtin/exec-tool/index.ts
  - packages/agent/src/context-engine/context-engine.ts
  - packages/agent/src/context-engine/context-engine.test.ts
findings:
  critical: 1
  warning: 4
  info: 2
  total: 7
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-05-27T15:05:00Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 1 (REGR) lands three security-critical credential-redaction changes: R0 (secret-prefix vocabulary unification + parity guard), R1 (daemon.log secret-redaction pipeline stage + `serializers.err` + exec `command` sanitize), and R5 (signed-thinking scrubber re-wire). All four touched test suites pass (secret-detection 27, infra logger 117, daemon log-infra 32, agent context-engine 48), `pnpm cycles` is clean, and there is no production `@comis/core → @comis/observability` import edge (cycle invariant intact).

However, the R1 redaction pipeline contains a **BLOCKER** that the substring-only tests cannot see: the pipeline-redact stage **strips the newline between log lines**, so the production `daemon.log` (the very file R1 exists to protect) is written as a single concatenated, JSON-unparseable blob. I reproduced this end-to-end through the real compiled stage. Redaction "works" (the token is masked) but the log file is corrupt. Several quality defects compound the risk: the R0-c "drift guard" silently skips the majority of provider prefixes, the keystone scanner has real false-negatives for common credential shapes (`AIza`, `ya29.`, `xapp-`, `pplx-`, `comis_`) that now slip the wired config-write/mcp firewall, and the new zero-length-requirement prefixes introduce false-positives that will reject legitimate config (`npm_config_cache`, anything starting with `AKID`/`LTAI`). The R5 layer insertion is correct (ordering and always-on both verified).

## Critical Issues

### CR-01: Pipeline-redact stage strips newlines — daemon.log becomes a single unparseable concatenated line

**File:** `packages/infra/src/logging/pipeline-redact-stage.ts:41-46`

**Issue:** `pino-abstract-transport` is built with `parse: "lines"`, which uses `split2` to deliver each log line to the async generator **with the trailing `\n` already stripped**. The generator yields `redactSecretsInText(lineStr)` (and `lineStr` in the catch path) **without re-appending `\n`**. The downstream `pino-roll` / `pino/file` destination writes each yielded value verbatim and back-to-back, so every log record is mashed together:

```
{"level":30,...,"msg":"line one"}{"level":30,...,"msg":"line two"}{"level":30,...,"msg":"line three"}
```

This is the **active production path**: `setup-logging.ts:69-77` builds `createFileTransport(...)` and passes it as `transport` to `createLogger`, and `logger.ts:252-253` (`if (transport) { pinoOptions.transport = transport; }`) installs it unchanged. Both pipeline targets in `createFileTransport` (the `pino-roll` file target at `log-infra.ts:148-165` and the `pino/file` stdout target at `log-infra.ts:170-176`) route through this stage, so **both** the direct-run and pm2-aware paths are affected.

Reproduced through the real compiled stage (`packages/infra/dist/logging/pipeline-redact-stage.js`) with 3 log lines to a temp file:
- raw line count (split on `\n`): **1** (expected 3)
- JSON-parseable lines: **0** (the `}{` joins are not valid JSON)
- trailing newline present: **false**

Confirmed the fix (append `\n`) restores 3 parseable lines. The result: `~/.comis/logs/daemon.log` is unreadable line-by-line — `pino-roll` rotation reasoning, JSON log shippers, `grep`/`tail`-by-line, and the daemon's own log-validation harness (`test:orchestrate`) all break. The R1-a/R1-b tests (`logger.test.ts:819-895`) pass only because they assert `content.not.toContain(HF_TOKEN)` / `content.toContain(ENV_REF)` — substring checks that are satisfied by a concatenated blob, with no line-count or `JSON.parse` assertion.

For contrast, the existing single-target `redact-transport.js` (`packages/observability/src/redact/pino-redact-transport.ts:46-63`) does NOT use `parse: "lines"` — it operates on raw chunks and therefore preserves the trailing `\n` naturally. The new pipeline stage broke that invariant by switching to line-parse mode without restoring the delimiter.

**Fix:** Re-append the newline on both yield paths:
```typescript
for await (const line of source as AsyncIterable<unknown>) {
  const lineStr = typeof line === "string" ? line : JSON.stringify(line);
  try {
    yield redactSecretsInText(lineStr) + "\n";
  } catch {
    yield lineStr + "\n";
  }
}
```
Add a regression assertion to the R1 tests that the captured file contains the expected number of `\n`-delimited lines and that each line is `JSON.parse`-able (not just a token-absence substring check).

## Warnings

### WR-01: R0-c parity "drift guard" silently skips hyphenated and non-`_`-terminated prefixes — does not enforce its stated invariant

**File:** `packages/core/src/security/secret-detection.test.ts:277-286`

**Issue:** The drift guard extracts a pattern's prefix with `/\\b([A-Za-z0-9][A-Za-z0-9_]*)/`. The character class `[A-Za-z0-9_]` **excludes `-` and `.`**, so for `sk-prefix` it extracts `"sk"` (not `"sk-"`), for `slack-app-token` `"xapp"`, for `perplexity-key` `"pplx"`, for `google-oauth-bearer` `"ya29"`. The subsequent filter (line 282) then `continue`s past any extracted string that does not end in `_`/`-` or match `^[A-Z0-9]{4,}$`, so every one of those truncated prefixes is skipped and **never asserted**. Verified against the live `getDefaultRedactPatterns()`: of 17 prefix-kind patterns, only 6 (`ghp_`, `gsk_`, `npm_`, `AKID`, `LTAI`, `hf_`, `r8_`) are actually checked; `sk-`, `xapp-`, `pplx-`, `AIza`, `ya29.`, `1//0`, `eyJ`, slack/telegram/apple are all silently skipped. The plan's must-have truth — "A parity test fails if `patterns.ts` has a prefix-kind pattern whose extracted prefix is absent from `PLAINTEXT_SECRET_PREFIXES`" — is therefore not met. A future addition of, say, an `xai-` prefix to `patterns.ts` would NOT trip this guard, defeating its purpose.

**Fix:** Extend the extraction class to include `-` and `.` (e.g. `/\\b([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\[|\\\\|$)/` or parse the literal-prefix portion before the first quantifier), and drop the `endsWith("_")||endsWith("-")||/^[A-Z0-9]{4,}$/` skip so hyphenated prefixes are asserted. If certain patterns are intentionally exempt (JWT `eyJ`, telegram `\d{8,}:`, apple), maintain an explicit allow-skip list keyed by `p.name` rather than an implicit shape filter that hides real prefixes.

### WR-02: Keystone false-negatives — common credential shapes slip the wired config-write / mcp.connect firewall

**File:** `packages/core/src/security/secret-detection.ts:142-163` (`looksLikeSecretValue`), `51-73` (`PLAINTEXT_SECRET_PREFIXES`)

**Issue:** `looksLikeSecretValue` returns `false` for realistic-length tokens whose prefix is in `patterns.ts` but absent from `PLAINTEXT_SECRET_PREFIXES`, because they fall below the 44-char entropy-backstop floor (or contain a delimiter char). Verified with the compiled keystone:
- `xapp-1-A0123456789-ABCDEF012345` (Slack app token, 31 chars) → `false`
- `pplx-abc123def456ghi789jkl012m` (Perplexity, 30 chars) → `false`
- `AIzaSyA1234567890abcdefghijklmnopqrstu` (Google API key, 38 chars) → `false`
- `ya29.a0AfH6SMBxxxxxxxxxxxxxxxxx` (Google OAuth, 31 chars) → `false`
- `1//0abcdefghijklmnopqrstuvwxyz` (Google refresh, contains `/`) → `false`
- `comis_abc123def456ghi789` (Comis platform token, 24 chars) → `false`

This matters because `scanForSecrets` is **already wired** into the config-write/firewall paths (`packages/daemon/src/api/shared/persist-to-config.ts:245`, `packages/daemon/src/api/mcp-handlers.ts:183,459`, `packages/daemon/src/config/last-known-good.ts:76`), not deferred to Phase 3 as the module header implies. Confirmed end-to-end: `scanForSecrets({ integrations:{ mcp:{ servers:[{ args:["--key","AIzaSyA1234567890abcdefghijklmnopqrstu"] }] } } })` returns `[]` — a plaintext Google API key in an MCP `args[]` array passes the firewall unflagged. R0's stated goal ("close the parity gap vs `@comis/observability` `patterns.ts`") is only partially achieved; the masked WR-01 guard is what allowed this gap to remain invisible.

**Fix:** Add the remaining provider prefixes that exist in `patterns.ts` to `PLAINTEXT_SECRET_PREFIXES` (`xapp-`, `pplx-`, `AIza`, `ya29.`, `comis_`, and consider `1//0`), or document explicitly (in the module header and the parity test) that these shapes are intentionally delegated to the entropy backstop / structural patterns and are NOT covered by the keystone value heuristic. Either way, fix WR-01 first so the parity test reflects reality.

### WR-03: New zero-length-requirement prefixes cause false-positives that reject legitimate config

**File:** `packages/core/src/security/secret-detection.ts:152-154` (prefix loop), `66-72` (R0 additions)

**Issue:** The prefix scan early-returns `true` on a bare `startsWith(prefix)` match with **no length or entropy requirement**. The R0 additions (`hf_`, `hfr_`, `r8_`, `gsk_`, `npm_`, `AKID`, `LTAI`) and the pre-existing `AKIA` therefore flag short, benign, non-secret values. Verified with the compiled keystone:
- `npm_config_cache` → `true` (this is a standard npm-injected environment variable name/value present in virtually every Node process env)
- `AKIDNEYBEAN`, `LTAILGATE` → `true` (any uppercase string with that 4-char head)
- `hf_model_config`, `gsk_test`, `r8_unit_tests` → `true`

The `patterns.ts` equivalents deliberately require 14-20 body chars (`AKID[A-Z0-9]{14,}`, `npm_[A-Za-z0-9_]{20,}`, `hf_[A-Za-z0-9_]{18,}`) precisely to avoid this. Because the keystone is wired into config-write and `mcp.connect` (see WR-02), a false positive **blocks a legitimate operation** — e.g. an MCP server declaring `env: { npm_config_cache: "/path" }`, or any config value that happens to start with `AKID`/`LTAI`. The security direction is safe (over-redaction, not leakage), but it is a usability/correctness regression.

**Fix:** Give the curated prefixes a minimum trailing-body length consistent with `patterns.ts` (e.g. require `remainder.length >= prefix.length + 14` or a per-prefix minimum) before returning `true`, or restrict the bare-prefix early-return to high-specificity prefixes (`ghp_`, `github_pat_`, `sk-ant-`, `xoxb-`, `glpat-`, `sk_live_`, …) and route the short generic ones (`hf_`, `npm_`, `gsk_`, `r8_`, `AKID`, `LTAI`) through a length check. Add negative-control test cases (`npm_config_cache`, `AKIDNEYBEAN`) asserting `false`.

### WR-04: R1 / R0 tests assert only token-absence substrings — no line-integrity or parity-completeness coverage

**File:** `packages/infra/src/logging/logger.test.ts:819-895`, `packages/core/src/security/secret-detection.test.ts:263-297`

**Issue:** The two security-critical regression suites verify weak invariants that let real defects through. R1-a/R1-b assert only `content.not.toContain(HF_TOKEN)` and `content.toContain(ENV_REF)` — both satisfied by the corrupt single-line blob from CR-01, so the suite is green on broken output. R0-c asserts a parity property whose extraction logic (WR-01) silently skips most prefixes, so it is green while not enforcing its contract. For credential-redaction code, the test is the durability mechanism (per the plan's own framing); these tests do not durably constrain the behavior they claim to.

**Fix:** For R1, after polling the file, assert `content.trim().split("\n").length === <expected record count>` and that `JSON.parse` succeeds on each line. For R0-c, after the WR-01 extraction fix, assert that every prefix-kind pattern's literal prefix is present in `PLAINTEXT_SECRET_PREFIXES` (or in an explicit, named exemption set), and add the WR-03 false-positive negative controls.

## Info

### IN-01: exec command is sliced before redaction — boundary-straddling bare token can leak a fragment

**File:** `packages/skills/src/tools/builtin/exec-tool/index.ts:126`

**Issue:** `redactSecretsInText(command.slice(0, 200))` truncates to 200 chars **before** the regex pass. A credential straddling char 200 is cut to a sub-pattern-length fragment that may no longer match a prefix pattern. Verified this is mostly mitigated: a `--token=hf_AAAA…` straddle is still masked by the structural `cli-flag-credential` pattern (`--?…token…=\S+`) which is body-length-agnostic, and a `Bearer …` straddle by `bare-bearer-token`. The residual exposure is a bare prefix token (not behind a recognized `--flag=`/`Bearer`/header) whose body is truncated below the pattern's `{18,}` minimum. Note also the `command:blocked` event (line 109) and the secretRefs INFO log (line 145) pass `command.slice(0, 80/200)` **unredacted** into the event payload; line 145 is caught by the log transport's `redactSecretsInText` pass (once CR-01 is fixed) but the SSE/security-view consumers of `command:blocked` receive the raw prefix.

**Fix:** Redact first, then slice: `redactSecretsInText(command).slice(0, 200)`. Apply the same redact-then-slice ordering to the `commandPrefix` fields at lines 109 and 145.

### IN-02: Dead branch in the pipeline stage under `parse: "lines"`

**File:** `packages/infra/src/logging/pipeline-redact-stage.ts:39`

**Issue:** `const lineStr = typeof line === "string" ? line : JSON.stringify(line);` — with `parse: "lines"`, `split2` always delivers a raw string, so the `JSON.stringify(line)` branch is unreachable. Harmless but misleading (it implies object inputs are possible here).

**Fix:** Either drop the ternary (`const lineStr = line as string;` with a comment that `parse: "lines"` guarantees strings) or keep it but document that it is a defensive no-op for the line-parse contract.

---

## Remediation

Remediated: 2026-05-27T18:10:00Z

| Finding | Status | Commit | Notes |
|---------|--------|--------|-------|
| CR-01 | FIXED | `6f49975` | Re-append `\n` on both yield paths in `pipeline-redact-stage.ts`; RED test: `e9c45c8`; GREEN: `6f49975` |
| IN-02 | FIXED | `6f49975` | Removed dead `JSON.stringify(line)` branch; `line as string` with comment |
| WR-01 | FIXED | `b0e6b62` | Parity test extraction regex updated to `[A-Za-z0-9_.\\-]` to capture `-` and `.`; named exemption set for char-class patterns (jwt, telegram, apple, slack-legacy, google-refresh); RED: `f1541ec`; GREEN: `b0e6b62` |
| WR-02 | FIXED | `b0e6b62` | Added `xapp-`, `AIza`, `ya29.`, `pplx-`, `comis_` to `PLAINTEXT_SECRET_PREFIXES`; RED: `f1541ec`; GREEN: `b0e6b62` |
| WR-03 | FIXED | `b0e6b62` | Added `PREFIX_MIN_BODY_LENGTHS` map mirroring `patterns.ts` `{N,}` quantifiers; `looksLikeSecretValue` now checks `bodyLength >= minBody` before returning true; RED: `f1541ec`; GREEN: `b0e6b62` |
| WR-04 | FIXED | `f1541ec` + `b0e6b62` | New behavior-named RED tests for CR-01 (`e9c45c8`), WR-01/02/03 (`f1541ec`); updated R0-c parity test now enforces the complete keystone⊇observability invariant |
| IN-01 | FIXED | `b0e6b62` | `redactSecretsInText(command).slice(0, N)` on all three callsites (line 109 `command:blocked` event, line 126 debug log, line 145 secretRefs info log) |

`pnpm validate` result: 1353 test files, 25047 tests passed, 0 lint errors, no circular deps.

---

_Reviewed: 2026-05-27T15:05:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
