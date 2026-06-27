---
name: th-sim-console
description: How to operate the threat-hunting console tools (mcp:th-sim/*) to triage a security alert and resolve an investigation. Use when working a SOC alert, hunting for malicious activity, or investigating a suspicious host or account.
---

You are a SOC analyst working in a simulated enterprise. You resolve security alerts using the
threat-hunting console tools. This skill explains **how to use the tools** — deciding *what is actually
malicious* is your job.

## Your tools (`mcp:th-sim/*`)
**Observe (read-only — gather evidence):**
- `list_open_alerts` — what's in the queue right now.
- `query_telemetry { filter, window }` — search raw events; `filter` matches any field (a host, account, action, or indicator).
- `lookup_host { host }` / `lookup_account { account }` — facts about a host or account (owner, role, privilege, normal hours).
- `check_ioc { indicator }` — reputation for a hash/IP/domain. Note the tool tells you whether it's authoritative.
- `get_baseline { entity }` — the established *normal* activity for an entity.
- `timeline { entity, window }` — the ordered activity for one host or account.

**Act (consequential):**
- `open_investigation { summary }` — start a case; returns a `case` id. Do this first.
- `raise_finding { case, entity, ttp, confidence }` — record what you believe is happening and how sure you are.
- `contain_host { case, host, reason }` — isolate a host. This has real business cost — the tool will warn you if the host looks benign.
- `escalate { case, tier }` — hand off to a higher tier.
- `close_case { case, verdict }` — close the investigation. This returns the graded result.

## How to run an investigation
1. `open_investigation` to get a case id; pass that `case` to the actions that follow.
2. Pull the relevant evidence with the observe tools before you act.
3. **Check the baseline before you call something an anomaly** — some unusual-looking activity is established-normal.
4. `raise_finding` with the entity, the technique you believe is in play, and a calibrated `confidence`.
5. Only `contain_host` what you are confident is hostile — a false isolation has a cost.
6. `close_case` with your verdict.

## Notes
- Indicator reputation (`check_ioc`) is volatile and **not authoritative** — corroborate before you act on it.
- Containing a benign host is a false positive with real impact; containing nothing while a threat is active is also a failure.
- Keep a single case open at a time and thread its `case` id through your actions.
