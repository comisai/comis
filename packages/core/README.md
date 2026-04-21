# @comis/core

Core domain layer for the [Comis](https://github.com/comisai/comis) platform. Defines port interfaces, domain types, the event bus, security infrastructure, configuration schemas, and the composition root.

## What's Inside

### Port Interfaces

Hexagonal architecture boundaries -- core defines the contracts, other packages implement adapters.

| Port | Purpose |
|------|---------|
| `ChannelPort` | Messaging platform adapters |
| `MemoryPort` | Session and context storage |
| `SkillPort` | Tool and skill registration |
| `EmbeddingPort` | Vector embedding providers |
| `TranscriptionPort` | Speech-to-text adapters |
| `TTSPort` | Text-to-speech adapters |
| `VisionPort` | Image and video analysis |
| `ImageGenerationPort` | Image generation providers |
| `MediaResolverPort` | Platform-specific media resolution |
| `FileExtractionPort` | Document text extraction |
| `OutputGuardPort` | LLM output secret-leak scanning |
| `SecretStorePort` | Encrypted credential storage |
| `DeviceIdentityPort` | Cryptographic device identity |
| `DeliveryQueuePort` | Message delivery queue |
| `DeliveryMirrorPort` | Delivery deduplication |

### Domain Types

Zod-validated schemas and inferred TypeScript types for messages, agents, sessions, execution graphs, approvals, security, and subagent lifecycle.

### Security

Guards, crypto, and audit infrastructure: path traversal defense, secret management (AES-256-GCM), output guard, input validation, SSRF guards, rate limiting, content wrapping, and 40+ prompt injection detection patterns.

### Event Bus

`TypedEventBus` with strongly-typed events across `MessagingEvents`, `AgentEvents`, `ChannelEvents`, and `InfraEvents`.

### Configuration

100+ Zod schemas for layered config validation (defaults -> YAML -> env overrides). Covers agents, channels, security, integrations, gateway, and more.

### Bootstrap

Composition root (`bootstrap()`) wires the application: creates `SecretManager` -> loads config -> builds event bus, plugin registry, and hook runner -> returns `AppContainer`.

`RequestContext` provides AsyncLocalStorage-based request-scoped context for tracing and tenant propagation.

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
