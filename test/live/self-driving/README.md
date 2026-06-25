# Comis Self-Driving Live-Test Framework

> **Home:** `test/live/self-driving/` — the agent-driven orchestration kit, a sibling to the deterministic
> emulator/journeys suite under `test/live/` (it drives `test/live/bin/vps-emu.ts`). Relocated from
> `.planning/live-tests/live-tests-v2/` on 2026-06-25.
>
> **What this is.** Point an agent at this folder **with a target** and it drives a comprehensive,
> deep-and-broad live test of Comis on the VPS through the Telegram emulator — end to end — fixing every
> issue test-first under the fix-verify discipline, until everything **works** or **fails honestly**.
>
> **The three target shapes** (any one):
> 1. **A use case** — "test the NVDA DAG pipeline", "test memory recall across sessions", "test STT/TTS round-trip".
> 2. **A milestone** — "test v2.29 M1", "test v2.28 channel-emulation" → it reads the roadmap/plan and tests every requirement.
> 3. **A design document** — a path like `.planning/design/SECURE-AGENT-AUTONOMY-M1-platform-foundation.md` → it reads the doc and tests every implementation/success-criterion.
>
> **How to invoke it (the user):** *"Live-test `<target>` using `test/live/self-driving/` — drive it end to end."*
> The agent then follows **`00-MISSION.md`**.

This kit **compiles** the historical `.planning/live-tests/` archive (the 1876-line protocol, the
comprehensive Tracks A–L, the 30-UC catalog, the emulator-harness design, the FINDINGS lessons, the
config-map, the milestone-coverage and verify audits, the VPS runbook + scripts) into one followable kit.
It is the **canonical go-forward** entry; that archive is **local / gitignored** historical deep-reference —
the few `…` refs to it below point at `.planning/live-tests/…` (present on the dev box, not committed).

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
| **`scripts/`** | Copy-paste helpers (`deploy-dist.sh`, `setup-vps.sh`, `restart-m1.sh`, `clean-restart.sh`, `drive.mjs`, `revoke.mjs`, `db.mjs` (DB oracle), `models-sweep.sh`, `config.example.yaml`). See `scripts/README.md`. |
| **`templates/`** | `TEST-PLAN.template.md`, `RESULTS-LOG.template.md`, `FIX-VERIFY-LOG.template.md` — copy per run into `runs/<target>-<date>/`. |
| **`targets/`** | How to specify a target + worked examples: `EXAMPLE-nvda-dag.md` (channel/orchestrate) and `EXAMPLE-verified-learning.md` (offline/DB/event-resident). |
| **`runs/`** | Per-run output (TEST-PLAN/RESULTS-LOG/FIX-VERIFY-LOG). Worked runs: `runs/verified-learning-20260624/` (offline target; found+fixed the MD-02 `memory_store` bug) · `runs/orchestration-excellence-20260624/` (channel/DAG target; verified P0-A/B/C+P1 shipped, found the per-root wall-clock long-session degrade). |

## The one-paragraph contract (memorize this)

Every test ends **works** (predicate verified in **ground truth**, not the agent's reply) **or fails
honestly** (truthful, reason-coded, names the missing knob). **A false success is the worst outcome.**
Security/honesty oracles are **binary HARD**. When something breaks: **stop at the first failure → fix it
test-first (RED in `packages/*/src/**` reproducing the live shape, then GREEN) → wipe logs+memory+test
sessions → rebuild + clean-restart → reproduce on the clean slate → confirm → close the observability gap →
only then continue. One issue fully closed before the next.** Leave the observability and the emulator
**better than you found them, every time.**
