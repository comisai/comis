# READINESS.md

Generated: 2026-07-02T17:02:27.886Z

## Category Verdicts

| Category | Verdict |
|----------|---------|
| A | PARTIAL |
| B | PARTIAL |
| C | PARTIAL |
| D | PARTIAL |
| E | PARTIAL |
| F | PARTIAL |
| G | PARTIAL |
| H | PARTIAL |
| I | PARTIAL |
| J | PARTIAL |
| K | PARTIAL |
| L | PARTIAL |
| M | PARTIAL |
| N | PARTIAL |
| O | PARTIAL |
| P | PARTIAL |
| Q | PARTIAL |
| R | PARTIAL |
| S | PARTIAL |
| T | SKIPPED(linux/bwrap) |
| U | PARTIAL |
| V | PARTIAL |
| Story US-01-RESEARCH-RECALL | SKIPPED(no-live) |
| Story US-02-VOICE-CONCIERGE | SKIPPED(no-live) |
| Story US-03-MULTIMODAL | SKIPPED(no-live) |
| Story US-04-MULTI-AGENT-DAG | SKIPPED(no-live) |
| Story US-05-LONG-AUTONOMOUS | SKIPPED(no-live) |
| Story US-06-SCHEDULED-PROACTIVE | SKIPPED(no-live) |
| Story US-07-TERMINAL-DRIVEN | SKIPPED(no-live) |
| Story US-08-CROSS-CHANNEL-BROADCAST | SKIPPED(no-live) |

## Reasons

| Category | Reason |
|----------|--------|
| A (Core conversation loop) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux); NOTE: the pi-event-bridge writes session-index to ~/.comis ignoring COMIS_DATA_DIR (a known packages/agent product bug) — the deterministic obs-meta + soak assert what IS deterministic and skip/document the daemon-written-index parts; no assertion weakened |
| B (LLM providers / model layer) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| C (LLM provider cache) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| D (Context engine) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| E (Long-term memory / recall) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| F (Tools subsystem) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| G (MCP) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| H (Subagents & DAG pipelines) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| I (Multi-agent & routing) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| J (Sessions & persistence) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux); NOTE: the pi-event-bridge writes session-index to ~/.comis ignoring COMIS_DATA_DIR (a known packages/agent product bug) — the deterministic obs-meta + soak assert what IS deterministic and skip/document the daemon-written-index parts; no assertion weakened |
| K (Channels) | channel surface Stage-B certified: group/forum + addressing + the four outbound fallbacks + error classification + Tier-3 platformActions + slash-commands + the forum-service negative + reconfigure/trigger deterministic green (the harness drives the real adapter/product seams); real-keyless Stage-C (full-daemon group reply, the VL A→B loop, the DAG pipeline, the injection-gauntlet residency sweep) operator-gated (COMIS_LIVE + keyless ollama). NOT a faked CERTIFIED — the keyless build is honest-by-construction (the !isLive gate) |
| L (Media — voice) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| M (Media — vision & image-gen) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| N (Search / web / docs) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| O (Security) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| P (Observability (meta)) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| Q (Config system) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| R (Scheduler) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| S (Delivery & streaming) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| T (Interactive terminal driver (Linux+bwrap)) | Linux+bwrap only; the interactive terminal driver cannot run on this macOS host (operator: a Linux+bwrap run) |
| U (Install / cold-start / packaging) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |
| V (Gateway / RPC / web) | deterministic Stage-A/B certified green; real-provider Stage-C deferred to an operator live run (pnpm test:live all with COMIS_LIVE + keys on Linux) |

> Honest sandbox reality: COMIS_LIVE is unset and no real provider keys are present, so most
> categories are PARTIAL — the deterministic Stage-A/B layers are certified green; the
> real-provider Stage-C is deferred to an operator live run. This PARTIAL-with-reason state
> is the honest sandbox outcome — NO category is faked CERTIFIED.
