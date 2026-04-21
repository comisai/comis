# @comis/agent

AI agent executor, safety controls, budget management, and session lifecycle for the [Comis](https://github.com/comisai/comis) platform.

## What's Inside

### Executor

- **`PiExecutor`** -- Core agentic loop: receives context, runs LLM calls, processes tool results, returns `ExecutionResult`. Supports streaming, timeout guards, and error classification.

### Context Engine

Multi-layer context assembly that scales conversations without degradation:

| Layer | What it does |
|-------|--------------|
| Thinking Cleaner | Strips old reasoning traces |
| History Window | Caps to last N turns per channel |
| Dead Content Evictor | Replaces superseded file reads with placeholders |
| Observation Masker | Three-tier masking with hysteresis |
| LLM Compaction | Summarizes 50+ messages into structured sections |
| Rehydration | Re-injects workspace state post-compaction |

DAG reconciliation syncs the JSONL conversation log to a directed acyclic graph for efficient compaction and integrity checks.

### Safety

- **Circuit breakers** -- Per-provider, per-tool, and per-context-window state machines (closed -> open -> half-open) preventing failure cascading
- **Tool output sanitization** -- NFKC normalization, invisible character stripping, size limits
- **Response safety** -- Secret leak detection, content filtering, schema normalization per provider
- **Context truncation recovery** -- Detects and recovers from context overflow

### Budget

- **Three-tier budget guard** -- Per-execution, per-hour, per-day limits checked before each LLM call
- **Cost tracking** -- Per-token pricing with model-aware cost computation
- **Turn-level decisions** -- Budget tracker decides continue/stop/warn per turn

### Session Management

- **`SessionLifecycle`** -- Create, load, reset sessions with configurable reset policies (idle timeout, daily reset)
- **Scoped session keys** -- Channel + user + agent isolation
- **Write locks** -- Prevents concurrent modifications to the same session

### Model Routing

- **Auth management** -- Provider profiles, key rotation, OAuth token refresh
- **Model catalog** -- Pricing, capabilities, context window resolution
- **Vision routing** -- Image-capable model selection with fallback chains

### Sub-agent Spawning

- **`SpawnPacketBuilder`** -- Constructs sub-agent execution packets with isolated sessions, budgets, and tool policies
- **Result condensing** -- Summarizes sub-agent output for parent context
- **Spawn staggering** -- 4-second delays between concurrent sub-agents for prompt cache sharing

### Prompt Caching

- **Cache fence** -- Prevents context engine layers from modifying the cached prefix
- **Adaptive TTL** -- Escalates cache retention based on usage patterns
- **Gemini explicit caching** -- CachedContent API integration with SHA-256 hashing
- **Cache break detection** -- Two-phase attribution identifies what caused each cache invalidation

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
