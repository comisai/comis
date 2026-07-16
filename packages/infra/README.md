# @comis/infra

Structured logging infrastructure for the [Comis](https://github.com/comisai/comis) platform, built on [Pino](https://getpino.io).

## What's Inside

- **`createLogger(options)`** -- Factory for creating structured JSON loggers
- **Credential redaction** -- Automatic scrubbing of `apiKey`, `token`, `password`, `secret`, `authorization`, and other sensitive fields (nested to 3 levels)
- **Custom log levels** -- Standard Pino levels plus `audit` for security events
- **Error classification** -- Closed `ErrorKind` union: `config`, `network`, `auth`, `validation`, `precondition`, `timeout`, `resource`, `dependency`, `internal`, `platform`, and `sandbox_unavailable`
- **Canonical field vocabulary** -- Consistent structured fields such as `agentId`, `traceId`, `channelType`, `durationMs`, `toolName`, `method`, `err`, `hint`, `errorKind`, and `submodule`; composition-root child loggers bind their module name

## Usage

```typescript
import { createLogger } from "@comis/infra";

const logger = createLogger({ name: "comis", level: "info" });

logger.info({ agentId: "agent_a", durationMs: 42 }, "Execution complete");
logger.error(
  {
    err: new Error("Provider authentication failed"),
    hint: "Check the configured provider credential",
    errorKind: "auth",
  },
  "Provider authentication failed",
);
```

## Part of Comis

Application packages normally receive the structural `ComisLogger` contract through dependency injection; the daemon composition root owns the Pino runtime and subsystem child loggers.

This package is part of [Comis](https://github.com/comisai/comis), an open-source runtime built for AI agents you leave running.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
