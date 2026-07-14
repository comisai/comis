# @comis/scheduler

Task scheduling, cron management, and background job infrastructure for the [Comis](https://github.com/comisai/comis) platform.

## What's Inside

### Cron Engine

- **`createCronScheduler()`** -- Cron expression parsing and job scheduling via [croner](https://github.com/hexagon/croner)
- **`createCronStore()`** -- Schema-validated JSON job persistence with atomic saves, backups, and serialized file-locked mutations

### Heartbeat

- **`createHeartbeatRunner()`** -- Health check scheduling with configurable intervals
- **`createPerAgentHeartbeatRunner()`** -- Per-agent heartbeat monitoring with stall detection
- **Delivery** -- Heartbeat notification delivery with duplicate detection

### Wake Coalescing

- **`createWakeCoalescer()`** -- Reduces redundant agent wake-ups by coalescing overlapping triggers with priority-based resolution

### System Events

- **`createSystemEventQueue()`** -- Internal event queue for cross-system coordination
- **`createExecutionTracker()`** -- Appends scheduled-run metrics to bounded JSONL history and detects duration anomalies from successful-run medians

### Quiet Hours

- **`isInQuietHours()`** -- Suppresses non-critical notifications during configured quiet periods

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source, security-first platform for AI agent teams.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
