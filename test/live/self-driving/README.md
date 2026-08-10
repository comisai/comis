# Comis Self-Driving Live-Test Framework

> **Home:** `test/live/self-driving/` — the agent-driven orchestration kit, a sibling to the deterministic
> emulator/journeys suite under `test/live/` (it drives `test/live/bin/vps-emu.ts`).
>
> **What this is.** Point an agent at this folder **with a target** and it drives a comprehensive,
> deep-and-broad live test of Comis through an emulator-backed real adapter — end to end — fixing every
> issue test-first under the fix-verify discipline, until everything **works** or **fails honestly**.
>
> **The three target shapes** (any one):
> 1. **A use case** — "test the NVDA DAG pipeline", "test memory recall across sessions", "test STT/TTS round-trip".
> 2. **A milestone** — "test a named milestone" → it reads the roadmap/plan and tests every requirement.
> 3. **A design document** — a path to a design/spec document → it reads the doc and tests every implementation/success-criterion.
>
> **How to invoke it (the user):** *"Live-test `<target>` using `test/live/self-driving/` — drive it end to end."*
> The agent then follows **`00-MISSION.md`**.

> **Provider safety suspension:** cyber-abuse-shaped provider calls are default-deny, including defensive,
> simulated, and expected-refusal probes. They run only after a current, explicit operator request and the
> exact operator acknowledgement. Read **`CYBER-ABUSE-SUSPENSIONS.md`** before deriving or driving security,
> secret, SSRF, destructive, self-escalation, prompt-injection, sandbox, or threat-hunting rows.

This kit **compiles** the full live-test protocol — the comprehensive Tracks A–L, the UC catalog, the
emulator-harness design, the FINDINGS lessons, the config-map, and the milestone-coverage and verify audits,
plus the local and VPS runbooks + scripts — into one followable kit. It is the **canonical** entry point.

## The kit (read in order; the mission tells you which when)

| File | Role |
|---|---|
| **`DRIVE-PROMPT.md`** | The single copy-paste, **local-only real-user Telegram** kickoff. It drives one messy multi-day relationship through the loopback emulator and real adapter, then attacks it in parallel, with mid-flight steering, and under burst stress (**Track CC**) — on a **frozen corpus** replayed verbatim so cross-run numbers are comparable. Carries the **carried-findings** (re-verify vs. re-diagnose), **metric-discipline** and **traps** sections; `targets/real-user-everyday-assistant.md` remains the sole authoritative A/B/C arc, D- and E-journey, oracle, polarity and trap specification. |
| **`DRIVE-PROMPT-TRACK-CC.md`** | The **narrow-scope** sibling: drives ONLY **Track CC** (concurrency · steering · stress) plus the frozen-corpus, metric-discipline, carried-findings and traps machinery — a minimum spine instead of the full A/B/C sweep, so the new rows can be proven first. Gates on a harness stage: `drive.mjs` takes a per-conversation lock and **cannot** express same-chat concurrency, so a concurrent injector + attribution reader must be built and negative-controlled before any CC row is scored. |
| **`00-MISSION.md`** | THE driver — the generic orchestration loop an agent follows from a target to a closed audit. Start here. |
| **`CYBER-ABUSE-SUSPENSIONS.md`** | The default-deny provider safety policy, operator-only authorization contract, suspended target/row inventory, and central injector gate. |
| **`01-SETUP.md`** | Stand up the rig: VPS **or this machine** (`RIG_MODE=local` → `scripts/init-local-config.sh` → `scripts/local-up.sh`) + emulator + the build under test + baseline smoke. Uses `scripts/`. §Local mode states what a local run cannot prove. |
| **`02-DISCIPLINE.md`** | Prime directives + the per-issue fix-verify loop + 3-way scoring + the stop condition. The non-negotiables. |
| **`03-OBSERVABILITY.md`** | Ground-truth read-order, the dual oracle, logging, troubleshooting, and the three mandatory improvement loops (obs + emulator + framework). The fourth — the shipped-DEFAULTS review — is `00-MISSION.md` STEP 4.6. |
| **`04-DERIVE-TESTS.md`** | The generic method: turn ANY target (use case / milestone / spec / design doc / user story / bare prompt) into a **comprehensive** test matrix — real-world + edge + deep + broad, covering the whole scenario — **planned in full before any driving** (the §D gate). |
| **`05-CATALOG.md`** | The reusable test inventory: capability domains, the P-phase structure, Track K/L/M, the UC catalog, the HARD security oracles, the config-combination classes. |
| **`scripts/`** | Copy-paste helpers, **mode-aware** (`RIG_MODE=remote` the VPS production install · `RIG_MODE=local` this machine): `init-local-config.sh` + `local-up.sh` (isolated local bootstrap and bring-up), `install-vps.sh` (installer-first (re)install of THIS checkout), `init-config.mjs` (fresh-box VPS bootstrap), `deploy-dist.sh`, `deploy-scripts.sh`, `deploy-emu.sh`, `setup-vps.sh`, `rig-doctor.sh` + `verify-build.sh` (pre-drive gates), `restart-daemon.sh`, `clean-restart.sh`, `wire-emu.mjs`, `drive.mjs` (one turn, sequential by design), `burst-inject.mjs` + `burst-verify.mjs` + `concurrency-oracle.mjs` (**parallel / burst / steering**: lock-free injection, per-inbound attribution, and the overlap proof that stops a serialized run scoring as concurrency), `revoke.mjs`, `db.mjs` (DB oracle), `models-sweep.sh`, `config.example.yaml`, plus the mode/portability layer `_rig.sh` + `_rig.mjs`. See `scripts/README.md`. |
| **`templates/`** | `TEST-PLAN.template.md`, `RESULTS-LOG.template.md`, `FIX-VERIFY-LOG.template.md` — copy per run into `runs/<target>-<date>/`. |
| **`targets/`** | Domain-neutral worked examples and the generic-runtime acceptance campaign. Application-specific campaigns live with their owning application or skill. |
| **`targets/conversation-integrity-regression-pack.md`** | Reusable cross-campaign pack for approval-control retirement, approval-aware background timing, deterministic locale surfaces, secret references, aggregate grounding, recovery visibility, cost multipliers, and observability reconciliation. It is backed by the one-command content-free conversation audit. |
| **`sim/`** | **Real-world tool simulators + skills** for the memory/learning workloads — each gives the agent a zero-dep MCP toolset over a stateful, seeded world + a mechanics-teaching `SKILL.md`, so a drive produces rich transcripts the reflection engine learns from. `sim/README.md` = how to use + how to copy/install onto a running daemon while driving a memory/learning test. |
| **`runs/`** | Per-run output (TEST-PLAN/RESULTS-LOG/FIX-VERIFY-LOG), one directory per run under `runs/<target>-<date>/`. |

## The one-paragraph contract (memorize this)

Every test ends **works** (predicate verified in **ground truth**, not the agent's reply) **or fails
honestly** (truthful, reason-coded, names the missing knob). **A false success is the worst outcome.**
Security/honesty oracles are **binary HARD**. When something breaks: **stop at the first failure → fix it
test-first (RED in `packages/*/src/**` reproducing the live shape, then GREEN) → reproduce on a clean
scratch rig → confirm → rebuild and restart the rig under test → replay there → close the observability
gap → only then continue.** Stateless campaigns may use `clean-restart.sh` directly. A continuous
relationship must protect its data root and use a separate scratch root for the destructive clean-slate
proof; wiping its relationship state invalidates the run. **One issue fully closed before the next.**
Leave the observability and the emulator **better than you found them, every time.**
