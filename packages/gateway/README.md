# @comis/gateway

HTTP, JSON-RPC, and WebSocket gateway for the [Comis](https://github.com/comisai/comis) platform, built on [Hono](https://hono.dev).

## What's Inside

### Server

- **`createGatewayServer()`** -- Hono HTTP server with mTLS support, CORS, and rate limiting
- **JSON-RPC 2.0** -- Dynamic method router for agent, config, session, and system operations
- **WebSocket** -- Live connection manager for real-time updates and streaming

### Authentication

- **Bearer tokens** -- Timing-safe token validation with scope-based access control
- **mTLS** -- Mutual TLS with Common Name extraction for service-to-service auth
- **Token store** -- Runtime token management with scope enforcement

### API Compatibility

- **OpenAI-compatible endpoints** -- `/v1/chat/completions`, `/v1/models`, `/v1/embeddings` for drop-in compatibility with OpenAI client libraries
- **Response streaming** -- Server-sent events for streaming completions

### Webhooks

- **Mapped webhook endpoints** -- HMAC-verified webhook receivers with replay protection
- **Preset mappings** -- Built-in mappings for common webhook providers

### Integration

- **Agent Client Protocol (ACP)** -- IDE integration via `@agentclientprotocol/sdk`
- **mDNS discovery** -- Bonjour/mDNS service advertising for local network discovery
- **Media routes** -- Serve generated media (images, audio) to channels

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
