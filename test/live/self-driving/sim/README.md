# sim/ — real-world tool simulators + skills for the memory/learning workloads

Each workload here gives a Comis agent a set of **realistic, agent-callable tools** (over a stateful, seeded
simulated world) plus a **skill** that teaches how to use them — so a live drive produces the rich,
fabrication-free transcripts the **reflection/learning engine** needs to learn a strategy and reuse
it. These are the runnable companions to
[`../targets/MEMORY-LEARNING-STRESS-CATALOG.md`](../targets/MEMORY-LEARNING-STRESS-CATALOG.md); the design
rationale (and why MCP, not `exec`) is in [`DESIGN-DRAFT.md`](./DESIGN-DRAFT.md).

**The one principle:** every `SKILL.md` teaches tool **mechanics** (the tools, the call order, the goal) —
never the **strategy** (which host is compromised, the winning playbook). The strategy is what the reflection
engine must *learn* from successful episodes. The hidden truth lives only in each workload's
`world.seed.json` + the grader in `handlers.mjs`.

## Layout
```
sim/
  shared/{world,registry,rpc}.mjs   # seedable PRNG · workload loader · zero-dep MCP stdio server
  bin/{mcp-server,cli}.mjs          # generic entry points (load any workload by name)
  HANDLERS-CONTRACT.md              # how a workload is built (the contract)
  deploy-sim.sh                     # copy this tree to the VPS
  <workload>/                       # one dir per workload (14):
    tools.json  world.seed.json  handlers.mjs  SKILL.md
```
There is **one generic MCP server**; each workload is a separate *process* launched with its name as an arg
(`node sim/bin/mcp-server.mjs <workload>`), so its tools surface as `mcp:<server>/<tool>`.

## Local quickstart (CLI — for seeding / debug / self-test)
The **agent** uses the MCP server; this CLI is for you. Each CLI call is a *fresh* process, so multi-step
episode state does NOT persist across separate calls — use `--selftest` (a full episode in one process).
```bash
cd test/live/self-driving/sim
node bin/cli.mjs --workloads                      # list all 14 workloads
node bin/cli.mjs threat-hunting --list            # the tools (functions) + schemas
node bin/cli.mjs threat-hunting --selftest        # golden path → success, naive → failure  (ground truth)
node bin/cli.mjs threat-hunting query_telemetry --filter FS-01   # call one function, print JSON
SIM_VARIANT=B node bin/cli.mjs threat-hunting --selftest          # a rotated-surface variant (transfer)
```
`--selftest` is the ground-truth check that a workload's success signal is reachable **and** that the naive
shortcut (the thing the engine must learn to avoid) actually fails. All 14 pass on variants A/B/C.

## Copy to the VPS
Plain `.mjs`, no build. `deploy-sim.sh` ships the whole tree to a path the daemon (user `comis`) can read:
```bash
cd test/live/self-driving/sim
cp ../scripts/.live-env.example ../scripts/.live-env   # once: set VPS=user@host (shared with the rig)
bash deploy-sim.sh                                      # → /home/comis/sim on the box (override: SIM_DEST=…)
```
It prints the exact install commands for the workload you're testing.

## Install onto the running daemon
Two faces (see [`DESIGN-DRAFT.md` §Deployment](./DESIGN-DRAFT.md)): the MCP server can be added **live, no
restart**; the skill needs a discovery path (picked up on the next restart / file-watch). The CLI is **not on
PATH** — prefix everything with `node packages/cli/dist/cli.js`.

**1. Connect the workload's MCP server (LIVE — no restart):**
```bash
# ⚠ --args is VARIADIC (space-separated). Do NOT comma-join "path,workload" — the CLI passes it as a
#   SINGLE arg and node fails with "Cannot find module '…/mcp-server.mjs,workload'" (verified live).
node packages/cli/dist/cli.js mcp connect th-sim \
  --transport stdio --command node \
  --args /home/comis/sim/bin/mcp-server.mjs threat-hunting
node packages/cli/dist/cli.js mcp list             # th-sim → connected, 12 tools
node packages/cli/dist/cli.js mcp status th-sim    # the discovered tool names
```
The MCP server takes an optional **3rd arg = the variant** (A/B/C): `--args …/mcp-server.mjs threat-hunting B`
rotates the surface facts for the transfer/reuse step — no config-env needed. (`mcp connect` persists to
config; `mcp disconnect th-sim` removes it. The server runs **unsandboxed** and does no disk writes.)

**2. Let the agent discover the workload's skill:** add the workload dir to the agent's
`skills.discoveryPaths` (it scans for `SKILL.md`) via the rig's config patcher (`scripts/cfg-patch.mjs`),
then restart once so it loads:
```bash
ssh root@$VPS 'printf "%s" "{\"agents\":{\"default\":{\"skills\":{\"discoveryPaths\":[\"/home/comis/sim/threat-hunting\"]}}}}" > /tmp/patch.json; \
               su - comis -c "node /tmp/cfg-patch.mjs"'
# (or drop the SKILL.md into the agent's auto-discovered ~/.comis/workspace-<agentId>/skills/)
```
A from-scratch memory/learning drive restarts anyway (next section), so the skill comes up with it.

> **Driving ALL 14 (or several) workloads? Set EVERY sim dir in `discoveryPaths` ONCE + restart ONCE**
> (far less friction than a per-workload
> discoveryPath+restart). The skills are namespaced + distinctly-described, so a capable model picks the
> right one per task; `drive-sim-workload.sh` then only swaps the MCP *server* (live, no restart) per
> workload. Patch all 14: `{"agents":{"default":{"skills":{"discoveryPaths":["/home/comis/sim/package-delivery","/home/comis/sim/threat-hunting", … all 14 … ]}}}}`.

> **Not wiping `memory.db` between workloads (accumulating tools in ONE session) is a useful STRESS** — it
> surfaced a toolStats-sentinel bug (a >64-distinct-tool `toolStats` tripped the bounding backstop's
> object-key cap → schema-invalid `explain`; since FIXED by the toolStats count-cap). But it makes per-session
> reads noisier (the trajectory unions every workload's tools). For a CLEAN per-workload admit read, use the
> mental_models count DELTA (before/after — `drive-sim-workload.sh` prints it) or reflect-per-workload.

---

## Worked end-to-end: drive ONE memory/learning test on the running daemon

> **The one-command path (use this).** The whole per-workload
> ACC→REFLECT loop below is now `scripts/drive-sim-workload.sh`:
> ```bash
> ssh root@$VPS 'export COMIS_GATEWAY_TOKEN=<GWTOKEN> COMIS_CONFIG_PATHS=/home/comis/.comis/config.yaml; \
>                bash /root/drive-sim-workload.sh threat-hunting'        # restart→connect→reset→2 feeders→reflect→read
> # for the REUSE/TRANSFER step, re-run on a rotated variant: … drive-sim-workload.sh threat-hunting B
> # flaky link? wrap it: bash /root/bg.sh th 'bash /root/drive-sim-workload.sh threat-hunting'  then  bash /root/bg.sh --poll th
> ```
> It embeds the canonical byte-identical feeder prompt per workload, restarts-m1 (fresh per-root meter —
> avoids a spurious-abort), connects ONE sim server at a time, and reads the ground truth (mm delta + the
> newest skill + a grounding grep). The manual walkthrough below is the breakdown of what it does.
>
> Read the per-session diagnosis with `scripts/explain.mjs <sessionKey>` (the offline IncidentReport oracle —
> failures w/ `matchedRule`, `perRootBudget`, `likelyRootCause`, the learning block; ROOT-HOME-guarded so it
> never silently reads `/root/.comis`).

The point of these sims: make the **A→B→reuse loop** real. Walkthrough with `threat-hunting`; the same shape
applies to any workload. Oracle = ground truth (`db.mjs` / `comis explain` / `scripts/explain.mjs` / the
`reflect:*` events), **never the chat reply** — model
[`../targets/EXAMPLE-verified-learning.md`](../targets/EXAMPLE-verified-learning.md)
and the spec [`../targets/adaptive-threat-hunting.md`](../targets/adaptive-threat-hunting.md).

**0. Deploy + a true from-scratch daemon** (fresh `memory.db` so the agent starts with NOTHING learned, and
WIPE_CRONS so exactly the 3 learning crons re-register):
```bash
bash deploy-sim.sh                                                  # sim → /home/comis/sim
# on the box (via the rig): wipe learning state + cron store, then restart on the fresh dist
WIPE_CRONS=1 bash /root/clean-restart.sh                            # see scripts/clean-restart.sh
```
Add the skill discoveryPath (step 2 above) to the same config before this restart so it surfaces.

**1. Connect the MCP server** (step 1 above) and confirm with `mcp list` that `th-sim` is up with 12 tools.

**2. Accumulate ≥2 corroborating SUCCESSFUL episodes** — drive the SAME incident from **two distinct
senders** (distinct `(session, sender)` is the REFL-3 corroboration bar). The agent picks up the
`th-sim-console` skill, calls `mcp:th-sim/*` to investigate, and resolves the case:
```bash
# sender 1
node /root/drive.mjs "$CHATID"   "Work SOC alert AL-3 on the threat-hunting console and resolve the case."
# sender 2 (a different sender id → distinct corroboration source)
node /root/drive.mjs 678314279   "Investigate the off-hours file-server activity on the SOC console and close it out."
```
Verify the outcomes actually resolved to success (Loop A) — ground truth, not the reply:
```bash
node /root/db.mjs pick outcome_events source,outcome      # outcome='success' rows
node /root/db.mjs count memories                          # grew
```

**3. Reflect** — use the rig's `reflect-run.mjs`, which triggers the fire-and-forget cron AND waits for the
EXACT completion marker (the admit lands ~20-25s later; a loose grep false-matches the ~1s dispatch), then
prints the content-free funnel verdict:
```bash
node /root/reflect-run.mjs                 # → "DONE after ~22s:" + {admissionOutcome:"admitted", selected, ...}
```
Observe the admit (HARD oracles INV-1..6 + REFL-3 trust ≤ learned):
```bash
node /root/db.mjs pick mental_models name,kind,state,trust_level,proof_count
#   → a kind='skill', state='candidate', trust_level='learned' row  (NEVER above learned = INV-1)
#   reflect-run.mjs already printed reflect:funnel.admissionOutcome = admitted (content-free, INV-6)
```

**4. Reuse on a ROTATED variant (the transfer + promote step)** — reconnect the server on variant B
(every hash/IP/domain rotates; only a *behavioral* learned skill still works), then drive a FRESH session:
```bash
node packages/cli/dist/cli.js mcp disconnect th-sim
node packages/cli/dist/cli.js mcp connect th-sim --transport stdio --command node \
  --args /home/comis/sim/bin/mcp-server.mjs threat-hunting B    # 3rd arg = variant (surface rotation)
node /root/drive.mjs "$CHATID" "New SOC alert just came in — work it on the console and resolve it."
```
The fresh session surfaces the learned skill (`memory:skill_used` / `used_skill_ids`), a successful reuse
fires `learning:skill_promoted`, bumps `proof_count`, and flips `candidate→active` at `promoteAtProofCount`:
```bash
node /root/db.mjs pick mental_models name,kind,state,proof_count            # state→active, proof_count↑
node packages/cli/dist/cli.js explain "<sessionKey>" --offline --format json   # .learning.{skillsUsed,skillsPromoted}
```
That closes the loop the catalog is built to test: **learn the behavior from successful episodes → reuse it on
a case whose surface facts all changed.**

## Knobs
- **`SIM_VARIANT`** (`A`/`B`/`C`) — rotates the surface facts (IOCs, ids, numbers) while the behavior the
  engine must learn stays constant. Use a *different* variant for the reuse step to test TRANSFER.
- **`SIM_SEED`** (number or word) — reproducible world. Same seed → same episode.
- **World state lives in the MCP server process** — `mcp reconnect`/`disconnect`+`connect` resets the world
  to a fresh episode; each `open_*` act starts an isolated case so two sessions don't interfere.

## Teardown
```bash
node packages/cli/dist/cli.js mcp disconnect th-sim
# remove the discoveryPath from config; WIPE_CRONS=1 clean-restart for the next from-scratch run
```

## The 14 workloads
| dir | MCP server | skill | primary stressor (catalog) |
|---|---|---|---|
| `package-delivery` | `depot-sim` | depot-courier | **learn the building layout + best route** (the Hindsight exemplar: cold = wander/slow, learned = direct/fast) |
| `threat-hunting` | `th-sim` | th-sim-console | behavioral-generalization vs IOC memorization (exemplar) |
| `market-making` | `mm-sim` | — | regime-drift / wholesale strategy supersession |
| `icu-clinical` | `icu-sim` | — | trust-tiering of conflicting authorities + leak-free |
| `contract-negotiation` | `nego-sim` | — | shifting per-entity trust + transfer from archetypes |
| `wildfire-command` | `fire-sim` | — | transfer + multi-scale + retain-through-dormancy |
| `content-moderation` | `mod-sim` | — | anti-poisoning under corroboration pressure |
| `grid-operator` | `grid-sim` | — | non-stationary multi-scale + delayed credit |
| `lab-research` | `lab-sim` | — | **no-learned-code-execution (INV-3 keystone)** |
| `customer-success` | `cs-sim` | — | per-entity memory over quarters + reuse-promote |
| `aml-investigations` | `aml-sim` | — | behavioral generalization over rotated identities |
| `tutoring` | `tutor-sim` | — | self-supersession of the agent's own hypothesis + leak-free |
| `humanitarian-logistics` | `relief-sim` | — | transfer (flood→quake) + report trust-tiering + map supersede |
| `precision-apiary` | `apiary-sim` | — | extreme seasonal delay + retain-through-long-dormancy |

(skill `name:` shown where authored; each workload ships its own `SKILL.md` — the table lists the canonical
one for the exemplar.)

## Live-run findings (package-delivery on the VPS — don't re-discover)
- **`mcp connect --args` is VARIADIC (space-separated), not comma-joined.** `--args "path,workload"` is passed
  as ONE arg → the child node throws `Cannot find module '…/mcp-server.mjs,workload'` → `mcp list` shows the
  server `error`/`Connection closed (-32000)`. Correct: `--args /abs/mcp-server.mjs <workload> [variant]`. (The
  `--args` examples in the product MCP docs, `docs/skills/mcp.mdx` / `docs/reference/cli.mdx`, use the comma
  form — likely wrong for the variadic CLI; flag if you touch them.)
- **Verified working end-to-end:** after the fix, Comis connected `depot-sim` (8 tools discovered) and the live
  agent invoked `mcp__depot-sim--accept_package` / `--move` / `--deliver` (each executing in ~4-5ms). The MCP
  bridge round-trips correctly. The local single-session agent drive delivered cleanly (4 moves, par,
  `efficient:true`).
- **Drive into a FRESH or freshly-reset session.** The agent continues the session's prior CONVERSATION — if
  that session already holds another scenario's context (e.g. a threat-hunting drive), the delivery turn gets
  contaminated (the agent answered the old thread and treated the delivery as "background noise"). Use a clean
  session: `comis sessions reset <key> --yes` (clears conversation only; keep memories) or a fresh allowed
  sender. NOTE: `channels.<ch>.allowFrom` may restrict which sender ids are accepted — a non-allowed sender is
  silently dropped ("Sender blocked by allowFrom filter"); add yours or reuse an allowed one.
- **One MCP server process serves ALL Comis sessions.** Workloads that key the current episode on the
  process-global `ctx.lastTrip`/`ctx.lastCase` (e.g. package-delivery) assume **sequential** drives (one
  delivery at a time — the normal self-driving flow). Concurrent sessions hitting the same server can clobber
  each other's "current trip." For concurrent use, thread the explicit id returned by the `open_*`/`accept_*`
  act (the threat-hunting pattern), or run one server per concurrent caller.

## Phase A findings — all-14 capable-agent drive (each use case driven from its skill alone)
Fixes landed (test-first, selftest-guarded):
- **`--state` CLI dropped non-trivial case fields** → `Map`/`Set` (`decisions`/`escalations`/`designs`/`sampledHives`) came back as `{}` → `.set/.get/.add is not a function`; and it **never persisted `lastCase`** (only `lastTrip`), so `lastCase`-keyed workloads (icu/cs/tutoring) lost their open case every call and fragmented into one-case-per-call. Both fixed in `bin/cli.mjs` (rehydrate Maps/Sets; persist `lastCase`). *(CLI debug-path only — real MCP holds a live in-process Map.)*
- **threat-hunting** grader required the literal "pivot" token → a correct MITRE/behavioral finding scored `failure`. Now matches the behavioral identification (`pivot|lateral|t1021|off-hours`), gated by correct entity + containment.
- **icu-clinical** discriminator-gate state was process-global `ctx` → never resolved over `--state`, and leaked across concurrent sessions over MCP. Moved into the case (per-episode, persisted, isolated).
- **wildfire-command** `assign_crew` silently recorded a ground crew sent into a blow-up zone (irreversible, sank the grade even after reassigning). Now **refuses** unsafe ground assignments (not recorded) so posture can be probed safely.
- **customer-success / tutoring** "you don't need to thread the case id" is now true — handlers already default to `lastCase`; the `--state` persistence gap was the only cause of fragmentation.
- **market-making / grid-operator** keep episode state on process-global `ctx` (book/PnL/reserve/strategy), not in a case. They **win over the real long-lived MCP transport** (and `--selftest`), but are NOT drivable over the per-call `--state` CLI and are not isolated for *same-workload* concurrent sessions. Drive them over the MCP server (real Comis) or `--selftest`; "different use cases in parallel" is unaffected (separate server processes). *(Ideal future fix: move their state into an ensured case like `customer-success`.)*

## Phase B/C findings — real Comis learning loop (isolated local keyless daemon, qwen3.6:27b)
Stood up an isolated daemon (`dataDir` + own gateway/emulator, `provider: ollama` qwen3.6:27b, `memory.enabled` +
`learning.enabled`) — clean-restart/wipe freely, zero risk to a shared VPS. Proven end-to-end on real Comis:
- **MCP integration**: the daemon connects the sim servers and the agent EXECUTES the tools — `mcp__depot-sim--
  accept_package/read_directory/move/take_elevator/whereami` all succeeded (real round-trips through Comis's MCP
  bridge into the sim handlers).
- **Accumulate (Loop A / REFL-1)**: sim tool turns → `outcome_events` (`source='tool', outcome='success'`) +
  `memories`. The sim's outcomes flow into the learning engine.
- **Crons**: the 3 learning crons register (`Reflection` / `Memory lifecycle` / `Memory review`).
- **Reflect gate (INV-2)**: `cron.run Reflection` on a single-source set → `admissionOutcome:"uncorroborated"`
  (`maxTopicCardinality:1`), `mental_models` stays 0 — the engine correctly refuses to admit from one source,
  with a content-free verdict.
- **Parallel no-confusion (Phase C)**: two use cases connected at once (depot-sim + th-sim) expose **namespaced**
  tools (`mcp:depot-sim/*` vs `mcp:th-sim/*`) from separate server processes — no shared namespace, no shared
  state ⇒ different use cases cannot confuse tools. (Cross-task *conversation* contamination is a session
  concern — drive a fresh/reset session, per the Live-run findings above.)

**Config gotchas hit (fixed):** `integrations.mcp.servers` is an ARRAY (`- name: …`), not a map; for a small
local model set `agents.<id>.capabilityClass: small` (defers the ~75-tool corpus to ~900-token stubs +
`discover_tools`) and raise the model `contextWindow` (the 8192 fallback can't hold the tool schemas).

**Operator-deferred drive — COMPLETED (VPS + Opus `claude-opus-4-8`).** The full
capable-model **rich-transcript cold→ADMIT→reuse→promote→TRANSFER** loop is verified end-to-end in ground truth
(the local 27b was too slow/loopy + under-yielded on thin transcripts; a capable model resolves it):
cold delivery to Priya@3-01 (variant A) → 2nd corroborating sender (byte-identical opening, card 2) → `cron.run
Reflection` admits a **behavioral** `kind=skill` doc (trust=learned, candidate) — the body is a GENERAL navigation
playbook ("consult the directory → plan route → verify nameplate → deliver"), recipient name only in `topicTokens`,
NOT a memorized "go to 3-01" → reuse on variant B (Dana@2-02) bumps `proof 1→2` → reuse on variant C (Marco@3-02)
bumps `proof 2→3` and flips **candidate→active**. One skill learned on A delivered to 3 rotated recipients/offices
the stored facts never saw = TRANSFER. So **a capable model produces a grounded, transferable reflected skill** —
refuting the prior content-quality worry for this workload.

- **Phase-0 PONG contamination (don't re-discover):** the rig's Phase-0 PONG round-trip drives into `CHATID`
  (678314278); if you then drive the FIRST delivery into that SAME session, the agent treats the delivery as
  "wandering off" from the PONG ask (it navigated to the office but never called `deliver`, then apologized) —
  the documented LCD-contamination trap. Drive deliveries into a FRESH session (a clean-restart, or a sender
  that hasn't done a PONG), OR `session.reset_conversation` between the PONG and the first real drive.
- **Flaky/high-latency VPS link — background the drive ON the box, then poll** (this run's SSH dropped a 300s
  foreground `drive.mjs` repeatedly). `nohup node /root/drive.mjs … > /tmp/drive.out 2>&1 &` then poll
  `/tmp/drive.out` (+ the trajectory) in short ssh calls — the long-running turn survives your ssh dropping.
- **`deploy-sim.sh` fixed this run:** was `scp -rq` (HANGS on a high-latency link) + `rm $DEST` BEFORE the copy
  landed (destructive-on-failure → the live sim dir got wiped when scp hung). Now a robust tar-pipe staged in
  `$DEST.new`, swapped only after a verified extract — mirrors `scripts/deploy-dist.sh`.

## Gotchas
- **stdout is the MCP wire** — handlers/log must never `console.log` to stdout (use `ctx.log` → stderr).
- **mechanics, not strategy** — if you find a `SKILL.md` revealing the answer/playbook, that's a bug; fix it
  (the engine must *learn* the strategy).
- **fresh process per CLI call** — `node bin/cli.mjs <wl> <tool>` does not carry case state between calls;
  the long-lived MCP server (and `--selftest`) do.
- **MCP servers run unsandboxed** by design (`docs/security/exec-sandbox.mdx`) — treat each as a trusted
  dependency; these are local test fixtures, no network/disk.
