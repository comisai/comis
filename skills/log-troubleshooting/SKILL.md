---
name: log-troubleshooting
description: Investigate and troubleshoot daemon logs at ~/.comis/logs/. Covers NDJSON log format, Pino level codes, field dictionary, and staged analysis strategies for efficient troubleshooting of large log files. Use this skill whenever the user asks about logs, errors, warnings, daemon issues, slow operations, debugging daemon behavior, checking what happened, or investigating any kind of platform issue -- even if they don't explicitly mention "logs".
comis:
  requires:
    bins: ["python3"]
---

# Log Troubleshooting

You have read-only access to the daemon logs directory at `~/.comis/logs/`.

This skill bundles `scripts/log-digest.py` -- a Python CLI that parses NDJSON logs and produces structured, context-friendly summaries. Use it as your primary analysis tool. It uses only Python 3 standard library (no pip install needed).

All script paths below are relative to this skill's directory. Resolve them against the `<location>` shown in the available skills listing (e.g., if the skill location is `~/.comis/skills/log-troubleshooting`, then `scripts/log-digest.py` means `~/.comis/skills/log-troubleshooting/scripts/log-digest.py`).

## Quick Start

For most troubleshooting requests, start here:

```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log
```

This produces a structured summary: entry count, time range, level distribution, top modules, every error and warning as a compact one-liner, slowest operations ranked by duration, and unique error messages with counts. Read the output and report findings to the user -- this single command answers most "what's wrong?" questions.

## Log Location and Rotation

| File | Description |
|------|-------------|
| `~/.comis/logs/daemon.log` | Active log (current session) |
| `~/.comis/logs/daemon.1.log` | Most recent rotated log |
| `~/.comis/logs/daemon.2.log` .. `daemon.5.log` | Older rotated logs |

Rotation triggers at 10MB per file, 5 rotated files kept.
Start with `daemon.log` (current) unless investigating a past incident.

## Log Format

Each line is a single JSON object (NDJSON / Pino structured logging).

**Pino level codes:**

| Code | Name | Meaning |
|------|------|---------|
| 10 | TRACE | Finest granularity, rarely enabled |
| 20 | DEBUG | Internal steps, tool calls, intermediate state |
| 30 | INFO | Boundary events: started, stopped, request complete |
| 40 | WARN | Degraded but functional |
| 50 | ERROR | Broken functionality |
| 60 | FATAL | Unrecoverable, daemon cannot continue |

**Standard fields:**

| Field | Type | When Present |
|-------|------|--------------|
| `level` | number | Always (Pino level code) |
| `time` | string | Always (ISO 8601) |
| `module` | string | Always (agent, daemon, channels, gateway, memory, skills, scheduler, sub-agent-runner, graph-coordinator) |
| `msg` | string | Always (human-readable message) |
| `agentId` | string | Agent-scoped operations |
| `traceId` | string | Request-scoped (auto-injected) |
| `durationMs` | number | Timed operations |
| `toolName` | string | Tool execution logs |
| `method` | string | RPC/HTTP method |
| `err` | object/string | Error details (Pino serialized) |
| `hint` | string | Actionable fix guidance (on WARN/ERROR) |
| `errorKind` | string | Classification: config, auth, dependency, timeout, validation, internal |
| `channelType` | string | Channel adapter logs |

## Analysis Workflow

Log files can be 10MB with 10K+ lines -- reading one raw would flood your context window and waste tokens without helping the user. The digest script solves this by parsing the JSON server-side and returning only the structured summary, so you get the full picture in a few dozen lines. Start broad with the script, then narrow with filters or grep.

### Stage 1 -- Get the overview

Run the digest script with no filters to understand the full picture:

```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log
```

The output includes:
- Total entry count and time range
- Level distribution (how many errors vs info vs debug)
- Top modules by log volume
- Every error and warning with compact one-liner format
- Slowest operations ranked by duration
- Unique error/warn messages with occurrence counts

This is enough to answer most questions. Read the output and summarize for the user.

### Stage 2 -- Drill down

Once you know what area to investigate, use the script's filters to narrow:

**By severity** -- only warnings and above:
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --level warn
```

**By module** -- isolate a subsystem:
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --module agent
```

**By time window** -- what happened in a specific period:
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --after "2026-03-20T14:00:00Z" --before "2026-03-20T15:00:00Z"
```

**By keyword** -- search the msg field:
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --search "timeout"
```

**Last N lines** -- recent activity only:
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --tail 500
```

**Slow operations** -- custom threshold:
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --slow 5000
```

Filters can be combined:
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --module agent --level warn --after "2026-03-20T14:00:00Z"
```

### Stage 3 -- Raw output for deep inspection

When you need the actual JSON entries (e.g., to examine the full `err` object or trace a specific request):

**Compact one-liners** (good for scanning):
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --level error --compact
```

**Raw JSON** (full entry data):
```
python3 scripts/log-digest.py ~/.comis/logs/daemon.log --level error --raw
```

### Stage 4 -- Targeted grep for specific patterns

For very specific lookups where you already know what you're looking for, use `grep` directly on the log file. This is faster than the script for single-pattern searches:

```
grep '"errorKind":"auth"' ~/.comis/logs/daemon.log
grep '"agentId":"my-agent"' ~/.comis/logs/daemon.log
grep '"Comis daemon started"' ~/.comis/logs/daemon.log
```

## Common Investigation Patterns

| Symptom | Command |
|---------|---------|
| General health check | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log` |
| Daemon won't start | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log --module daemon --tail 50` |
| LLM not responding | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log --search "LLM" --level warn` |
| Auth/token failures | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log --search "auth" --level warn` |
| Bad config | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log --search "config" --level warn` |
| Slow responses | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log --slow 30000` |
| Channel disconnects | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log --module channels --level warn` |
| Find restart boundaries | `grep '"Comis daemon started"' ~/.comis/logs/daemon.log` |
| Shutdown issues | `python3 scripts/log-digest.py ~/.comis/logs/daemon.log --search "shutdown" --level warn` |

## Reporting

When reporting findings to the user:

1. Lead with the summary -- how many errors, over what time range, which modules affected
2. Group repeated errors by message and show the count, not each occurrence
3. Always include the `hint` field when present -- it contains actionable fix guidance written by the developers
4. For slow operations, show the duration and what the operation was
5. If the user needs to take action, be specific about what to do based on the `hint` and `errorKind`
