# Comis Context Management: How We Cut LLM Costs by 80%+

Running AI agents in production means every token counts. A single "Hello" can cost $0.21 when your system prompt is 33K tokens. A 7-agent trading analysis pipeline can burn $2+ in minutes. Without intelligent context management, costs scale linearly with conversation length — and agents become unusable for sustained, multi-session workflows.

Comis solves this with a **7-layer context engine pipeline** that runs before every LLM call, a **cache-stable prompt architecture**, and a **three-tier budget system**. Together, these reduce per-message costs by 80%+ while maintaining full agent capability.

---

## The Problem: Context Windows Are Expensive

Every LLM call pays for every token in the context window. In a production agent system:

- **System prompts are large.** Identity, instructions, tool definitions, workspace files, and security guardrails easily reach 30-60K tokens.
- **Conversations grow fast.** Tool results (file reads, web fetches, API responses) can be 10-50K tokens each.
- **Multi-agent pipelines multiply costs.** A 7-agent stock analysis costs 7x the base rate per message.
- **Cache misses are silent killers.** Anthropic charges 7.5x more for cache writes ($3.75/MTok) than cache reads ($0.50/MTok). A single dynamic field in your system prompt can invalidate the entire cache prefix.

Without mitigation, a 30-turn agent session with tool use can easily cost $5-15 on Claude Opus.

## The Solution: 7-Layer Context Engine

Comis processes every conversation through a composable pipeline of 7 layers, each targeting a specific source of token waste:

```
Input Messages
    │
    ▼
┌─────────────────────────┐
│ 1. Thinking Cleaner     │  Strip old reasoning traces
│ 2. History Window       │  Cap conversation length
│ 3. Dead Content Evictor │  Replace superseded results
│ 4. Observation Masker   │  Mask old tool outputs
│ 5. LLM Compaction       │  Summarize when near limit
│ 6. Rehydration          │  Re-inject critical context
│ 7. Objective Reinforce  │  Preserve agent goals
└─────────────────────────┘
    │
    ▼
Optimized Context → LLM Call
```

### Layer 1: Thinking Block Cleaner

Extended thinking (chain-of-thought) generates valuable reasoning — but old thinking blocks are dead weight. This layer strips thinking traces older than N turns (default: 10), keeping recent reasoning while reclaiming tokens from stale deliberation.

### Layer 2: History Window

Caps conversation history to the last N user turns (default: 15, configurable per channel type). A group chat might keep 5 turns while a DM keeps 15. Pair-safe: never splits a tool-call/tool-result pair. Preserves compaction summaries as anchors.

### Layer 3: Dead Content Evictor

The most surgical layer. Uses forward-index analysis to detect **provably superseded** tool results — if an agent read a file at turn 5 and read the same file at turn 20, the turn-5 result is dead. Replaces it with a 50-byte placeholder instead of keeping the 15K-byte original.

Tracks 5 categories: `file_read`, `exec`, `web`, `image`, `error`. Each eviction is logged with category breakdowns for observability.

### Layer 4: Observation Masker

When total context exceeds 120K characters, masks tool results outside a keep window (default: 25 most recent). Protected tools (memory operations, file reads) are exempt. Masked entries are written back to the session file on disk, making the optimization persistent across daemon restarts.

### Layer 5: LLM Compaction

Last resort when context exceeds 85% of the model window. Compresses 50+ messages into a structured summary with 8 required sections (Identifiers, Decisions, Active Tasks, Constraints, Pending Questions, Key Data Points, Tool Failures, Next Steps). Uses a cheaper model (Haiku by default) for the compression call itself.

Three-tier fallback ensures this never fails: full summarization → exclude oversized messages → count-only note.

### Layer 6: Rehydration

After compaction, strategically re-injects only what was lost: workspace instructions (AGENTS.md critical sections), recently-accessed files, and a resume instruction for seamless continuation. Caps at 3K chars for instructions + 5 files at 8K each.

### Layer 7: Objective Reinforcement

For sub-agents, re-injects the original task objective after compaction so the agent doesn't lose its purpose mid-execution.

**Every layer has a circuit breaker** — 3 consecutive failures disables the layer until reset. No single optimization bug can bring down the pipeline.

---

## Cache-Stable Prompt Architecture

Anthropic's prompt caching can cut costs 7.5x — but only if the system prompt stays identical across turns. Most frameworks fail here because they embed timestamps, message IDs, or channel metadata in the system prompt.

Comis separates content into two zones:

| Zone | Content | Cache Behavior |
|------|---------|----------------|
| **System Prompt** (static) | Identity, personality, workspace files, tool definitions, security rules | Cached — paid once at $3.75/MTok, then $0.50/MTok on every subsequent call |
| **Dynamic Preamble** (per-turn) | Timestamp, sender metadata, channel context, RAG results, active skills, trust entries | Prepended to user message — never invalidates the cache prefix |

**Real-world impact:** On a 33K-token system prompt, the first message costs $0.206 (cache write). Every subsequent message drops to ~$0.016 for the same 33K tokens (cache read). That's **92% savings on the system prompt portion of every call.**

### What We Keep Out of the System Prompt

Six categories of content were identified and relocated (CACHE-01 through CACHE-06):

1. **Date/time** — changes every turn
2. **Inbound message metadata** — sender ID, message ID, chat type
3. **Channel context** — channel type and routing hints
4. **RAG memory results** — computed fresh per query
5. **Active skill content** — varies per message
6. **Sender trust entries** — grow as new senders appear

Each of these would invalidate the entire cache prefix if left inline.

---

## Microcompaction: Large Results Never Hit the Context

Tool results can be massive — a `bash` command outputting 50K characters, a web fetch returning an entire page. Comis intercepts these at write time:

| Tool Type | Inline Threshold | Over-Threshold Behavior |
|-----------|-----------------|------------------------|
| `file_read` | 15,000 chars | Offloaded to disk, replaced with reference |
| MCP tools | 5,000 chars | Offloaded to disk, replaced with reference |
| Default tools | 8,000 chars | Offloaded to disk, replaced with reference |
| Hard cap | 100,000 chars | Truncated before offload |

The agent sees a lightweight reference: `"[Tool result offloaded to disk: exec returned 52,341 chars. Use file_read to re-access if needed.]"` If the agent needs the full result, it can re-read it — but in most cases, the summary is sufficient.

---

## MCP Tool Deferral: Pay Only for Tools You Use

With 76 tools registered (31 from MCP servers alone), tool definitions can consume 15-20K tokens. Comis defers verbose MCP tool descriptions behind a lightweight discovery tool when total tool tokens exceed 10% of the context window. Recently-used tools stay visible; rarely-used tools become discoverable on demand.

---

## Token Budget Algebra

Every LLM call computes available history tokens using:

```
Available = Window - SystemPrompt - OutputReserve - SafetyMargin - ContextRotBuffer
```

The **context rot buffer** (25% of window) accounts for degraded attention quality in long contexts (based on Chroma 2025 research). This prevents the agent from using tokens that the model can't effectively attend to — avoiding the "lost in the middle" problem while saving money on tokens that would be wasted anyway.

---

## Three-Tier Budget Guard

Every agent has three budget caps:

| Scope | Default | Purpose |
|-------|---------|---------|
| Per-execution | 2M tokens | Prevent runaway single calls |
| Per-hour | 10M tokens | Rate limiting |
| Per-day | 100M tokens | Daily cost ceiling |

Estimated tokens are checked **before** the LLM call. If the estimate exceeds any cap, the call is rejected with a diagnostic error — not after the money is spent.

---

## Real-World Cost Profile

From a production session running a 7-agent NVDA stock analysis pipeline (March 2026):

| Operation | Cost | Notes |
|-----------|------|-------|
| First "Hello" | $0.206 | Cold cache — system prompt write |
| Second message (arxiv fetch + summary) | $0.052 | Warm cache — 75% cheaper |
| Subsequent messages | $0.02-0.05 | Stable cache reads |
| 7-agent pipeline (full NVDA analysis) | ~$1.20 | 4 analysts + 4 debate rounds + trader verdict |
| Ad-hoc MSFT price query (sub-agent) | $0.053 | Single sub-agent spawn |

**Without context management**, the same session would cost 3-5x more — old tool results accumulating in context, system prompt cache misses on every channel switch, and no compaction of growing conversation history.

---

## Multi-Provider Cache Pricing

Prompt caching costs vary by provider. Comis tracks per-provider cache costs using the pi-ai SDK's pricing catalog.

| Provider | Cache Read Rate | Cache Write Rate | Regular Input Rate | Net Savings Pattern |
|----------|----------------|------------------|--------------------|---------------------|
| Anthropic | 10% of input | 125% of input | Base rate | Turn 1: net cost (write premium); Turn 2+: net savings (read discount) |
| OpenAI | 50% of input | Same as input | Base rate | Immediate 50% savings on cached tokens; no write premium |
| Google | 25% of input | Same as input | Base rate | Immediate 75% savings on cached tokens; no write premium |

**How `savedVsUncached` works:**
- Positive value = caching saved money (read discounts exceed write premiums)
- Negative value = cache write investment exceeds read savings (typically first turn only)
- Zero = no cache activity, provider doesn't support caching, or unknown model

The formula: `(cacheReadTokens x (inputRate - cacheReadRate)) - (cacheWriteTokens x (cacheWriteRate - inputRate))`

Comis uses `resolveModelPricing()` to look up per-model rates from the pi-ai SDK catalog, so pricing is always accurate for the specific model being used.

---

## Observability: Every Token Accounted For

Every pipeline run logs structured metrics:

```json
{
  "tokensLoaded": 28959,
  "tokensEvicted": 0,
  "tokensMasked": 0,
  "tokensCompacted": 0,
  "thinkingBlocksRemoved": 7,
  "budgetUtilization": 0.22,
  "rereadCount": 0,
  "sessionDepth": 98,
  "sessionToolResults": 50,
  "layerCount": 6,
  "durationMs": 1
}
```

Budget utilization of 0.22 means only 22% of available context is used — the rest is headroom. The pipeline completed in 1ms. Seven thinking blocks were cleaned. Zero re-reads detected.

Events fire on every significant action (`context:masked`, `context:compacted`, `context:evicted`, `context:reread`), feeding into the observability dashboard for real-time cost monitoring.

---

## Summary

| Mechanism | What It Saves | When It Fires |
|-----------|--------------|---------------|
| Thinking cleaner | Old reasoning traces | Every call (layer 1) |
| History window | Old conversation turns | Every call (layer 2) |
| Dead content evictor | Superseded file reads, exec results | Every call (layer 3) |
| Observation masker | Old tool outputs beyond keep window | When context > 120K chars (layer 4) |
| LLM compaction | Entire conversation → summary | When context > 85% of window (layer 5) |
| Rehydration | Re-injects critical context post-compaction | After compaction (layer 6) |
| Cache-stable prompts | 92% savings on system prompt tokens | Every call after first |
| Microcompaction | Large tool results offloaded to disk | At write time |
| MCP tool deferral | Unused tool definitions | When tools > 10% of window |
| Budget guard | Prevents runaway calls | Pre-call estimation |

The result: production agents that run indefinitely, across thousands of turns, with predictable and controlled costs — not the exponential token growth that makes naive agent frameworks unusable at scale.
