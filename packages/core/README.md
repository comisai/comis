# @comis/core

Core domain layer for the [Comis](https://github.com/comisai/comis) platform. Defines port interfaces, domain types, the event bus, security infrastructure, configuration schemas, and the composition root.

## What's Inside

### Port Interfaces

Hexagonal architecture boundaries: core defines contracts for channels, memory and context, sessions, skills and tools, model/media providers, secrets, delivery, execution plans, clocks, timers, environment access, and file locking. Adapter packages implement those ports.

### Domain Types

Zod-validated schemas and inferred TypeScript types for messages, agents, sessions, execution graphs, approvals, security, and subagent lifecycle.

### Security

Guards, crypto, and audit infrastructure: path traversal defense, secret management (AES-256-GCM), output guards, input validation, SSRF guards, rate limiting, external-content wrapping, and prompt-injection detection.

### Event Bus

`TypedEventBus` with strongly-typed events across `MessagingEvents`, `AgentEvents`, `ChannelEvents`, and `InfraEvents`.

### Configuration

Zod schemas provide layered configuration validation across defaults, environment projection, and YAML files. The configuration covers agents, channels, security, integrations, the gateway, and runtime operations.

### Bootstrap

Composition root (`bootstrap()`) wires the application: creates `SecretManager` -> loads config -> builds event bus, plugin registry, and hook runner -> returns `AppContainer`.

`RequestContext` provides AsyncLocalStorage-based request-scoped context for tracing and tenant propagation.

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source governed agent runtime for inspectable, constrained, and recoverable multi-agent systems.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
