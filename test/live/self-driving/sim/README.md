# sim/ — real-world tool simulators + skills for the memory/learning workloads

Each workload here gives a Comis agent a set of **realistic, agent-callable tools** (over a stateful, seeded
simulated world) plus a **skill** that teaches how to use them — so a live drive produces the rich,
fabrication-free transcripts the **v2.31 reflection/learning engine** needs to learn a strategy and reuse
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

---

## Worked end-to-end: drive ONE memory/learning test on the running daemon
The point of these sims: make the **A→B→reuse loop** real. Walkthrough with `threat-hunting`; the same shape
applies to any workload. Oracle = ground truth (`db.mjs` / `comis explain` / the `reflect:*` events), **never
the chat reply** — model [`../targets/EXAMPLE-verified-learning.md`](../targets/EXAMPLE-verified-learning.md)
and the spec [`../targets/adaptive-threat-hunting.md`](../targets/adaptive-threat-hunting.md).

**0. Deploy + a true from-scratch daemon** (fresh `memory.db` so the agent starts with NOTHING learned, and
WIPE_CRONS so exactly the 3 v2.31 learning crons re-register):
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

## Live-run findings (package-delivery on the VPS, 2026-06-27 — don't re-discover)
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

## Gotchas
- **stdout is the MCP wire** — handlers/log must never `console.log` to stdout (use `ctx.log` → stderr).
- **mechanics, not strategy** — if you find a `SKILL.md` revealing the answer/playbook, that's a bug; fix it
  (the engine must *learn* the strategy).
- **fresh process per CLI call** — `node bin/cli.mjs <wl> <tool>` does not carry case state between calls;
  the long-lived MCP server (and `--selftest`) do.
- **MCP servers run unsandboxed** by design (`docs/security/exec-sandbox.mdx`) — treat each as a trusted
  dependency; these are local test fixtures, no network/disk.
