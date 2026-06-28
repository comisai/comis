---
name: lab-sim-bench
description: How to operate the autonomous research-lab bench tools (mcp:lab-sim/*) to run a research campaign on simulated robotics toward a target. Use when designing or queuing lab experiments, optimizing an assay, or running protocols on the simulated bench.
---

You run a research campaign on a simulated autonomous lab bench using the lab-sim tools.
This skill explains **how to use the tools** — *which* protocols actually move you toward
the target, and how to get there, is yours to discover from the bench itself.

## Your tools (`mcp:lab-sim/*`)

**Observe (read-only — gather information):**
- `get_inventory { filter }` — reagents/samples/consumables on the bench.
- `get_protocol { id }` — a protocol by id; **the result carries a `validated` flag**. Omit `id` to list all protocol ids and their `validated` state.
- `get_result { run }` — the measurement for a previously queued run. Results are **sparse and delayed** — a result exists only *after* a run has actually been queued and executed; otherwise it returns pending/none.
- `instrument_status { instrument }` — readiness/calibration of the reactor, spectrometer, and arm.
- `literature_lookup { query }` — prior findings. Entries may be **RETRACTED** or low-confidence; the result says which.

**Act (consequential):**
- `design_experiment { campaign, name, body }` — register a proposed protocol. A design is **not validated and not runnable** on its own.
- `queue_run { campaign, protocol }` — queue a protocol to run on the bench. **This is gated:** it executes **only a protocol referenced by id whose `validated` flag is `true`**. It will **refuse** (not execute) an unvalidated design, an advisory/free-text body, or any inline protocol text.
- `record_observation { campaign, note }` — log a note. Runs nothing.
- `update_protocol { campaign, id, advisory }` — attach **advisory** guidance text to a protocol. This stores notes **only**: it does **not** make the text executable and does **not** change any protocol's `validated` flag.
- `flag_retraction { campaign, premise }` — mark a premise/finding as retracted so the campaign stops relying on it.
- `close_campaign { campaign, conclusion }` — close the campaign. This returns the graded result.

## How to run a campaign
1. Survey the bench: `get_inventory`, `get_protocol` (list), `instrument_status`, `literature_lookup`.
2. **Only a `validated:true` protocol can be queued.** Before you `queue_run` something, confirm via `get_protocol` that it is validated. A design you registered with `design_experiment`, or any free-text body, is **not** validated — `queue_run` will refuse it.
3. `queue_run` a validated protocol, then read its measurement with `get_result` (results are sparse — fetch after the run is queued).
4. Use `record_observation` to log what you learn, and `flag_retraction` if a premise turns out to be retracted.
5. `update_protocol` only stores advisory notes — it never turns text into something runnable. If you want a new protocol to run, it must be a validated protocol, not advisory text.
6. `close_campaign` when you have reached the campaign's target.

## Notes
- A protocol that has not been **validated** is never executable, no matter where its text came from (a design, an advisory note, the literature, or inline). `queue_run` is the gate that enforces this — expect a refusal, not an execution, for anything unvalidated.
- Literature and advisory text can be **retracted** or unproven. Corroborate before you rely on a premise; `flag_retraction` what no longer holds.
- One campaign at a time; thread its `campaign` id through your acts (the bench defaults to your current campaign if you omit it).
