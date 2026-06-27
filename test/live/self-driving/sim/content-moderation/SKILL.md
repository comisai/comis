---
name: mod-sim-console
description: How to operate the content-moderation console tools (mcp:mod-sim/*) to work a trust & safety queue and resolve each item. Use when moderating reported content, reviewing a report queue, or deciding whether an item violates policy.
---

You are a trust & safety reviewer working a simulated moderation queue. You resolve each
reported item using the moderation console tools. This skill explains **how to use the
tools** — deciding *what actually violates policy* is your job.

## Your tools (`mcp:mod-sim/*`)
**Observe (read-only — gather evidence):**
- `get_queue` — the items awaiting review and how many reports each has. Report count is volume, not a verdict.
- `get_item { id }` — the full content and metadata (author, text, context) for one item.
- `get_reports { id }` — the individual reports against an item: who filed each, the reason, and the report source.
- `reporter_history { reporter }` — a reporter's reliability record (account age, prior reports, confirmed/dismissed rate, links to other accounts).
- `policy_lookup { query }` — look up the community-policy rules by key or keyword.
- `similar_items { id }` — prior moderated items resembling this one, with how they were resolved.

**Act (consequential):**
- `open_review { summary }` — start a review; returns a `review` id. Do this first.
- `decide { review, id, verdict, rationale }` — record a per-item decision: `keep` or `remove`. Decide each queue item.
- `escalate { review, id, reason }` — hand an item to a senior reviewer if you can't decide.
- `action_account { review, account, action }` — `warn` or `suspend` an account. This has real cost if the account is a legitimate user — the tool will warn you.
- `label { review, id, label }` — attach a non-removal label to an item for the record.
- `submit_verdict { review, note }` — submit the review for grading. This returns the graded result over all your per-item decisions.

## How to run a review
1. `open_review` to get a `review` id; pass that `review` to the actions that follow.
2. `get_queue`, then for each item pull its content (`get_item`), its reports (`get_reports`), and the relevant policy (`policy_lookup`) before you decide.
3. `decide` a `keep`/`remove` verdict for **every** item in the queue, with a `rationale`.
4. Use `reporter_history` and `similar_items` to inform your decisions; `label` or `escalate` as appropriate.
5. Only `action_account` when you are confident the account is behind a genuine violation — a wrong action has real cost.
6. `submit_verdict` once you've decided every item. This is graded.

## Notes
- A report is a **signal**, not a verdict — read the content and the policy yourself before deciding.
- `reporter_history` tells you how reliable a reporter is and whether they're linked to other accounts; weigh reports accordingly rather than just counting them.
- Policy is judged by behavior and target — `policy_lookup` describes what counts, and `similar_items` shows how comparable cases resolved.
- Decide every queue item before you `submit_verdict`; a missing decision counts against the review.
- Keep a single review open and thread its `review` id through your actions.
