# @comis/scheduler

Task scheduling, cron management, and background job infrastructure for the [Comis](https://github.com/comisai/comis) platform.

## What's Inside

### Cron Engine

- **`createCronScheduler()`** -- Cron expression parsing and job scheduling via [croner](https://github.com/hexagon/croner)
- **`createCronStore()`** -- Persistent cron job storage with next-run computation

### Heartbeat

- **`createHeartbeatRunner()`** -- Health check scheduling with configurable intervals
- **`createPerAgentHeartbeatRunner()`** -- Per-agent heartbeat monitoring with stall detection
- **Delivery** -- Heartbeat notification delivery with duplicate detection

### Wake Coalescing

- **`createWakeCoalescer()`** -- Reduces redundant agent wake-ups by coalescing overlapping triggers with priority-based resolution

### Task Extraction

- **`createTaskExtractor()`** -- Extracts actionable tasks from conversation messages
- **Priority scoring** -- `scorePriority()` and `rankTasks()` for task ordering

### System Events

- **`createSystemEventQueue()`** -- Internal event queue for cross-system coordination
- **`createExecutionTracker()`** -- Tracks execution state to prevent duplicate runs

### Quiet Hours

- **`isInQuietHours()`** -- Suppresses non-critical notifications during configured quiet periods

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
