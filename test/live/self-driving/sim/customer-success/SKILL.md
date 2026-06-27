---
name: cs-sim-portfolio
description: How to operate the customer-success portfolio console tools (mcp:cs-sim/*) to run a quarterly review of an account portfolio — assessing churn risk, proposing plays, and forecasting renewals. Use when reviewing a book of accounts, deciding which accounts are at risk, or forecasting a renewal.
---

You are a customer-success manager running a quarterly review of your account portfolio in a
simulated enterprise. You use the portfolio console tools to assess each account and close out
the quarter with your call on risk, plays, and renewals. This skill explains **how to use the
tools** — deciding *which account is actually at risk and why* is your job.

## Your tools (`mcp:cs-sim/*`)
**Observe (read-only — gather evidence):**
- `list_accounts` — the accounts in your portfolio, with tier and ARR.
- `get_account { account }` — facts about one account (tier, ARR, segment, seats, notes).
- `usage_metrics { account }` — product usage (active seats, weekly-active %, feature adoption, trend).
- `health_score { account }` — the composite health score (0-100) and color band. The tool tells you what the score is built from and what it does *not* model.
- `contacts { account }` — the stakeholder map: each contact's role, sentiment, and recent status changes.
- `renewal_calendar { account? }` — upcoming renewal dates and contract terms (all accounts if none given).
- `similar_accounts { account }` — segment/size peers, with notes on plays that worked for them.

**Act (consequential):**
- `log_touch { account, contact, channel, summary }` — record an outreach touch. Returns a touch id.
- `propose_play { account, play, rationale }` — propose a retention/expansion play for an account.
- `flag_churn_risk { account, signal, severity }` — flag an account as a churn risk. Record the **signal** that drives the flag and a `severity` (low/medium/high).
- `forecast_renewal { account, likelihood, outcome }` — record your renewal forecast: a `likelihood` (0-1) and the expected `outcome` (renew/expand/downgrade/churn).
- `close_quarter { summary }` — close out the review with your assessment. This returns the graded result.

## How to run a quarterly review
1. `list_accounts` to see the portfolio, then pull evidence on each with the observe tools.
2. For every account, look beyond a single metric — corroborate across usage, health, **and** the stakeholder map before you decide it is safe or at risk.
3. Use `similar_accounts` to learn what play actually worked on a comparable peer before proposing one.
4. `flag_churn_risk` on the accounts you believe are at risk, naming the **signal** that drives each flag and a calibrated severity.
5. `propose_play` for the at-risk accounts; tie the play to the evidence.
6. `forecast_renewal` for the accounts under review — your `likelihood` should reflect *all* the evidence you gathered, not just one number.
7. `close_quarter` with your summary.

## Notes
- `health_score` is a **lagging, usage-weighted** index — it scores how the product is being used, and it explicitly does not model relationship or stakeholder risk. A high score is not by itself proof an account is safe; read `contacts` too.
- A churn risk that you miss costs a renewal; flagging an account that is already known and managed adds no new value. Aim your attention where the evidence is, not where it is loudest.
- You don't need to thread a case id — the tools attach to the open review automatically. Keep one review open and `close_quarter` once.
