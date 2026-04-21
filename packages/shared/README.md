# @comis/shared

Foundation layer for the [Comis](https://github.com/comisai/comis) platform. Provides error handling primitives, async utilities, and caching with zero runtime dependencies.

## What's Inside

- **`Result<T, E>`** -- Discriminated union for explicit error handling (no thrown exceptions)
- **`ok(value)` / `err(error)`** -- Result constructors
- **`tryCatch(fn)`** -- Wraps synchronous functions into `Result<T, Error>`
- **`fromPromise(promise)`** -- Wraps promises into `Promise<Result<T, Error>>`
- **`suppressError(promise, reason)`** -- Suppresses promise rejections with structured debug logging
- **`withTimeout(promise, ms)`** -- Races a promise against a wall-clock deadline
- **`checkAborted(signal)`** -- Checks `AbortSignal` status, returns `Result`
- **`createTTLCache(opts)`** -- Factory for TTL-based in-memory cache with lazy expiry and FIFO eviction

Every package in the Comis monorepo depends on `@comis/shared` for `Result`-based error handling.

## Usage

```typescript
import { ok, err, fromPromise, tryCatch, withTimeout } from "@comis/shared";

// Wrap async operations
const result = await fromPromise(fetch("/api/data"));
if (!result.ok) {
  console.error(result.error);
}

// Wrap sync operations
const parsed = tryCatch(() => JSON.parse(raw));

// Hard deadline for async work
const response = await withTimeout(longRunningTask(), 5000, "llm-call");
```

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
