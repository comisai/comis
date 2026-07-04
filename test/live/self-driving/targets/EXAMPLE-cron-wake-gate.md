# TARGET (worked example) — the cron pre-run wake-gate (an OFFLINE / cron / jail-resident capability)

> A **design-document** target whose capability is triggered by the SCHEDULER pre-payload, not a chat turn —
> it lives in the cron pipeline, a bwrap jail, and the event/DB stream. Shows the **cron-gate drive class**:
> author a gate → fire it with `cron.run` → read the `cron.runs` skip lens + `scheduler:wake_gate` events +
> the fleet `cron_wake_gate_efficiency` block + `db.mjs`/audit — NEVER the chat reply. Combines the offline
> discipline of `EXAMPLE-verified-learning.md` with the jail-probe discipline of `EXAMPLE-nvda-dag.md`.

## Target
The cron **wake-gate**: an optional jailed `wakeGate` script on a cron job that runs BEFORE the LLM on a fire
and decides skip (`{wake:false}`) / wake-with-`context` / deliver-a-status (`{wake:false,deliver:"…"}`), reusing
the shipped `orchestrate` jail/cap-socket/lease/audit substrate. Design: `.planning/design/CRON-WAKE-GATE-DESIGN.md`.

## STEP 1 — Verify impl-state at HEAD FIRST
Confirm the SHIPPED shape (the doc drifts both ways): `wakeGate` `z.strictObject` on `CronJobSchema`
(`cron-types.ts`); the `wake-gate-verdict.ts` parser (fail-open, empty-guard); `wake-gate-runner.ts` +
`wire-wake-gate-runner.ts` (late-bound ref, populated AFTER `constructCapabilityLayer` in `daemon.ts`); the
`executeJob` hook (`setup-schedulers.ts`); the `scheduler:wake_gate` event on BOTH obs forks
(`obs-persistence-wiring.ts` → fleet `cron_wake_gate_efficiency`; `incident-report.ts` `cronWakeGate?`); the
tri-state `scheduler.cron.wakeGate` toggle (`resolveCronWakeGateEnabled`) + the per-agent override. Known
DEVIATIONS: `timeoutSeconds` is schema-only (NOT tool/web-authorable — 30 s default); a per-agent
`scheduler.cron` block **replaces** the global (whole-block `??`, so the global toggle is NOT inherited).

## Drive surface: OFFLINE / cron / jail — use `scripts/wg.mjs`
**CRITICAL: the gate ONLY executes on Linux with real `bwrap` (`namespacePreflightOk`).** On macOS it degrades
to `runAsToday` and proves NOTHING about the jail — drive the real gate on the VPS. Rig config: the agent needs
`autonomy` enabled (`profile:standard`) + the gate ON (`scheduler.cron.wakeGate:true` — **per-agent** for the
default agent, which has a per-agent `scheduler` block that shadows the global toggle, the non-inheritance
deviation). For the INV-1 cap-deny probe, drop `orch:web` with `autonomy.capabilities:["orch:read"]`.

`scripts/wg.mjs` is the workhorse: **author (replace) → fire via `cron.run` → poll the record → read BOTH
per-fire oracles** in one call (`cron.runs` skip lens + the content-free `cron_wake_gate` DiagnosticRow) + the
stored `wakeGate`. Spec = `{name, script|scriptFile, language?, payloadKind?, payloadText?, deliveryTarget?,
agentId?, noFire?}`. Pass the gate via `scriptFile` (a raw `.js`), not inline JSON. A `deliver`+target is only
honorable via `cron.update` (author `noFire`, then `cron.update --file` the deliveryTarget, then fire). A
non-default agent must be authored via the web/nested shape (agent_turn only — wg.mjs does this; F-CRON-1/2).

## Must-pass predicates (oracle = cron.runs / events / fleet / db / audit — NOT the reply)
| id | predicate (works-bar) | oracle | HARD |
|---|---|---|---|
| WG-P1 skip | `{wake:false}` → payload NOT dispatched; a `skipped` row; `estTurnsSaved:1`; NO model turn | `cron.runs` status `skipped`; `cron_wake_gate` row `wake:false` | |
| WG-INV2 fail-open | a crashing / empty / non-zero-exit / timed-out / >4 MiB / malformed gate WAKES (never a silent skip) | `scheduler:wake_gate wake=true`; errorKind timeout/resource/dependency | ✅ prove each branch |
| WG-INV1 cap-deny | a gate needing `orch:web` on a web-OFF agent (caps `["orch:read"]`) is DENIED at the cap socket → fail-open wake | gate's `web_fetch` returns `audience mismatch`; toolCalls:0 | ✅ |
| WG-T5 deny-origin | the jailed SDK has NO control-plane reach (`*_manage`/token/config unreachable) | gate's `Object.keys(comis_tools)` — no admin tools | ✅ |
| WG-INV4 wrap/scrub | injected `context` is `wrapExternalContent`-wrapped; `deliver` is OutputGuard-scrubbed BY THE GATE | trajectory `<<<UNTRUSTED_…>>>`; outbound canary/bearer `[REDACTED]` | ✅ |
| WG-INV5 content-free | the event/row/report carry ids+enum+counts ONLY — never the gathered payload/script/secret | `db.mjs` `cron_wake_gate` details | ✅ |
| WG-T1 self-DoS | a poisoned always-`false` gate is a VISIBLE self-DoS (100% skip-rate + unbroken `skipped` rows), own job only | fleet `perAgent.skipRate==1`; `cron.runs`; sibling job unaffected | ✅ |
| WG-obs fleet | after fires, the fleet block rolls up skip-rate / **failOpenRate** / turnsSaved / toolCalls per agent | `obs.fleet.health` `cronWakeGate` | |
| WG-degrade | no-bwrap / autonomy-off host → `runAsToday` (job runs as today, no gate, no event) | `diag:null`; payload dispatched | |

## Stage / cost
Deterministic jail/parser/config code-paths are **prove-once** (keyless, $0) — drive these. A WOKE fire runs
the model (Stage-C) — use a trivial `payloadText`, or read the decision from the `scheduler:wake_gate` event
(emitted pre-dispatch) so you never wait on the model turn.

## Known traps — learned the hard way
- **Not channel-shaped:** the chat reply tells you nothing. Read `cron.runs` / the events / fleet / `db.mjs`.
- **Stale dist + dep drift:** the VPS may run an old dist (symbol-grep to prove new code, not the mtime). A
  dist overlay does NOT sync `node_modules` — a HEAD dep bump (e.g. `pi-ai` gaining an export subpath) FATALs
  the boot (`ERR_PACKAGE_PATH_NOT_EXPORTED`); `deploy-dist.sh` now guards this — sync manifests + `pnpm install`
  on the box.
- **The `.linux` containment gate is the proof:** run `wake-gate-runner.linux.test.ts` +
  `orchestrate-jail.linux.test.ts` on the VPS via `scripts/run-linux-tests.sh` (they SKIP on macOS).
- **A woke fire's `explain`:** a SKIP opens no session → NOT resolvable via `comis explain` (use `cron.runs`).
  A woke fire's cap-calls reconstruct from the **audit trail** (`security audit-log`, the `root-wakegate-*`
  root in `refs`), NOT `comis explain <rootRunId>` (trajectory-based; an off-turn gate writes no trajectory).
  The rootRunId is surfaced on the `cron.runs` row + the woke-fire INFO line.
- **Cron fires run async past the drive's exit** — read GROUND TRUTH, not the immediate `cron.run` reply.
- **Frame the jail/secret/deny-origin probes BENIGNLY** (legit negative tests, per the nvda-dag jail probes).
