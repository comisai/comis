# Design — real-world tool simulators + skills for the memory/learning workloads

> **Status: IMPLEMENTED** (all 13 workloads built + verified; D1→MCP, D2→mechanics-only, D3→one server per
> workload, D4→seeded `SIM_VARIANT`, all as proposed). Usage + copy-to-daemon instructions:
> [`README.md`](./README.md). Build contract: [`HANDLERS-CONTRACT.md`](./HANDLERS-CONTRACT.md). This file is
> kept as the design rationale (notably the MCP-vs-exec decision). Original proposal text follows.
>
> This proposes HOW we give each catalog workload
> ([`../targets/MEMORY-LEARNING-STRESS-CATALOG.md`](../targets/MEMORY-LEARNING-STRESS-CATALOG.md)) a set of
> realistic, agent-callable tools + a skill that teaches their use, so a live drive produces the rich,
> fabrication-free transcripts the reflection engine needs. Review the **Decisions to confirm** section
> first; once we agree, I'll build the shared scaffold + the threat-hunting simulator end-to-end as the
> reference, prove it on ground truth, then fan out the rest.

---

## 1. Goal & the one load-bearing principle

We want each workload to run **as close to the real world as we can simulate**: the agent calls domain tools
(query telemetry, post a quote, propose a differential…), the tools maintain a consistent world with
consequences, and the per-turn outcome resolves to a real success/failure that feeds Loop A → reflection.

**The load-bearing principle — teach MECHANICS, not STRATEGY.** This mirrors the Hindsight package-delivery
demo: the agent is told *"you have tools to navigate buildings and your job is to deliver packages"* — the
**tool API + the goal** — but NOT *where the offices are* or *the best route* (the **strategy**). Those it
must **learn**. So for every workload:

- the **simulator (CLI/MCP)** supplies the *tools* + a *world the agent must discover through use*;
- the **skill (SKILL.md)** teaches the *tool API + the job + how/when to call each tool* — **the mechanics**;
- the **reflection engine LEARNS the strategy** (which signals matter, the winning playbook), reflects it
  into a `kind='skill'` `mental_models` doc, and reuses it.

If the skill encodes the strategy, there is nothing left to learn and the workload stops testing the engine.
This separation is the whole point.

---

## 2. Decisions to confirm (please react to these)

| # | Decision | My recommendation | Why |
|---|---|---|---|
| **D1** | **How does the agent call the tools?** (a) MCP stdio server per workload, tools surface as `mcp:<sim>/<tool>` · (b) a plain CLI the agent runs via the built-in `exec` tool · (c) both | **RESOLVED → (a) MCP**, with the CLI core kept only for offline seeding/debug (see *Deployment & sandbox findings* below) | Verified on both axes: MCP is **easier to install on a running daemon** (`mcp connect` adds it live, no restart; MCP servers run *unsandboxed* so the stateful world file works) AND **better for the agent** (first-class named/typed tools, structured results, and a trajectory that shows the *domain action* — the exact signal reflection attributes + learns from — instead of a generic `exec` string). `exec` hits the sandbox wall for a *stateful* world. |
| **D2** | **Skill scope** — mechanics-only vs. include strategy | **Mechanics-only** (per §1) | Encoding strategy defeats the learning test. |
| **D3** | **One server per workload vs. one mega-server with a `SIM_USECASE` switch** | **One per workload, enable only the active one(s)** (`enabled:true` on the workload under test, others `false`) | Isolated worlds, clear config, no 13-toolset prompt bloat; only spin up what a given run drives. |
| **D4** | **Determinism** — seedable world + scenario script | **Yes: `SIM_SEED` + `SIM_VARIANT` env, deterministic PRNG, world snapshot on disk** | The framework demands "reproduce in ground truth." A seeded world makes an episode replayable; `SIM_VARIANT` rotates the *surface* facts while holding the *behavior* constant — that's how we test TRANSFER (reuse on rotated inputs). |
| **D5** | **Directory home** (§4) | `test/live/self-driving/sim/<workload>/` with the SKILL.md co-located | Everything for one workload in one place; a wiring step points the daemon's `skills.discoveryPaths` + `mcp.servers` at it. |
| **D6** | **Scope of the first cut** | **Shared scaffold + threat-hunting ONLY**, proven on ground truth, before the other 12 | Don't build 13 sims against an unverified pattern (AGENTS.md root-cause/ground-truth discipline). |
| **D7** | **Outcome-resolution contract** — how a turn becomes `outcome='success'` | **To confirm against the resolver code before building** | Terminal "act" tools will return an explicit graded result `{graded, outcome, score, rationale}`; I need to verify whether Loop A's resolver keys off the tool result, an LLM judge, or both, so the success signal is real (not a green mock). |

### Deployment & sandbox findings (verified — resolves D1)
- **Copy is identical** for MCP vs exec: an `scp` of plain `.mjs` files; `scripts/deploy-scripts.sh` already
  does this for `scripts/`. A `sim/deploy-sim.sh` does the same for `sim/`.
- **Install favors MCP.** `comis mcp connect <name> --transport stdio --command node --args "<path>/mcp-server.mjs"`
  *connects + persists* the server **at runtime** — no `config.yaml` hand-edit, no full daemon restart;
  verify with `comis mcp list`. (CLI not on PATH → `node packages/cli/dist/cli.js mcp connect …`.)
- **MCP stdio servers run UNSANDBOXED** (`docs/security/exec-sandbox.mdx`: launched with `NODE_OPTIONS`
  stripped, "run unsandboxed by design, treat each as a trusted dependency"). So the simulator is a
  **long-lived process holding world state in memory** + free to read/write its `world` file. This is exactly
  what a stateful world needs.
- **`exec` cannot easily hold stateful world.** `system.exec` runs in a **bwrap / sandbox-exec namespace where
  only approved paths are visible**, and each call is a *fresh* process (no in-memory continuity). Persisting a
  world across calls would require mounting the world-file path into the sandbox policy (fiddly, Linux-specific),
  and every agent command also passes the `ExecSecurityValidator` (rejects `$(...)`, backticks, proc-subst).
- **Zero-dep server** removes MCP's only copy cost: hand-roll the stdio JSON-RPC (`initialize` / `tools/list` /
  `tools/call`, ~100 lines) so there's **no `@modelcontextprotocol/sdk` to install** — copy stays a trivial `scp`.
- **Skill install is the same for both:** drop `SKILL.md` into a `skills.discoveryPaths` entry (or the agent's
  auto-discovered `~/.comis/workspace-{agentId}/skills/`); file-watch or the next clean-restart picks it up.

---

## 3. Architecture (per workload)

```
                 ┌─────────────────────── one simulator per workload ───────────────────────┐
  agent  ──MCP──▶ mcp-server.mjs  ──dispatch──▶  handlers (the "functions")  ──read/write──▶  world (seeded)
   ▲   tool call   (thin stdio adapter)            ▲                                            │
   │                                               │  same handlers                             │ terminal "act"
   │   SKILL.md (mechanics: tool API + the job)    └── cli.mjs (standalone: seed / debug / CI)   │ tool returns
   │                                                                                            ▼  {graded, outcome}
   └──────────────────────────────── reflection engine LEARNS the strategy ◀── Loop A outcome_events
```

- **`cli.mjs`** — the CLI core. Every "function" is a subcommand (`node cli.mjs query_telemetry --filter ...`).
  Holds all domain logic + world mutation. Runnable standalone for seeding, debugging, and a fast non-LLM
  smoke test of the world itself.
- **`mcp-server.mjs`** — a thin stdio MCP server (MCP SDK) that registers each function as an MCP tool
  (name, description, JSON input schema from `tools.json`) and dispatches to the **same handlers** as the
  CLI. No logic duplication.
- **`world.seed.json`** — the scenario's ground truth: entities + the *hidden* truth the agent must discover
  (the planted TTP, the true diagnosis, the hidden market regime…) + decoys/noise. Loaded into a live world
  snapshot at episode start, seeded by `SIM_SEED`.
- **`tools.json`** — single source of truth for the tool manifest (name/description/input schema), consumed
  by BOTH `cli.mjs` (help/arg-parse) and `mcp-server.mjs` (MCP discovery). One list, two faces.
- **`SKILL.md`** — the mechanics skill (frontmatter `name`+`description`; body = the tool API + the job +
  the call-order/decision-procedure, NO strategy).
- **`README.md`** — how to seed/run/debug + the exact success/failure signal for this world.

**Shared scaffold** (`sim/shared/`): `world.mjs` (seedable PRNG, load/save snapshot, `grade()` outcome
emitter), `mcp-harness.mjs` (the register-tools-from-`tools.json` → dispatch boilerplate), `cli-harness.mjs`
(arg-parse from `tools.json`). Each workload is then ~a `tools.json` + a handlers file + a `world.seed.json`
+ a `SKILL.md`.

**Realism levers** (what makes the world non-trivial for the learner): hidden state the agent can only infer
from observations; consequences (a wrong "act" degrades the world / fails the episode); noise + decoys;
non-stationarity (`SIM_VARIANT` rotates surface facts / shifts a regime); and an explicit, ground-truthed
**graded outcome** on the terminal act.

---

## 4. Directory layout (under `test/live/self-driving/`)

```
sim/
  DESIGN-DRAFT.md            # this file
  README.md                  # (built later) the architecture + the VPS wiring step
  shared/
    world.mjs                # seedable PRNG, snapshot load/save, grade()/outcome emit
    mcp-harness.mjs          # tools.json → MCP stdio server scaffold
    cli-harness.mjs          # tools.json → CLI arg-parse scaffold
  threat-hunting/            # the reference implementation (built first)
    tools.json               # the function manifest (name/description/schema)
    handlers.mjs             # the function bodies (shared by cli + mcp)
    cli.mjs                  # standalone CLI entry (seed/debug)
    mcp-server.mjs           # stdio MCP entry (agent-facing)
    world.seed.json          # the seeded scenario world
    SKILL.md                 # mechanics skill
    README.md
  market-making/ ... (one dir per workload, same shape)
```

Wiring on the VPS (added to the existing setup, exact keys verified against `docs/skills/mcp.mdx` +
`docs/reference/config-yaml.mdx`):

```yaml
integrations:
  mcp:
    servers:
      th-sim:                       # only the workload under test is enabled
        transport: stdio
        command: node
        args: ["<repo>/test/live/self-driving/sim/threat-hunting/mcp-server.mjs"]
        env: { SIM_SEED: "42", SIM_VARIANT: "A" }
        enabled: true
agents:
  default:
    skills:
      discoveryPaths: ["<repo>/test/live/self-driving/sim/threat-hunting"]  # finds SKILL.md
```

**Two install paths** (verified): the YAML block above is the *persistent/declarative* form (needs a
restart). The *runtime* form is preferred for the framework — `node packages/cli/dist/cli.js mcp connect
th-sim --transport stdio --command node --args "<path>/mcp-server.mjs"` adds + connects the server live,
no restart, and persists. A `sim/deploy-sim.sh` (sibling of `scripts/deploy-scripts.sh`) ships the `sim/`
tree to the VPS; then `mcp connect` (per active workload) + drop the `SKILL.md` into a discovery path →
`comis mcp list` confirms the tools and the skill surfaces. The learning oracle is unchanged — drive via the
emulator, observe via `db.mjs`/`comis explain`/`reflect:*` (the `EXAMPLE-verified-learning.md` shape).

---

## 5. Worked example — `threat-hunting` (the reference)

**MCP server:** `th-sim` → tools surface as `mcp:th-sim/<tool>`. Maps to
[`../targets/adaptive-threat-hunting.md`](../targets/adaptive-threat-hunting.md).

**The functions (`tools.json`):**

*Observe (read-only — let the agent discover the world):*
- `query_telemetry(filter, window)` → events (process/auth/dns/netflow) matching a filter
- `lookup_host(host)` → host facts (owner, role, recent sessions)
- `lookup_account(account)` → account facts (privileges, normal hours)
- `check_ioc(indicator)` → reputation for a hash/IP/domain *(deliberately unreliable across variants — IOCs rotate)*
- `get_baseline(entity)` → the normal rhythm (e.g. svc-backup touches the file server Tue 01:00 — a benign anomaly)
- `timeline(entity, window)` → ordered activity for one entity
- `list_open_alerts()` → the queue (incl. planted decoys)

*Act (consequential — these resolve outcomes):*
- `open_investigation(summary)` → case id
- `raise_finding(case, entity, ttp, confidence)` → records a hypothesis
- `contain_host(host, reason)` → **consequence**: containing the real pivot = progress; containing a benign host = a failure mark + business-impact penalty
- `escalate(case, tier)` → hands off
- `close_case(case, verdict)` → **terminal, graded**: returns `{graded:true, outcome:'success'|'failure', score, rationale}` vs. the world's hidden truth

**The world (`world.seed.json`):** hosts + accounts; the **hidden planted TTP** = off-hours-admin-pivot
(credential theft → multi-day dwell → weekend 02:00 file-server pivot via legitimate admin tools); a
**benign-anomaly baseline** (the Tuesday backup) the agent must NOT flag; **decoy alerts**; and per-`SIM_VARIANT`
**rotated IOCs** (new hash/IP/domain each variant, same behavior) — so a fact-memorizer fails the next variant
and only the learned *behavioral* playbook transfers.

**Outcome signal:** success = `raise_finding` names the real pivot TTP + `contain_host` hits the compromised
host(s) and NOT the benign ones, before `close_case`. This is the clean Loop-A success that drives REFL-1/3.

**SKILL.md (mechanics-only) outline:**
```
---
name: th-sim-toolkit
description: How to use the threat-hunting console tools (mcp:th-sim/*) to triage and resolve an alert.
---
You are a SOC analyst. You have these tools: <list each mcp:th-sim/* tool + when to use it>.
A typical investigation: open_investigation → pull telemetry/timeline → check baselines before you flag an
anomaly → raise_finding with a calibrated confidence → contain only what you're confident is hostile →
close_case with your verdict. Containing a benign host has real cost. IOCs are unreliable — corroborate.
# NOTE: deliberately NO strategy — does not say "look for the off-hours pivot" or which host is bad.
```
The off-hours-pivot playbook, the "check the Tuesday baseline first" heuristic, the "trust behavior over
IOCs" rule — those are **learned**, reflected into `mental_models`, and reused on the next variant.

**Why this is the right first build:** its target spec, predicates (REFL-1/2/3/5, INV-1..6), and traps
already exist; proving the sim → skill → tool-turn → outcome → reflect → reuse loop here validates the
pattern for all 12.

---

## 6. Tool inventory for all 13 workloads (the review surface)

Compact per-workload: MCP server · the *observe* and *act* functions · the world's **hidden truth** · the
**graded outcome**. (Full `tools.json` + world per workload comes at build time; this is to confirm scope/shape.)

| # | Server | Observe (read) | Act (consequential; **terminal graded**) | Hidden truth the agent must learn | Success signal |
|---|---|---|---|---|---|
| 0 | `th-sim` | query_telemetry, lookup_host/account, check_ioc, get_baseline, timeline, list_open_alerts | open_investigation, raise_finding, contain_host, escalate, **close_case** | off-hours-admin-pivot TTP behind rotating IOCs; benign Tuesday-backup baseline | correct finding + contain hostile-not-benign |
| 1 | `mm-sim` | get_quote, get_orderbook, get_position, get_pnl, regime_signals, get_fills, volatility | post_quote, cancel_quote, hedge, set_strategy, **flatten/settle** | hidden regime switches + correlation inversions; one noisy venue | positive risk-adj P&L within inventory limits |
| 2 | `icu-sim` | get_vitals, get_labs, get_notes(by role), get_orders, ward_baseline, guideline_lookup | propose_differential, recommend_workup, flag_deterioration, **finalize_assessment** | true dx revealed gradually; conflicting authors of unequal reliability; PHI in bodies | converge on true dx, calibrated, no PHI in telemetry |
| 3 | `nego-sim` | get_counterparty, get_term_sheet, history, market_comparables, read_message | send_offer, make_concession, walk_away, **accept/close** | hidden counterparty archetypes + shifting incentives; delayed renewal cost | good terms across recurring deals + archetype transfer |
| 4 | `fire-sim` | get_weather, fuel_moisture, terrain, spread_forecast, resource_status, incident_map | assign_crew, order_air, set_tactic, issue_evac, **declare_contained** | hourly weather/fuel shifts; fire-type-specific tactics; rare blow-up | contained, min acreage/waste, right tactic, crews safe |
| 5 | `mod-sim` | get_queue, get_item, get_reports, reporter_history, policy_lookup, similar_items | decide, escalate, action_account, label, **submit_verdict** | coordinated brigades (1 source), rephrase-evasion, sockpuppets, overnight policy change | correct verdict resisting brigade + survives rephrasing |
| 6 | `grid-sim` | get_load, get_generation, forecast, get_reserves, asset_status, frequency | dispatch, commit_reserve, shed_load, set_dispatch_strategy, **settle_interval** | renewable intermittency, outages, rare ice-storm contingency, delayed payoff | balance/frequency within limits at low cost incl. outage |
| 7 | `lab-sim` | get_inventory, get_protocol, get_result, instrument_status, literature_lookup | design_experiment, **queue_run (GATED)**, record_observation, update_protocol(advisory), flag_retraction | sparse/delayed assay readouts; retractable premise; a dangerous-if-run-blind protocol | converge via *validated* runs; **never executes learned text** |
| 8 | `cs-sim` | get_account, usage_metrics, health_score, contacts, renewal_calendar, similar_accounts | log_touch, propose_play, flag_churn_risk, **forecast_renewal/close_quarter** | multi-quarter slow signal; champion-departure discontinuity; look-alikes | renew/expand + play reuse on look-alikes + catch churn |
| 9 | `aml-sim` | get_case, account_activity, entity_graph, get_tips, tip_source, typology_lookup | open_case, file_finding, file_sar, **clear_case/resolve** | structuring behavior behind rotated mules; malicious external tips; SAR-delayed credit | detect typology behind rotation + ignore bad tips |
| 10 | `tutor-sim` | get_student, attempt_history, diagnostic, curriculum, affect_signal | pose_problem, give_hint, set_hypothesis, revise_hypothesis, **assess_mastery** | hidden true misconception (first guess often wrong); transfer fractions→decimals; resurfacing under stress; minor data | correct the *true* misconception + transfer + no loop + no leak |
| 11 | `relief-sim` | get_crises, route_status, field_reports, report_source, inventory, needs_assessment | dispatch_convoy, allocate, reroute, prioritize, **confirm_delivery** | fast road/access changes; variable/adversarial reports; flood→quake transfer; delayed confirm | aid reaches people + cross-disaster transfer + ignore false all-clear |
| 12 | `apiary-sim` | get_hives, inspect_hive, forage_map, weather_season, pest_pressure, harvest_forecast | schedule_inspection, treat, place_hive, **harvest/close_season** | season-late outcomes; vanished forage (supersede); recurring pest; retained seasonal playbooks | healthy hives + harvest timed to forage + right intervention |

Each server's **graded outcome** is what Loop A resolves to `success`/`failure`; running the same scenario
shape from **2 distinct (session, sender)** is how we reach the REFL-3 corroboration bar; running a fresh
session on a **rotated `SIM_VARIANT`** is how we test TRANSFER + reuse-promote.

---

## 7. How this drives the engine (ties back to the catalog)

For each workload, the live-test loop becomes concrete:
1. **ACC/RECALL** — the agent uses observe-tools + acts; the terminal graded act → `outcome_events` +
   `memories` (REFL-1); a taught baseline fact recalls cross-session (REFL-2).
2. **REFLECT** — 2 corroborating successful episodes (distinct session+sender, same topic) → the `Reflection`
   cron admits a `kind='skill'` candidate playbook (REFL-3) — the workload's transcripts are rich +
   fabrication-free (the SYNTH-YIELD-friendly case).
3. **REUSE/TRANSFER** — a fresh session on a **rotated variant** surfaces the learned skill, the agent reuses
   it (`memory:skill_used`), success promotes `candidate→active` (`learning:skill_promoted`).
4. **SUPERSEDE/EVICT/RETAIN/INV** — the per-workload world is built to also exercise its catalog-tagged
   stressors (e.g. `lab-sim` proves INV-3 NO-EXEC via the gated `queue_run`; `icu-sim`/`tutor-sim` prove
   INV-6 LEAK-FREE; `mod-sim` proves INV-2/5 anti-poisoning).

All observed via the existing offline oracle — no new observability needed beyond what the catalog already
names.

---

## 8. Open questions for you
1. **D1–D7** above — especially **D1** (MCP vs exec) and **D6** (build threat-hunting first, then fan out).
2. **Fidelity bar:** how real should the worlds be — a faithful-but-compact hand-authored world (my default),
   or do you want any of them backed by a richer data source (a recorded dataset, a heavier sim)?
3. **Which workloads matter most?** I'll build threat-hunting first regardless; tell me the next 2–3 to
   prioritize (my pick for highest engine-stress coverage: `#7 lab-sim` for NO-EXEC, `#2 icu-sim` for
   LEAK-FREE, `#5 mod-sim` for anti-poisoning).
4. **Skill granularity:** one mechanics skill per workload (my default), or also a tiny shared "how to read a
   graded outcome" skill across all of them?
5. **The outcome-resolution contract (D7)** — I'll verify the resolver before building so the success signal
   is genuine; flag if you already know whether it's tool-result- or LLM-judged.
```
