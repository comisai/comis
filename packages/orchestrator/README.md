# @comis/orchestrator

Inbound message orchestration, execution coordination, and cross-session messaging for the [Comis](https://github.com/comisai/comis) platform. Channels remain transport adapters while the agent package owns execution.

## What's Inside

### Inbound Pipeline

- **`inbound-pipeline`** -- Coordinates sender filtering → duplicate observation → agent/session resolution and media preprocessing → message gate → setup and execution routing.
- **`resolve-and-preprocess`** -- Resolves the agent and executor, builds the scoped session key, loads the session, and runs audio/media preprocessing.
- **`inbound-gate`** -- Applies auto-reply activation, routes verified button callbacks, handles slash commands and reset triggers, and returns process/handled/skip decisions.
- **`setup-and-route`** -- Resolves streaming and typing behavior, then routes through steer/follow-up, the per-session queue, or direct execution.
- **`dedup-detector`** -- Detects repeated message IDs and emits diagnostics; duplicate messages continue through the pipeline.

### Execution Coordination

- **`execution-pipeline`** -- Coordinates tool assembly → send policy and trust routing → agent execution → response filtering → delivery → turn finalization.
- **`execution-execute`** -- Runs the agent executor with request context, timeout handling, streamed-delta collection, typing refresh, and abort cleanup.
- **`execution-filter`** -- Sanitizes model output, suppresses control responses, handles outbound media and voice, and applies response prefixes.
- **`execution-deliver`** -- Chunks, coalesces, paces, retries, and delivers filtered output while returning a delivery receipt.
- **`activity-turn-coordinator`** -- Projects tool and execution activity to supported channels with kill-switch and circuit-breaker controls.

### Channel Manager

- **`createChannelManager()` / `createOrchestrator()`** -- Exported names for the lifecycle factory that owns channel state and inbound/execution callback wiring.

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
- **`applyOverflowPolicy`** / **`coalesceMessages`** -- Backpressure + coalescer utilities.

### Session Key Builder

- **`buildScopedSessionKey`** -- Builds session keys using `main`, `per-peer`, `per-channel-peer`, or `per-account-channel-peer` DM scope, with optional thread isolation.
- **`extractThreadId`** -- Reads supported thread metadata from a `NormalizedMessage`.

### Cross-Session Messaging

- **`createCrossSessionSender`** -- Agent-to-agent fire-and-forget / wait / ping-pong messaging.
- **`createAnnouncementBatcher`** -- Coalesces near-simultaneous sub-agent completion notifications.
- **`createAnnouncementDeadLetter`** -- Persists failed announcement deliveries for later retry.

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source runtime built for AI agents you leave running.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
