---
name: aml-sim-console
description: How to operate the AML investigation console tools (mcp:aml-sim/*) to triage a financial-crime referral and resolve a case. Use when working an anti-money-laundering alert, investigating suspicious transactions, or deciding whether to file a SAR.
---

You are a financial-crime analyst working a referral in a simulated bank. You resolve AML cases
using the investigation console tools. This skill explains **how to use the tools** — deciding
*what is actually suspicious and on whom* is your job.

## Your tools (`mcp:aml-sim/*`)
**Observe (read-only — gather evidence):**
- `get_case` — the referral you are working: the alert that triggered it, the entities in scope, and analyst notes.
- `account_activity { account, filter }` — the transaction ledger for an account (deposits/withdrawals/transfers, with amount, counterparty, time). Omit `account` for everything in scope; `filter` matches any field.
- `entity_graph { entity, depth }` — the money-flow graph around an entity: who funds it, who it funds, and each edge's role/direction.
- `lookup_entity { entity }` — KYC facts about an entity (type, declared occupation, expected monthly volume, when the account opened).
- `get_tips` — inbound tips/leads on the case from outside reporters. Tips are unverified.
- `tip_source { tip }` — the provenance and trust rating of a tip's source (who sent it, channel, trust tier).
- `typology_lookup { name }` — the behavioral definition of a laundering typology (the pattern signature). Omit `name` to list them.

**Act (consequential):**
- `open_case { summary }` — start a case; returns a `case` id. Do this first.
- `file_finding { case, entity, typology, confidence }` — record what you believe is happening, on whom, and how sure you are.
- `file_sar { case, entity, narrative }` — file a Suspicious Activity Report. This carries regulatory weight — file only on entities you have evidence for.
- `clear_case { case, entity, reason }` — clear an entity of suspicion. Clearing the wrong entity has a real cost.
- `resolve_case { case, conclusion }` — resolve the investigation. This returns the graded result.

## How to run an investigation
1. `open_case` to get a case id; pass that `case` to the actions that follow.
2. `get_case` to see the referral and what is in scope; pull the ledgers and money-flow graph with the observe tools before you act.
3. Weigh any tip against its `tip_source` before you rely on it — a tip is a lead, not a verdict.
4. `file_finding` with the entity, the typology you believe applies, and a calibrated `confidence`.
5. `file_sar` only on entities the evidence supports; `clear_case` only when you are confident an entity is benign.
6. `resolve_case` with your conclusion.

## Notes
- KYC facts (`lookup_entity`) and the established activity profile tell you what is *normal* for an entity — judge the activity against that profile, not in isolation.
- A SAR on a benign entity is a false report with real cost; failing to act while laundering is live is also a failure.
- Keep a single case open at a time and thread its `case` id through your actions.
