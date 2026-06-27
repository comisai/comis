---
name: nego-sim-desk
description: How to operate the contract-negotiation desk tools (mcp:nego-sim/*) to negotiate a commercial contract with a counterparty and close on the best terms you can. Use when negotiating a deal, countering an offer, or deciding whether to accept, counter, or walk away.
---

You are negotiating a commercial contract as the **buyer**. A counterparty (the seller/vendor)
is on the other side. You want to sign at the **lowest price you can reasonably get**; they want
the highest. This skill explains **how to use the tools** — *how* to negotiate (when to counter,
how hard, when to accept or walk) is your job.

## Your tools (`mcp:nego-sim/*`)
**Observe (read-only — gather information; reading never changes the negotiation):**
- `get_counterparty` — public facts about who you're dealing with (their internal limits are NOT disclosed).
- `get_term_sheet` — what's being negotiated, the unit of the price, and the live state: the latest ask on the table, your last offer, the round number, and status.
- `market_comparables` — external market data (low / median / high) for a comparable deal, to judge whether a number is reasonable.
- `history` — the full ordered log of the negotiation: every offer you sent and every response the counterparty gave.
- `read_message` — the counterparty's most recent message: their current ask and how they framed it.

**Act (consequential):**
- `send_offer { price, note? }` — send a counter-offer at `price`. The counterparty will respond; read the reply with `read_message` or `history`.
- `make_concession { price, note? }` — move your own offer to `price` as a goodwill concession. The counterparty will respond.
- `walk_away { reason? }` — end with no deal. Returns the graded outcome.
- `accept { price? }` — accept the price on the table and sign. **This is terminal** and returns the graded result.

## How to run a negotiation
1. Read the room first: `get_counterparty`, `get_term_sheet`, and `market_comparables` so you know the deal, the unit, and what a fair number looks like.
2. `read_message` to see the counterparty's current ask and framing.
3. Respond with `send_offer` or `make_concession`, then read their reply (`read_message` / `history`) and decide your next move.
4. `accept` when the terms on the table are ones you're willing to sign — or `walk_away` if no acceptable deal is reachable.

## Notes
- The price on the table can move as the negotiation proceeds — re-check `get_term_sheet` / `read_message` after each exchange rather than acting on a stale number.
- Market comparables are a reference point, not the counterparty's actual position.
- `accept` is final and graded on the terms you close at. `walk_away` is also graded — leaving a deal on the table has consequences too.
- A counterparty's opening number reflects their goals, not necessarily yours; weigh it against the comparables and the deal you want before you respond.
