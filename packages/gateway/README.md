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

### OpenAI-shaped API

- **Experimental endpoints** -- `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, and `/v1/responses` use OpenAI-shaped or OpenResponses request and response formats; this is not a general client-compatibility guarantee
- **Response streaming** -- Server-sent events for streaming completions

### Webhooks

- **Mapped webhook endpoints** -- HMAC-verified webhook receivers with replay protection
- **Preset mappings** -- Built-in mappings for common webhook providers

### Integration

- **Agent Client Protocol (ACP)** -- IDE integration via `@agentclientprotocol/sdk`
- **mDNS discovery** -- Bonjour/mDNS service advertising for local network discovery
- **Media routes** -- Serve generated media (images, audio) to channels

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source runtime built for AI agents you leave running.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
