---
name: mm-sim-desk
description: How to operate the algorithmic market-making desk tools (mcp:mm-sim/*) to run a trading book through an episode and settle it for a graded result. Use when making markets, quoting two-sided prices, managing trading inventory, or running a market-making session.
---

You are running an algorithmic market-making desk in a simulated market. You quote two-sided
prices, take fills, manage your net inventory, and finally settle the session for a graded
result. This skill explains **how to use the tools** — *how to actually trade well* is your job.

## Your tools (`mcp:mm-sim/*`)

**Observe (read-only — read the market and your book):**
- `get_quote` — current mid/bid/ask for the symbol and the current episode `step`.
- `get_orderbook { levels }` — order-book depth (bid/ask sizes) around the mid.
- `get_position` — your net inventory, the **stated max inventory limit**, and your live quote.
- `get_pnl` — running PnL plus a **risk-adjusted** figure (PnL penalized for inventory risk).
- `regime_signals` — microstructure diagnostics for the latest window: return autocorrelation,
  realized volatility (and its trend), and order-flow imbalance. These describe *behavior*; they
  do **not** name a regime.
- `get_fills` — the fills you have received so far (each fill moves your inventory).
- `volatility` — the realized-volatility series so far (one value per elapsed step).

**Act (consequential):**
- `set_strategy { mode }` — set your active strategy (a free-text `mode`). Recorded with the step.
- `post_quote { bid, ask, size }` — post a two-sided quote. **Advances the market one step**; you
  may receive a fill that changes your inventory.
- `cancel_quote` — stand aside. **Advances one step** with no new fill for you.
- `hedge { qty }` — trade `qty` units (signed) at the current mid to reduce net inventory; a small
  slippage cost applies. Does **not** advance the market.
- `settle` — close the session and book the result. This returns the **graded outcome**.

## How to run a session
1. Read the market first — `get_quote`, `regime_signals`, `volatility` — and your book with
   `get_position` / `get_pnl`.
2. Choose and `set_strategy`, then work the book with `post_quote` (and `cancel_quote` to pause).
   Each of those advances the episode one step; the episode has a fixed number of steps
   (`get_quote` reports `step` / `totalSteps`).
3. Keep re-reading `regime_signals` as the episode progresses — the market's behavior is **not
   guaranteed to stay the same for the whole episode**.
4. Use `hedge` to keep your net inventory inside the stated limit (`get_position.maxInventory`).
5. `settle` when you're done to get the graded result.

## Notes
- The grade reflects how well your trading matched the market and how well you controlled risk —
  both your inventory at settle and a risk-adjusted PnL figure matter.
- Carrying a large net inventory is penalized; staying near the limit (or over it) hurts the
  risk-adjusted figure even before settle.
- Re-read the observe tools as you go — a decision that was right early in the episode is not
  necessarily right later.
