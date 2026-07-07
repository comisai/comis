# Comis Self-Driving Live-Test Framework

> **Home:** `test/live/self-driving/` — the agent-driven orchestration kit, a sibling to the deterministic
> emulator/journeys suite under `test/live/` (it drives `test/live/bin/vps-emu.ts`).
>
> **What this is.** Point an agent at this folder **with a target** and it drives a comprehensive,
> deep-and-broad live test of Comis on the VPS through the Telegram emulator — end to end — fixing every
> issue test-first under the fix-verify discipline, until everything **works** or **fails honestly**.
>
> **The three target shapes** (any one):
> 1. **A use case** — "test the NVDA DAG pipeline", "test memory recall across sessions", "test STT/TTS round-trip".
> 2. **A milestone** — "test a named milestone" → it reads the roadmap/plan and tests every requirement.
> 3. **A design document** — a path to a design/spec document → it reads the doc and tests every implementation/success-criterion.
>
> **How to invoke it (the user):** *"Live-test `<target>` using `test/live/self-driving/` — drive it end to end."*
> The agent then follows **`00-MISSION.md`**.

This kit **compiles** the full live-test protocol — the comprehensive Tracks A–L, the 30-UC catalog, the
emulator-harness design, the FINDINGS lessons, the config-map, and the milestone-coverage and verify audits,
plus the VPS runbook + scripts — into one followable kit. It is the **canonical** entry point.

## The kit (read in order; the mission tells you which when)

| File | Role |
|---|---|
| **`DRIVE-PROMPT.md`** | The copy-paste **kickoff prompt** — paste it (with your target filled in) to launch a run. Template + filled examples. |
| **`00-MISSION.md`** | THE driver — the generic orchestration loop an agent follows from a target to a closed audit. Start here. |
| **`01-SETUP.md`** | Stand up the rig: VPS + emulator + the build under test + baseline smoke. Uses `scripts/`. |
| **`02-DISCIPLINE.md`** | Prime directives + the per-issue fix-verify loop + 3-way scoring + the stop condition. The non-negotiables. |
| **`03-OBSERVABILITY.md`** | Ground-truth read-order, the dual oracle, logging, troubleshooting, and the two mandatory improvement loops (obs + emulator). |
| **`04-DERIVE-TESTS.md`** | The generic method: turn ANY target (use case / milestone / spec / design doc / user story / bare prompt) into a **comprehensive** test matrix — real-world + edge + deep + broad, covering the whole scenario — **planned in full before any driving** (the §D gate). |
| **`05-CATALOG.md`** | The reusable test inventory: capability domains, the P-phase structure, Track K/L/M, the 30 UCs, the HARD security oracles, the config-combination classes. |
| **`scripts/`** | Copy-paste helpers (`install-vps.sh` (installer-first (re)install of THIS checkout), `init-config.mjs` (fresh-box config bootstrap), `deploy-dist.sh`, `deploy-scripts.sh`, `deploy-emu.sh`, `setup-vps.sh`, `rig-doctor.sh` + `verify-build.sh` (pre-drive gates), `restart-daemon.sh`, `clean-restart.sh`, `wire-emu.mjs`, `drive.mjs`, `revoke.mjs`, `db.mjs` (DB oracle), `models-sweep.sh`, `config.example.yaml`). See `scripts/README.md`. |
| **`templates/`** | `TEST-PLAN.template.md`, `RESULTS-LOG.template.md`, `FIX-VERIFY-LOG.template.md` — copy per run into `runs/<target>-<date>/`. |
| **`targets/`** | How to specify a target + worked examples: `EXAMPLE-nvda-dag.md` (channel/orchestrate), `EXAMPLE-verified-learning.md` (offline/DB/event-resident), and `EXAMPLE-cron-wake-gate.md` (cron/scheduler-gate + jail, driven with `scripts/wg.mjs`). Also `MEMORY-LEARNING-STRESS-CATALOG.md` (12 complex memory/learning workloads) + `adaptive-threat-hunting.md` (a pinned spec). |
| **`sim/`** | **Real-world tool simulators + skills** for the memory/learning workloads — each gives the agent a zero-dep MCP toolset over a stateful, seeded world + a mechanics-teaching `SKILL.md`, so a drive produces rich transcripts the reflection engine learns from. `sim/README.md` = how to use + how to copy/install onto a running daemon while driving a memory/learning test. |
| **`runs/`** | Per-run output (TEST-PLAN/RESULTS-LOG/FIX-VERIFY-LOG), one directory per run under `runs/<target>-<date>/`. |

## The one-paragraph contract (memorize this)

Every test ends **works** (predicate verified in **ground truth**, not the agent's reply) **or fails
honestly** (truthful, reason-coded, names the missing knob). **A false success is the worst outcome.**
Security/honesty oracles are **binary HARD**. When something breaks: **stop at the first failure → fix it
test-first (RED in `packages/*/src/**` reproducing the live shape, then GREEN) → wipe logs+memory+test
sessions → rebuild + clean-restart → reproduce on the clean slate → confirm → close the observability gap →
only then continue. One issue fully closed before the next.** Leave the observability and the emulator
**better than you found them, every time.**
