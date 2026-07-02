# TARGET (worked example) — autonomous multi-signal trading system (real yfinance MCP + Tavily + Comis memory/learning)

> A **real-data deployment** target (NOT a `sim/` seeded-world learning workload — those hide the strategy so
> the reflection engine learns it; this ships an explicit strategy and stands up a live autonomous system on
> real market data). Drive it with **`scripts/setup-trading-system.sh`** (one command on the emulator rig), or
> paste the §Setup-prompt into any Comis chat (Telegram/etc.) to stand it up on any instance.
>
> Live-verified end-to-end 2026-07-01→02 (run: autonomous-trading UC, HEAD `28573f67`+OE-6b, anthropic/claude-opus-4-8):
> MCP installed from npm → 20 tools → inherited by graph sub-agents (governed) · 4-signal analysis grounded on
> real data · learn-from-outcome loop persisted in memory · autonomous cron fired unattended (`0 21 * * 1-5`),
> traded, updated the ledger, and delivered its report. See §Ground-truth oracles + the FINDINGS-LEDGER note.

## Scenario
An operator asks the agent to stand up an **autonomous paper-trading system**: it manages a $100k paper
portfolio over a small watchlist, decides with a **multi-signal** method (technical + fundamental + analyst
recs via the **yfinance MCP**, news+sentiment via **Tavily `web_search`**), persists its state + theses +
lessons in **Comis memory**, runs **unattended on a cron** at each US market close, and uses the
**learn-from-outcome loop** (recall → mark-to-market → self-grade → record lesson → adjust) to improve its
*process* over time. Paper only — never real orders.

## Capabilities exercised → requirements
- **MCP lifecycle** — install a published MCP from npm (`yfinance-mcp-ts`, stdio, keyless), connect, 20 tools.
- **child⊆parent governance** — the MCP data tools flow into graph/sub-agent tool sets; `mcp_manage` stays denied to sub-agents.
- **multi-signal grounding** — technical (`get_stock_history`), fundamental (`get_financials`/`get_key_stats`/`get_earnings`), recs (`get_recommendations`), news/sentiment (Tavily `web_search`).
- **memory** — durable strategy + per-trade theses + lessons; recalled next cycle.
- **verified learning / reflection** — outcome_events accrue; the reflection cron synthesizes trading lessons once corroborated across cycles.
- **scheduling / autonomy** — a `trading-cycle` cron fires the cycle unattended; delivers a report to the channel.
- **honesty** — paper-only; short-horizon P&L reported as noise, not skill; grounded in real tool data, never fabricated.

## Prerequisites on the TARGET Comis instance (verify before driving)
1. **Admin/operator-trust sender** — installing an MCP + creating crons are operator actions. The sender must resolve to **admin** (`agents.<id>.elevatedReply.senderTrustMap: {"<id>":admin}` + in `allowFrom`). A non-admin sender is denied at the origin gate.
2. **Node ≥ 20 + network egress** — the daemon spawns `npx yfinance-mcp-ts` (fetches from npm; yfinance calls Yahoo). No API key for yfinance.
3. **`TAVILY_API_KEY`** — for the news/sentiment leg (`web_search`). Absent → the agent degrades honestly (news = neutral); the other three legs still work fully.
4. **A capable LLM tier** — a frontier model handles the 4-signal synthesis + tool orchestration reliably; small/local tiers may struggle.
5. **Autonomy budget** — raise `agents.<id>.autonomy.budget.{aggregateUsd,tokens,wallClockMs}` so a heavy multi-ticker cycle (20–50 tool calls) isn't cut short.

## §Setup-prompt (send as ONE chat message; `setup-trading-system.sh` sends this verbatim)
```
Set up a complete AUTONOMOUS multi-signal PAPER-trading system on this Comis instance. Do all four steps below, then confirm each. This is a paper simulation — never place real-money orders or move real funds.

STEP 1 — INSTALL MARKET-DATA TOOLS (MCP). Connect the yfinance MCP server for real market data. It's published to npm as "yfinance-mcp-ts", runs over stdio, needs NO API key. Use your MCP management tool to register it with command "npx" and args ["yfinance-mcp-ts"], name it "yfinance", connect it, and confirm it's connected and how many tools it exposes (~20: get_stock_price, get_stock_history, get_financials, get_key_stats, get_earnings, get_recommendations, get_stock_summary, search_stocks, get_market_summary, etc.). For news/sentiment you'll use your web_search tool — if web_search isn't available, say so and treat news as neutral.

STEP 2 — CREATE THE PORTFOLIO LEDGER. Write a file trading/portfolio.json in your workspace with: starting_cash 100000, cash 100000, currency "USD", positions {}, trade_log [], cycle 0, watchlist ["NVDA","AMD","MSFT","GOOGL","TSLA"]. Tell me the absolute path.

STEP 3 — STORE THE STRATEGY IN MEMORY (durable). Store this multi-signal strategy: for each watchlist ticker, combine (a) TECHNICAL — price vs 50/200-day moving averages + recent momentum (yfinance get_stock_history); (b) FUNDAMENTAL — valuation P/E & PEG, margins, free cash flow, revenue growth, earnings (yfinance get_financials / get_key_stats / get_earnings); (c) ANALYST RECOMMENDATIONS (yfinance get_recommendations); (d) NEWS + SENTIMENT (web_search for recent catalysts — weight LOW unless a concrete, sourced catalyst). Rules: size positions by conviction and risk; always keep a ~20% cash buffer; and — key discipline — do NOT trade unless there is a genuine signal change (a price crossing a moving average, an analyst revision, an earnings result, or a real news catalyst) AND meaningful market time has passed. Never churn on noise.

STEP 4 — SCHEDULE THE AUTONOMOUS CYCLE (cron). Create a recurring cron job named "trading-cycle" on schedule "0 21 * * 1-5" (UTC — weekdays at US market close). Its scheduled prompt must tell you to run the next trading cycle: (1) read trading/portfolio.json; (2) recall from memory your open trade theses, the strategy, and prior lessons; (3) mark every open position to market with fresh yfinance prices and compute unrealized + total portfolio value vs the 100000 start; (4) self-grade each thesis (playing out / too early / invalidated) and record an OUTCOME and a concise LESSON LEARNED to memory; (5) re-run the full 4-signal analysis and ADJUST only on genuine signal changes — trim/exit invalidated names, add to strengthening ones, deploy the cash buffer only for a new high-conviction signal — keeping the ~20% buffer; (6) update trading/portfolio.json (positions with entry_price/shares/cost and unrealized_pnl, realized_pnl, total_value, increment cycle, append to trade_log); (7) message me here with total value + P&L, per-position P&L, any trades made, and the top lesson learned. Confirm the cron is registered and tell me its job id and next run time.

GUARDRAILS: Paper simulation only — no real orders, ever. Ground every decision in the actual tool data — never fabricate numbers. Be honest: over short horizons P&L is noise, not skill — say so rather than claiming performance.

After all four steps, do NOT run a trading cycle yet — just confirm each step is done.
```

## §Bootstrap-prompt (optional — send after setup confirms, to build the initial book now)
```
Run TRADING CYCLE 1 now to build the initial portfolio: for each watchlist ticker gather all four signals (technical, fundamental, analyst recs via yfinance; news/sentiment via web_search), combine into a per-ticker conviction, make your initial BUY decisions with position sizing, keep the ~20% cash buffer, record entry prices and a one-line thesis per position to memory, update trading/portfolio.json (cycle 1), and report the portfolio with your thesis per name.
```

## Ground-truth oracles (verify in ground truth, NEVER the chat reply — `setup-trading-system.sh` checks these)
| id | predicate | oracle |
|---|---|---|
| MCP-1 | yfinance connected, ~20 tools | `mcp.list` → `{name:yfinance, status:connected, toolCount:20}` |
| LEDGER-1 | ledger created, cash 100000, cycle 0 | `trading/portfolio.json` on disk in the workspace |
| STRAT-1 | strategy persisted | `memory.db` `memories` row "TRADING STRATEGY (autonomous multi-signal…)" |
| CRON-1 | autonomous cron registered + scheduled | `cron.list` → `{name:trading-cycle, expr:"0 21 * * 1-5", enabled:true, nextRunAtMs:set}` |
| GROUND-1 (per cycle) | decisions grounded across ALL 4 techniques | trajectory/log tool calls: `get_stock_history` + `get_financials`/`get_key_stats`/`get_earnings` + `get_recommendations` + `web_search` |
| GOV-1 (per cycle) | MCP data tools inherited by sub-agents; `mcp_manage` NOT | `Sub-agent tool inheritance applied` (child⊆parent); 0 `mcp_manage` in sub-agent window |
| LEARN-1 (cycle ≥2) | recall prior theses → mark-to-market → record lesson | trajectory recall + `memories` LESSON rows + `outcome_events` |
| AUTON-1 | cron FIRED unattended + traded + delivered | `cron.runs jobName "trading-cycle"` (`status:ok`) + ledger cycle advanced + emulator recorded outbound (the report) |

## Known traps / honest limits (from the live run)
- **Profitability is NOT session-verifiable** — markets don't move in minutes; report mark-to-market P&L honestly as noise. Real-horizon profitability needs the cron running for weeks (a coverage-gap by nature).
- **Recording a lesson ≠ applying it** — over 2–3 cycles the discipline lesson may not be honored; the trusted-skill layer (corroborated over many cycles) is what enforces it. Reflection admits 0 until observations corroborate (`admissionOutcome:"uncorroborated"` — correct, not a bug).
- **Autonomous cron deliveries are NOT in `delivery_mirror`** (`DELIVERY-MIRROR-CRON-BLIND`, FINDINGS-LEDGER) — audit autonomous runs via `cron.runs` / the cron trajectory (`delivery.dispatched`) / the chat, not `delivery_mirror`.
- **The agent's self-written ledger timestamp can be wrong** (no reliable clock) — trust the scheduler's `lastRunAtMs`, not the ledger's `last_update`.
- **rootRunId / cron session** — a cron cycle runs under `<agent>:<chatId>:cron:<jobId>`, distinct from the interactive peer session.

## Optional — install as an agent-facing SKILL on the target
To make the agent skill-driven (say "run a trading cycle" and it follows the mechanics), install a skill whose
body is the §Setup-prompt STEP-3 strategy + the STEP-4 cycle steps (7-step loop) as the "how", keeping the
guardrails. (This is a DEPLOYMENT/operational skill — unlike `sim/*/SKILL.md`, the strategy is intentionally
explicit; there is no hidden truth for the reflection engine to discover here.)
