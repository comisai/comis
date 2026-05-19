# @comis/observability

Diagnostics substrate for the [Comis](https://github.com/comisai/comis) platform. Provides the low-level primitives that every diagnostics artifact written under `~/.comis` flows through: queued append-only writers, payload bounding, secret redaction, symlink-safe path guards, and the four diagnostic record streams (trajectory, system-prompt-report, cache-trace, config-audit).

Depends only on `@comis/core` and `@comis/shared`. Architecture-test enforced: must not import `@comis/agent`, `@comis/daemon`, `@comis/cli`, or `@comis/orchestrator`.

## What's Inside

### Writer chassis (`shared/`)

- **`getQueuedFileWriter()`** -- Single-promise-chain append writer with backpressure, `flushAndClose()`, and `failureCount` / `lastError` / `rejectedBytes` surface for sentinel emission
- **`appendRegularFile()` / `writeRegularFile()`** -- Symlink-safe fs primitives with `O_NOFOLLOW`, optional `confinedBaseDir`, and three typed error sentinels (`SymlinkParentRejected`, `PathEscapesConfinementError`, `FileSizeLimitExceeded`)
- **`limitPayloadValue()` + `PAYLOAD_BOUNDS`** -- Bounded-payload limiter with `BoundedSentinel` enum for over-budget replacement
- **`sanitizeDiagnosticPayload()`** -- Credential-field drop, image-bytes -> sha256, cycle-safe walk
- **`resolveContainedPath()` / `resolveSafeOpenFlags()` / `PathEscapeError`** -- Path containment + safe open flags
- **`stableStringify()`** -- Canonical JSON for digest-stable hashing
- **`safeJsonStringify()`** -- Circular-safe `JSON.stringify` wrapper

### Redaction (`redact/`)

- **`maskToken()` / `maskPemBlock()`** -- Edge-keeping mask with `U+2026` ellipsis
- **`redactIdentifier()`** -- sha256-prefix opaque-id helper
- **`replacePatternBounded()`** -- ReDoS-guarded chunked regex replace
- **`getDefaultRedactPatterns()`** -- 32-pattern default set (Slack/Discord/HMAC + Comis-prefix tokens)
- **`redactSecretsInText()` / `redactSecrets()` / `sanitizeForPersistence()`** -- Text + structured-walker redactors
- **`pinoRedactTransport`** -- Pino transport factory that replaces Pino's `[REDACTED]` censor with the masked-edge form

### Diagnostic streams

| Module | Surface | Purpose |
|--------|---------|---------|
| `trajectory/` | `createTrajectoryRecorder`, `attachTrajectoryToEventBus`, `TRAJECTORY_EVENT_TYPES` | Per-session lifecycle recorder with bounded payloads and `trace.truncated` / `trace.write_failures` sentinels |
| `system-prompt-report/` | `buildSystemPromptReport`, `persistSystemPromptReport`, `SystemPromptReportSchema` | sha256-digested snapshot of the assembled system prompt, persisted via `ObservabilityStore` |
| `cache-trace/` | `createCacheTrace`, `buildCacheTraceWrapper`, `attachCacheTraceToEventBus`, `CacheTraceEventSchema` | Per-stage prompt-cache hit/miss trace, JSONL persisted |
| `cache-stats/` | `aggregateCacheStats`, `parseSince` | Window-rolled cache-hit aggregation backing the `obs.cacheStats.window` RPC |
| `config-audit/` | `ConfigWriteAuditRecordSchema`, argv-redactor (39 flags + suffix heuristic), suspicious-heuristics detector, append + scrub | Tamper-evident audit of every config write path |

## Usage

```typescript
import {
  getQueuedFileWriter,
  sanitizeForPersistence,
  maskToken,
} from "@comis/observability";

// Append-only writer with backpressure
const writer = getQueuedFileWriter({ filePath, maxBytes: 10_000_000 });
await writer.append(JSON.stringify(record) + "\n");
await writer.flushAndClose();

// Redact secrets before persistence
const safe = sanitizeForPersistence(payload);

// Edge-keeping mask for non-credential identifiers
maskToken("sk-abc1234567890def", { keepStart: 4, keepEnd: 4 });
// -> "sk-a…0def"
```

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
