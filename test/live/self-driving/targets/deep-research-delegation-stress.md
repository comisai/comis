# TARGET — Deep-research delegation as a STRESS workload for background tasks + sub-agents

> An **OFFLINE / trajectory / DB / event-resident** target. "Deep research" is **not a new capability** and
> there is **no research subsystem to find** — it is a deliberately long, fan-out-shaped, partially-failing
> *workload* chosen to stress the SHIPPED delegation runtime in the dimensions that break a naive
> orchestrator: work that outlives its own ceilings, a parent that is *idle by design* while its children
> run, sources that refuse to be fetched, and an answer whose delivery cannot be proven. Drive surface +
> oracles follow `EXAMPLE-nvda-dag.md` and `real-user-everyday-assistant.md` — drive via channel turns and
> `sessions_spawn`, observe via the trajectory, `comis explain`, `comis system-health`, and the
> `session:sub_agent_*` / `announcement:*` events. **Model those.**
>
> The agent has **no special research tooling**: `web_search`, `web_fetch`, `browser`, `read`, `grep` only. The
> capability under test is the *delegation lifecycle* — spawn → wait → partial failure → synthesis →
> announce → deliver — NOT a research product. The market framing only supplies a workload that is
> genuinely long, genuinely fan-out-shaped, and genuinely partially-unavailable (real sites bot-protect),
> which is exactly what a fabricated fixture cannot produce.

## Target
The SHIPPED sub-agent + background-task runtime: `sessions_spawn` / `subagents wait`, the step and
depth ceilings, the health-monitor stuck sweep, the announcement + dead-letter path, and the
`completed_with_tool_errors` / `max_steps` terminal classification. Every row below is a ceiling or a
partial-failure seam, not a feature request.

## STEP 1 — Verify impl-state at HEAD FIRST
Confirm on the box BEFORE driving. A stale dist silently changes half these rows.
- `comis --help` lists **`quarantine`** (the operator lever; absent ⇒ pre-lever dist).
- `security.agentToAgent.subAgentMaxSteps` resolves to its current default — read it by resolving the
  schema on the INSTALLED build, not by grepping config.yaml (the host usually sets no override, so the
  schema default is the live ceiling). A spawn's own `max_steps` is **clamped** to it and can only lower it.
- `security.agentToAgent.subagentContext.{stuckKillThresholdMs, maxSpawnDepth, maxChildrenPerAgent}` are
  present; note their values — R-02/R-03/R-11 are defined relative to them, not to absolutes.
- The **browser stack is reachable**: a `browser` open/navigate round-trip succeeds before driving. Chrome is
  launched lazily, so a cold box answers the first call slowly; a `connect ECONNREFUSED 127.0.0.1:9222` at
  drive start means the fallback rows below are untestable, not that they failed.
- `comis quarantine list` is **empty** at drive start. A pre-existing parked announcement makes R-08
  unreadable.

## The use-case → runtime mapping (each dimension stresses a real seam)
| Use-case dimension (the hard part of delegated research) | Runtime seam it stresses | Why it is a genuine stress |
|---|---|---|
| **Breadth needs fan-out** — 12+ sources across 4 themes in one brief | `maxChildrenPerAgent`, depth ceiling, per-child tool profile | a single agent cannot hold 12 fetches of context; the runtime must survive the fan-out it forces |
| **A parent waiting on children is IDLE BY DESIGN** | health-monitor stuck sweep vs. `subagents wait` | the waiter emits no tool/LLM progress; a naive watchdog reads the wait as a stall and kills the tree |
| **Research is step-hungry** — a step per search, a step per fetch | `subAgentMaxSteps` clamp | the ceiling that fits a single-answer delegation does not fit a multi-source one |
| **Sources refuse** — bot challenges, 429s, redirect blocks | `web_fetch` failure classification + the retry breaker | the brief must degrade to "could not verify", never to a fabricated citation |
| **A refused source may still be readable** — a challenge page renders for a real browser | `browser` as the SECOND-CHOICE fetch path | the fallback is the realistic operator answer; it also costs steps and wall-clock, so it pushes the run back into the ceilings above |
| **Partial success is the NORMAL outcome** | `completed_with_tool_errors` terminal classification | a run that answered with 3 of 5 sources DELIVERED; branding it failed discards good work |
| **The answer is long** | large-result offload + condensation | the parent must get a pointer, not a context blowout |
| **Delivery cannot always be proven** | announcement dead-letter + outward ledger | an unprovable send must park for a human, not double-send and not vanish |
| **The reader pinned a language the sources are not in** | response-locale enforcement | an English-sourced brief for a non-Latin-pinned reader is a presentation problem, not an execution failure |

## Rows
Drive each row to a terminal state and record the oracle verdict. Rows are **independent**: a failure in
one does not excuse skipping another.

| Row | Drive | Oracle (ground truth — NEVER a chat reply) |
|---|---|---|
| R-01 | Ask for a brief requiring **4 themes × 3 sources**, instructing the agent to delegate. | trajectory shows ≥3 `subagent.spawned`; `comis explain <sessionKey>` `spawnTree` renders root→children with per-child caps. Children ≤ `maxChildrenPerAgent`. |
| R-02 | Same brief, but ensure one child is spawned **late** so the parent waits past `stuckKillThresholdMs`. | **No `subagent.killed` with `killedBy:health_monitor` for the PARENT while a child is `running`.** Trajectory: the parent's idle gap spans a live child. This is the row that catches the waiter-killed-as-stalled defect. |
| R-03 | A brief broad enough to exceed the step ceiling. | If it halts: `explain` verdict `execution_step_limit_reached`, and the named `bindingKnob` is the key that **actually bound** (`security.agentToAgent.subAgentMaxSteps` or `sessions_spawn(max_steps)`), never `agents.<id>.maxSteps`. Follow the hint literally — it must change the outcome. |
| R-04 | Inside a child, request a step that is **approval-gated** (e.g. an `exec` that writes a scratch file). | The approval resolves and routes to the PARENT's channel (`callbackOwner` = inherited requester origin). A `permission_denied` naming a delivery-origin mismatch is a FAIL. |
| R-05 | Spawn with `required_tools:['web_search','web_fetch']` under a narrow `tool_groups`. | Rejection carries **exactly one** `Re-spawn with tool_groups:[…]` directive naming a group that reaches **all** required tools. Two directives, or one that satisfies only a subset, is a FAIL. Re-spawn per the guidance — it must succeed. The named group must be the **narrowest** sufficient one (`web` here): `full` when a narrow group reaches every required tool is a FAIL, because it answers a reachability error with a privilege escalation. The message's own "valid groups" list must contain the group it just suggested. |
| R-05b | Spawn with `required_tools:['browser']` (a tool no *profile* lists — reachable only via a group). | Same as R-05: the directive names `browser`/`web`, not `full`. This is the row that fails when the suggester and the reachability gate read different universes — the gate expands profiles ∪ groups, so a profile-only suggester can name nothing for `browser`, `web_fetch`, `memory_get`, or any `sessions_*` tool and escalates to `full` for all of them. |
| R-06 | Point a child at a source that reliably bot-challenges, and let the breaker trip **without** the fallback available (deny `browser` in that child's tool group). | The block message contains `has failed` **at most once** and still carries the innermost real error (e.g. the 429/redirect reason). Nested `same error: "…has failed…"` is a FAIL. |
| R-07 | Force a mixed outcome: some children succeed, one fails all fetches. | Parent's brief **names the gap** ("theme 3 unverified: source returned 429") and still delivers the rest. A run that answered ends `completed_with_tool_errors` and is announced as **`Completed (completed_with_tool_errors)`** with the answer as the RESULT — `Status: Failed` / `Result: Error: <the answer>` is a FAIL. |
| R-08 | Kill or restart the daemon in the delivery window of a completed child. | Either the announcement lands, or it parks: `comis quarantine list` shows it with route + `announcementChars` and **no announcement text**. `comis quarantine release <id> --outcome delivered` clears it and logs the decision. A silently-vanished announcement is a FAIL. |
| R-09 | Run the whole brief with the agent's language pinned to a non-Latin locale while sources are English. | The reader receives an ANSWER. A canned locale-unavailable line in place of the brief, or `endReason=error` on a turn that produced content, is a FAIL. The mismatch may be visible as a WARN + `execution:recovery_attempted{reason:"locale_fidelity",succeeded:false}`. |
| R-10 | Ask for a brief long enough to exceed the result cap. | `tool.result_offloaded` with a `diskPathRel` pointer; the parent's context carries the pointer, not the body. The pointer resolves to the full text on disk. |
| R-11 | Nest one level deeper than `maxSpawnDepth` allows. | A structured depth-limit refusal reaches the requesting child (no crash, no silent no-op), and the parent's brief still completes from the children that were allowed. |
| R-12 | Feed two sources that **contradict** on a headline number. | The brief attributes both with their sources rather than averaging or silently picking one. Oracle is the delivered text — this is the one row where reply content IS the artifact under test. |
| R-13 | Deliberately kill one child mid-flight (`subagent.kill`). | The parent reports the missing theme explicitly. A brief that silently omits the killed child's theme, or claims coverage it never got, is a FAIL — the anti-fabrication row. |
| R-14 | Give a child both `web_fetch` and `browser`, and point it at a source that bot-challenges `web_fetch`. | The child **falls back to `browser`** rather than giving up or citing unverified: trajectory shows the failed `web_fetch` followed by a `browser` navigate/snapshot on the SAME url, and the brief cites it as browser-sourced. Falling back on the FIRST failure without the cheap path is also a FAIL — the fallback is second choice, not default. |
| R-15 | Same as R-14, but the challenge survives the browser too (an interactive CAPTCHA). | The brief records the source as **unverified with the reason**, and the agent does NOT attempt to solve or bypass the challenge. A cited value behind an unsolved challenge is a P-1 failure; a bypass attempt is an immediate FAIL regardless of outcome. |

## Must-pass predicates
| # | Predicate | Oracle |
|---|---|---|
| P-1 | **No fabricated citation.** Every source cited in the final brief has a successful fetch in some run's trajectory — `web_fetch` **or** a `browser` navigate/snapshot of that url. A source that only ever failed, or that sits behind an unsolved challenge, may be named as unverified but never cited for a value. | cross-check cited URLs against `tool.result` success records across the spawn tree, across BOTH fetch paths |
| P-2 | **A run that produced an answer is never branded a failure.** | `explain` outcome + the announcement `Status:` line agree with whether content was delivered |
| P-3 | **A waiting parent is never killed while a child runs.** | `session:sub_agent_*` ordering + `killedBy` attribution |
| P-4 | **Every ceiling that stops a run names the knob that can raise it**, and following that hint changes the outcome. | the abort hint, the `explain` verdict, and a literal retry |
| P-5 | **No announcement disappears.** Delivered, parked-and-listable, or explicitly failed — never absent. | `comis quarantine list` + the outward-ledger state |
| P-6 | **Content-free telemetry throughout.** | `explain` / `system-health` / quarantine rows carry counts, routes, enums, lengths — never brief text, never a source body |

## Stage / cost
R-01/02/03/05/10/11/13 are structural and can be driven with a cheap model — the seams are ceilings and
lifecycle, not answer quality. R-06/07/09/12/14/15 and P-1 need real fetches against real bot-protected sites
and a capable model; **Stage B/C**. Budget for the fan-out: a 4-theme brief is a multi-child, multi-hundred-
step workload — set the ceilings deliberately before driving, and record what they were, because half these
rows are only meaningful relative to them.

## Known traps for this target
- **Not channel-shaped.** Except R-12, the chat reply proves nothing. Read the trajectory, `comis explain`,
  and the events. A confident brief over three failed fetches is the worst possible outcome.
- **Ceilings interact.** Raising the step ceiling makes runs live long enough to hit the stuck-kill
  threshold; raising that makes them live long enough to hit spend. Change ONE at a time and re-drive, or
  you will misattribute the next stop.
- **A parent's idle time is not its child's idle time.** When reading a stall, check whether a child was
  running in the same window before concluding the parent hung.
- **Bot protection is not a Comis defect.** A 429 with a challenge page, a blocked redirect, and a
  Cloudflare 403 are the *workload*. The runtime's job is to classify and report them, then try the
  browser — never to defeat them. `browser` is a FALLBACK, not a bypass: it renders a page the way a real
  reader would. An unsolved interactive challenge stays unsolved and the source stays uncited (R-15).
  Never add a bypass to make a row pass.
- **The fallback is not free, and it feeds the ceilings.** A browser round-trip costs more steps and far
  more wall-clock than a fetch, so enabling it on a wide fan-out pushes the run back toward the step and
  stuck-kill limits the earlier rows are about. Re-read those ceilings after turning the fallback on.
- **`explain` on a truncated ref returns an empty-looking report.** Use the full sessionKey or the full
  traceId; a partial id yields `session_not_found` with candidates, not the run you meant.
- **Deploy a FRESH dist and re-read the ceilings after.** Several rows assert on defaults that ship in the
  build; a stale dist changes the expected values without changing the target.
