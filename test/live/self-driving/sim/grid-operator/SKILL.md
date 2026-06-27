---
name: grid-sim-operator
description: How to operate the balancing-authority operator console (mcp:grid-sim/*) to keep a control area's generation and load in balance across a dispatch interval. Use when running a power grid control area, balancing generation against load, managing reserves, or settling a dispatch interval.
---

You are the operator on shift for a balancing authority (control area). Your job is to keep
generation and load in balance so system frequency stays inside its operating limits, then
settle the dispatch interval. This skill explains **how to use the console tools** — *what to do
with what you observe* (how much reserve, when, which strategy) is your call as the operator.

## Your tools (`mcp:grid-sim/*`)

**Observe (read-only — assess the area):**
- `get_load` — the current served load (MW) and its near-term trend.
- `get_generation` — current output by asset (MW online, type, and remaining headroom), plus the online total.
- `forecast { horizon }` — the short-horizon forecast for load and per-type generation (including renewables) over the next intervals.
- `get_reserves` — reserve capacity: how much is available to commit, how much is already committed, and how long each reserve takes to come online.
- `asset_status { asset }` — per-asset health/derate flags and any condition warnings the units are reporting. Omit `asset` for all units.
- `frequency` — the current system frequency (Hz), nominal, and the operating limits you must stay within.

**Act (consequential):**
- `commit_reserve { mw, resource }` — make reserve capacity available to the area. Committing has a standby cost; no energy is delivered until it is allowed to respond.
- `set_dispatch_strategy { strategy }` — choose how the area balances at settlement: `static` (hold the current dispatch) or `follow` (let committed reserve respond to the imbalance).
- `dispatch { asset, deltaMw }` — change an asset's output set-point (positive ramps up, negative ramps down). Bounded by that asset's headroom.
- `shed_load { mw }` — curtail firm customer load to relieve a shortfall. High penalty — a last resort.
- `settle_interval { note }` — advance and settle the interval. The system resolves load against generation and reserves and returns the **graded** outcome.

## How to run an interval
1. Read the area first: `get_load`, `get_generation`, `frequency`, and `get_reserves` to see where you stand.
2. Look ahead and at unit health: `forecast` and `asset_status` tell you what is coming and which units to trust.
3. Position the area with the act tools (`commit_reserve`, `set_dispatch_strategy`, `dispatch`) **before** you settle.
4. `settle_interval` once to resolve the interval. This is terminal and returns the grade — call it last.

## Notes
- The grade rewards keeping **frequency and balance within limits** through the interval **at reasonable cost**, and treats shedding firm load as an inferior outcome.
- Committing reserve and choosing a strategy are separate steps — committed capacity does nothing unless the strategy lets it respond.
- Reserves take time to come online (`get_reserves` reports it); a set-point change is bounded by the asset's headroom.
- You settle the interval **once** — make sure the area is positioned the way you want before you call `settle_interval`.
