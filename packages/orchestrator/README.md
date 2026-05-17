# @comis/orchestrator

Inbound message orchestration, execution coordination, and cross-session messaging for the [Comis](https://github.com/comisai/comis) platform. Extracted from `@comis/agent` and `@comis/channels` in the v2.0 architecture redesign so that channels remain transport-only and agent remains executor-only.

## What's Inside

### Inbound Pipeline

- **`inbound-pipeline`** -- The end-to-end inbound message journey: route → resolve → gate → preprocess → setup → handoff to execution.
- **`inbound-route`** -- Multi-agent message routing (config-driven binding resolution).
- **`inbound-resolve`** -- Resolves the active session, agent profile, and execution context for an inbound message.
- **`inbound-gate`** -- Safety + policy gates applied before execution (rate limits, allow/deny lists, channel-scope checks).
- **`inbound-preprocess`** -- Normalization of inbound payloads (`NormalizedMessage` shape).
- **`inbound-setup`** -- Wires per-request execution context (traceId, contentDelimiter, requestId).

### Execution Coordination

- **`execution-pipeline`** -- The execution side of the orchestrator: gate-check → execute → filter → deliver → policy.
- **`execution-execute`** -- Hands the prepared inbound packet to the agent's `PiExecutor`.
- **`execution-filter`** -- Output filtering applied to the executor's `ExecutionResult` (length caps, safety filters).
- **`execution-deliver`** -- Routes the filtered output back to the channel for outbound delivery.
- **`execution-policy`** -- Per-channel / per-agent execution-policy overrides.

### Channel Manager

- **`createChannelManager()`** -- Lifecycle factory for the inbound/execution loop. Owns the channel adapter set, the per-channel state, and the `processInboundMessage` callback wiring.
- **`createOrchestrator()`** -- Canonical-name alias of `createChannelManager`.
- See `AUDIT.md` for the 51-field `ChannelManagerDeps` shape and audit-coverage gate.

### Commands

- **`parseSlashCommand`** -- Tokenizes a slash command into a structured AST.
- **`createCommandHandler`** -- Per-session command-dispatch state machine.
- **`matchPromptSkillCommand`** / **`detectSkillCollisions`** -- Resolves prompt-skill invocations from user input.
- **`parseUserTokenBudget`** + `MIN_USER_BUDGET` / `MAX_USER_BUDGET` -- Budget-command parser + validation bounds.

### Routing

- **`createMessageRouter`** -- Config-driven multi-agent dispatch (which agent handles which channel/binding).
- **`resolveAgent`** -- Pure helper that resolves the active agent for a routable message.

### Queue

Per-session command serialization keeps inbound flow ordered + bounded:

- **`createCommandQueue`** -- Per-session command lane.
- **`createDebounceBuffer`** -- Coalesces near-simultaneous messages into a single execution.
- **`createFollowupTrigger`** -- Schedules follow-up turns after pauses.
- **`createPriorityScheduler`** -- Priority + fairness scheduling across active sessions.
- **`applyOverflowPolicy`** / **`coalesceMessages`** -- Backpressure + coalescer utilities.

### Session Key Builder

- **`buildScopedSessionKey`** -- Builds DM-scoped session keys (none / per-peer / per-channel-peer / agent-prefix / thread-isolation).
- **`extractThreadId`** -- Pulls the thread identifier from a scoped key.

### Cross-Session Messaging

- **`createCrossSessionSender`** -- Agent-to-agent fire-and-forget / wait / ping-pong messaging.
- **`createAnnouncementBatcher`** -- Coalesces near-simultaneous sub-agent completion notifications.
- **`createAnnouncementDeadLetter`** -- Persists failed announcement deliveries for later retry.

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
