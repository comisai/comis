# @comis/memory

SQLite-backed storage layer for the [Comis](https://github.com/comisai/comis) platform. Provides persistent memory, vector search, full-text search, embeddings, secret storage, and delivery queues.

## What's Inside

### Core Storage

- **`SqliteMemoryAdapter`** -- `MemoryPort` implementation with trust-partitioned storage (system/learned/external), FTS5 full-text search, and vector similarity search via `sqlite-vec`
- **`createSessionStore()`** -- Per-agent session state persistence
- **`createContextStore()`** -- DAG-based conversation context storage for the context engine

### Embedding Stack

- **`createEmbeddingProvider()`** -- Auto-selecting factory (OpenAI remote or local GGUF via `node-llama-cpp`)
- **`createCachedEmbeddingPort()`** -- Two-tier caching: LRU in-memory (L1) + SQLite persistent (L2)
- **`createEmbeddingQueue()`** -- Async background embedding with `p-queue`
- **`createBatchIndexer()`** -- Bulk re-indexing when embedding providers change
- **`createFingerprintManager()`** -- Detects provider changes that invalidate cached embeddings

### Secret Store

- **`createSqliteSecretStore()`** -- AES-256-GCM encrypted credential storage implementing `SecretStorePort`

### Delivery

- **`createSqliteDeliveryQueue()`** -- SQLite-backed message delivery queue
- **`createSqliteDeliveryMirror()`** -- Deduplication and delivery mirroring

### Observability

- **`createObservabilityStore()`** -- Token usage tracking, delivery metrics, and diagnostics persistence

## Key Dependencies

- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) -- Synchronous SQLite with native bindings
- [sqlite-vec](https://github.com/asg017/sqlite-vec) -- Vector search extension
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) -- Local GGUF embeddings (optional)
- [openai](https://github.com/openai/openai-node) -- Remote embeddings

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
