# @comis/infra

Structured logging infrastructure for the [Comis](https://github.com/comisai/comis) platform, built on [Pino](https://getpino.io).

## What's Inside

- **`createLogger(options)`** -- Factory for creating structured JSON loggers
- **Credential redaction** -- Automatic scrubbing of `apiKey`, `token`, `password`, `secret`, `authorization`, and other sensitive fields (nested to 3 levels)
- **Custom log levels** -- Standard Pino levels plus `audit` for security events
- **Error classification** -- 9 `ErrorKind` categories: `config`, `network`, `auth`, `validation`, `timeout`, `resource`, `dependency`, `internal`, `platform`
- **Canonical field vocabulary** -- Consistent field names across all packages: `agentId`, `traceId`, `channelType`, `durationMs`, `toolName`, `method`, `err`, `hint`, `errorKind`, `module`

## Usage

```typescript
import { createLogger } from "@comis/infra";

const logger = createLogger({ module: "my-adapter", level: "info" });

logger.info({ agentId, durationMs: 42 }, "Execution complete");
logger.error({ err, hint: "Check API key", errorKind: "auth" }, "Provider auth failed");
```

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
