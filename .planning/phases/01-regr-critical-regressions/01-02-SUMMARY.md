---
phase: 01-regr-critical-regressions
plan: "02"
subsystem: "@comis/infra/logging + @comis/daemon/observability + @comis/skills/exec-tool"
tags:
  - log-redaction
  - pino-pipeline
  - credentials
  - tdd
  - R1
dependency-graph:
  requires:
    - "01-01 (R0: hf_/hfr_ in PLAINTEXT_SECRET_PREFIXES — prerequisite for redactSecretsInText to catch hf_ tokens)"
  provides:
    - pipeline-redact-stage: pino-abstract-transport pipeline-mode Transform that scrubs every log line
    - serializers.err: redacts err.message and err.stack in all createLogger loggers
    - exec command sanitized before logging
    - daemon.log: no plaintext credentials reach this file (R1)
  affects:
    - "@comis/infra/logging/logger.ts"
    - "@comis/infra/logging/pipeline-redact-stage.ts"
    - "@comis/daemon/observability/log-infra.ts"
    - "@comis/skills/tools/builtin/exec-tool/index.ts"
tech-stack:
  added:
    - "pino-abstract-transport@3.0.0 — explicit direct dependency in @comis/infra (was transitive via pino@10.3.1)"
  patterns:
    - "TDD RED→GREEN: failing test committed first, GREEN patch flips it"
    - "Pino TransportPipelineOptions: { pipeline: [stage, destination] } — correct API for upstream Transform"
    - "pino-abstract-transport build(asyncGenerator, { enablePipelining: true, parse: 'lines' })"
    - "Pino serializers.err: scrubs err.message + err.stack via redactSecretsInText"
    - "Polling readFile loop to handle pino worker-thread startup latency in tests"
key-files:
  created:
    - packages/infra/src/logging/pipeline-redact-stage.ts
  modified:
    - packages/infra/src/logging/logger.ts
    - packages/infra/src/logging/logger.test.ts
    - packages/infra/package.json
    - packages/daemon/src/observability/log-infra.ts
    - packages/daemon/src/observability/log-infra.test.ts
    - packages/skills/src/tools/builtin/exec-tool/index.ts
    - pnpm-lock.yaml
decisions:
  - "Used TransportPipelineOptions { pipeline: [stage, dest] } in targets[] — NOT targets[].target + targets[].pipeline (wrong API per pino runtime)"
  - "parse: 'lines' option on pino-abstract-transport to receive raw string lines (not parsed JSON objects) in the async generator"
  - "Polling readFile loop (100ms intervals, up to 8–12s deadline) for test reliability under concurrent validate load"
  - "Type cast targets as TransportTargetOptions[] on return to satisfy pino.d.ts@10.3.1 which models target and pipeline as mutually exclusive"
metrics:
  duration: "~43 minutes"
  completed: "2026-05-27T14:25:54Z"
  tasks_completed: 2
  files_modified: 8
---

# Phase 1 Plan 2: R1 — Pipeline Redact Stage + serializers.err + exec command sanitize Summary

Stopped plaintext credentials from reaching `daemon.log` via three changes in concert: (1) a new `pipeline-redact-stage.ts` using `pino-abstract-transport build({ enablePipelining: true, parse: 'lines' })` wrapping `redactSecretsInText`; (2) `createFileTransport` in `log-infra.ts` now uses `TransportPipelineOptions` so every log line is scrubbed before writing to pino-roll or stdout; (3) `serializers.err` added to `createLogger` to scrub `err.message` and `err.stack`; (4) exec tool's raw `command` sanitized at log call site.

## Objective

The daemon's `daemon.log` was receiving plaintext `Bearer hf_…` credentials because `createLogger`'s `if (transport)` branch (line 229) installed the caller-supplied multi-target config unchanged — bypassing the regex-redact transport. Additionally `err.stack` was rendered verbatim (no Pino `serializers.err`) and the exec tool logged raw commands.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | RED: R1 failing tests — multi-target transport + err.stack scrub | 505b1f9 | `logger.test.ts` |
| 2 | GREEN: pipeline-redact-stage + serializers.err + exec sanitize | 19cc298 | `pipeline-redact-stage.ts`, `logger.ts`, `logger.test.ts`, `log-infra.ts`, `log-infra.test.ts`, `exec-tool/index.ts`, `package.json`, `pnpm-lock.yaml` |

## What Was Built

### New file: `packages/infra/src/logging/pipeline-redact-stage.ts`

Pino pipeline-mode Transport that scrubs every log line via `redactSecretsInText` from `@comis/observability`:

```typescript
export default function createPipelineRedactStage(_opts?: unknown): Transform {
  return build(
    (source) => (async function* () {
      for await (const line of source as AsyncIterable<unknown>) {
        const lineStr = typeof line === 'string' ? line : JSON.stringify(line);
        try { yield redactSecretsInText(lineStr); }
        catch { yield lineStr; } // safety net: never drop a log line
      }
    })() as unknown as Transform & build.OnUnknown,
    { enablePipelining: true, parse: 'lines' },
  ) as unknown as Transform;
}
```

### Changed: `packages/daemon/src/observability/log-infra.ts`

`createFileTransport` now returns `TransportPipelineOptions[]` — each entry is `{ pipeline: [redact-stage, file-dest] }`:

```typescript
targets.push({
  pipeline: [
    { target: '@comis/infra/dist/logging/pipeline-redact-stage.js' },
    { target: 'pino-roll', options: { file, size, mkdir, limit } },
  ],
  ...(level ? { level } : {}),
});
```

Both the pino-roll (file) and pino/file (stdout) targets have the redact stage upstream, covering both pm2 and direct-stdout paths.

### Changed: `packages/infra/src/logging/logger.ts`

Added `serializers.err` to `createLogger` (gated on `!options.disableRedaction`):

```typescript
pinoOptions.serializers = {
  err: (err: unknown) => {
    if (err instanceof Error) {
      return {
        message: redactSecretsInText(err.message),
        stack: err.stack ? redactSecretsInText(err.stack) : undefined,
        name: err.name,
      };
    }
    return err as Record<string, unknown>;
  },
};
```

### Changed: `packages/skills/src/tools/builtin/exec-tool/index.ts`

```typescript
logger?.debug({
  toolName: "exec",
  command: redactSecretsInText(command.slice(0, 200)),
  // ...
}, "Exec command start");
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pino TransportPipelineOptions instead of TransportTargetOptions + pipeline**

- **Found during:** Task 2 (GREEN) debugging
- **Issue:** The plan specified `targets[i].pipeline = [{ target: stage }]` alongside `targets[i].target = 'pino-roll'`. Pino's transport.js treats this object as BOTH a target (raw write to pino-roll) AND a pipeline source — the pipeline output goes to a `PassThrough` with no final destination. The plaintext still reaches pino-roll; the redact stage output goes nowhere.
- **Fix:** Used `TransportPipelineOptions` entries (no `target` property, `pipeline` array with [redact-stage, file-dest]) — the correct pino API per pino/docs/transports.md for chaining a Transform before a Writable.
- **Files modified:** `packages/daemon/src/observability/log-infra.ts`
- **Commit:** 19cc298

**2. [Rule 1 - Bug] pino-abstract-transport async generator needs `parse: "lines"` option**

- **Found during:** Task 2 debugging
- **Issue:** Without `parse: 'lines'`, pino-abstract-transport's split2 stream emits parsed JSON objects (not strings). The async generator's `redactSecretsInText(JSON.stringify(obj))` re-stringified objects but lost the correct JSON structure.
- **Fix:** Added `parse: 'lines'` to the `build()` options so split2 passes raw string lines to the generator.
- **Files modified:** `packages/infra/src/logging/pipeline-redact-stage.ts`
- **Commit:** 19cc298

**3. [Rule 1 - Bug] Updated log-infra.test.ts to match new TransportPipelineOptions structure**

- **Found during:** Task 2 `pnpm validate` run
- **Issue:** 12 existing tests in `log-infra.test.ts` accessed `targets[i].target` and `targets[i].options` directly — these fields moved to `targets[i].pipeline[1].target` and `targets[i].pipeline[1].options` after the pipeline refactor.
- **Fix:** Added helper functions `getPipelineTarget()` / `getPipelineTargetName()` and updated all 12 tests. Added a new R1-specific test asserting pipeline-redact-stage is present in every target.
- **Files modified:** `packages/daemon/src/observability/log-infra.test.ts`
- **Commit:** 19cc298

**4. [Rule 1 - Bug] Removed temporary `disableRedaction: true` comment literal**

- **Found during:** Task 2 `pnpm validate` run
- **Issue:** The `source-rules.test.ts` architecture test source-greps for the literal `disableRedaction: true` in production source and fails. A JSDoc comment I added contained this literal.
- **Fix:** Rephrased comment to avoid the literal string.
- **Files modified:** `packages/infra/src/logging/logger.ts`
- **Commit:** 19cc298

**5. [Rule 1 - Bug] Polling readFile loop for R1-a test reliability**

- **Found during:** Task 2 `pnpm validate` (concurrent test suite)
- **Issue:** R1-a used a fixed 1500ms `setTimeout` which was insufficient under full `pnpm validate` load — the pipeline transport's worker threads take longer to initialize when 1353 test files are running concurrently.
- **Fix:** Replaced fixed timeout with a 100ms polling loop (up to 8–12s deadline) that exits as soon as the file has content.
- **Files modified:** `packages/infra/src/logging/logger.test.ts`
- **Commit:** 19cc298

## Key Implementation Discovery

The plan specified `targets[i].pipeline` (alongside `targets[i].target`) as the injection approach. Research confirmed this works at the TYPE level (pino.d.ts has this field combination) but NOT at the RUNTIME level: pino's `transport.js` adds any target with `.target` to `options.targets` (raw multi-stream fan-out) AND any target with `.pipeline` to `options.pipelines` (stage-only chain). These are processed independently in the worker thread — the pipeline stage runs but its output is never connected to the file destination.

The correct API (per pino/docs/transports.md "Creating a transport pipeline") is `TransportPipelineOptions`: `{ pipeline: [transform, destination] }` with NO `target` property — the `pipeline` array contains both the intermediate Transform and the final Writable. This creates a proper `stream.pipeline(source, transform, dest)` chain in the worker.

## Verification Results

```
pnpm vitest run packages/infra/src/logging/logger.test.ts -t "R1"
→ 2 passed (R1-a, R1-b)

pnpm validate
→ 1353 test files passed; 0 lint errors; ✔ No circular dependency found

grep -c 'pipeline-redact-stage' packages/daemon/src/observability/log-infra.ts → 2
grep -c 'enablePipelining' packages/infra/src/logging/pipeline-redact-stage.ts → 3
grep -c 'serializers' packages/infra/src/logging/logger.ts → 1
grep -c '"pino-abstract-transport"' packages/infra/package.json → 1
```

### Acceptance criteria

- [x] RED test committed first (505b1f9); failed on pre-patch code (R1-a: raw token in file, R1-b: raw err.stack)
- [x] GREEN commit (19cc298): both R1 tests pass
- [x] `Bearer hf_<44+>` masked in errorText, msg fields (R1-a verified by file read)
- [x] `err.stack` containing hf_ token scrubbed (R1-b verified)
- [x] `${HF_TOKEN}` env-ref passes through unmasked (R1-a assertion)
- [x] `pipeline-redact-stage.ts` uses `enablePipelining: true` and `redactSecretsInText`
- [x] Both daemon targets (pino-roll + pino/file stdout) have upstream redact stage
- [x] `serializers.err` added in `createLogger`
- [x] exec tool `command` sanitized via `redactSecretsInText`
- [x] `pino-abstract-transport` exact-pinned `3.0.0` in `packages/infra/package.json`
- [x] `pnpm validate` green (build + test + lint:security + cycles)
- [x] Architecture: `infra → observability` edge (not inverted); `pnpm cycles` clean

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (`test(01-02)`) | 505b1f9 | 2 tests fail on pre-patch code |
| GREEN (`feat(01-02)`) | 19cc298 | 2 tests pass; all 1353 test files pass |

## Known Stubs

None — all behaviors are fully wired.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes. Changes affect the log transport chain (information disclosure reduction) and the exec tool's log call site.

## Self-Check: PASSED

- `packages/infra/src/logging/pipeline-redact-stage.ts` — FOUND (created)
- `packages/infra/src/logging/logger.ts` — FOUND (modified: serializers.err)
- `packages/daemon/src/observability/log-infra.ts` — FOUND (modified: pipeline structure)
- `packages/skills/src/tools/builtin/exec-tool/index.ts` — FOUND (modified: redactSecretsInText)
- RED commit 505b1f9 — FOUND in git log
- GREEN commit 19cc298 — FOUND in git log
- `pnpm validate` exits 0 — CONFIRMED
