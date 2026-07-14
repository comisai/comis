# @comis/shared

Foundation layer for the [Comis](https://github.com/comisai/comis) platform. Provides error handling primitives, async utilities, and caching with zero runtime dependencies.

## What's Inside

- **`Result<T, E>`** -- Discriminated union for explicit error handling in domain and internal code
- **`ok(value)` / `err(error)`** -- Result constructors
- **`tryCatch(fn)`** -- Wraps synchronous functions into `Result<T, Error>`
- **`fromPromise(promise)`** -- Wraps promises into `Promise<Result<T, Error>>`
- **`suppressError(promise, reason)`** -- Suppresses promise rejections with structured debug logging
- **`withTimeout(promise, ms, scheduleTimeout, label?)`** -- Races a promise against a wall-clock deadline using a caller-supplied timer scheduler
- **`checkAborted(signal)`** -- Checks `AbortSignal` status, returns `Result`
- **`createTTLCache(opts)`** -- Factory for TTL-based in-memory cache with lazy expiry and FIFO eviction

Comis runtime packages use `@comis/shared` for `Result`-based error handling and common async utilities.

## Usage

```typescript
import { ok, err, fromPromise, tryCatch, withTimeout } from "@comis/shared";
import { systemScheduleTimeout } from "@comis/core";

// Wrap async operations
const result = await fromPromise(fetch("/api/data"));
if (!result.ok) {
  console.error(result.error);
}

// Wrap sync operations
const parsed = tryCatch(() => JSON.parse(raw));

// Hard deadline for async work
const response = await withTimeout(
  longRunningTask(),
  5000,
  systemScheduleTimeout,
  "llm-call",
);
```

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source, security-first platform for AI agent teams.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
