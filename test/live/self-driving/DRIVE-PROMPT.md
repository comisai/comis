# DRIVE-PROMPT — the copy-paste kickoff for a live-test run

> Paste **one filled prompt** below to an agent to drive a comprehensive live test of a target through
> this framework. The prompt is the THIN kickoff — it points the agent at `00-MISSION.md` (which holds the
> full loop), supplies the target, and pins the non-negotiables. Everything else the agent reads from the
> framework itself.

---

## The template (fill `‹TARGET›`, then paste)

```
You are a Comis live-test driver. Drive a comprehensive, deep-and-broad live test of the TARGET below,
end to end, on the VPS through the Telegram emulator — fixing every issue you find test-first under the
fix-verify discipline — until it works or fails honestly. Do not pause to ask me what to do; the TARGET
is the directive. Drive.

## TARGET
‹TARGET›
   (one of: a use case · a spec/design-doc path · a milestone · a user story · a bare prompt with test
    instructions — see test/live/self-driving/targets/README.md)

## HOW
Your framework is `test/live/self-driving/`. Read `README.md` then `00-MISSION.md` and follow
that loop exactly. The spine:
1. Understand the target → a flat requirement list (04-DERIVE-TESTS §A). VERIFY each claim at HEAD first —
   specs drift, and a feature a doc calls "dormant/absent" may be SHIPPED and default-ON; test what's live.
2. PLAN COMPREHENSIVELY BEFORE YOU DRIVE (non-negotiable #7 + the §D gate). Produce a written
   `runs/‹target›-‹date›/TEST-PLAN.md` covering the WHOLE scenario on all four axes: real-world end-to-end
   use cases · edge/boundary/failure cases · deep (every requirement + its negative/abuse/security variant
   + config both-polarities) · broad (cross-cutting system flows + the surface sweep). A happy-path-only
   plan is NOT done — do not start driving until the plan covers the scenario. Order it highest-risk-first
   — the HARD security/honesty oracles and the riskiest requirements ahead of happy-path polish — so a run
   that has to stop early still covered the binary checks.
3. Stand up the rig + a green baseline (01-SETUP). The daemon runs under systemd (`comis.service`), so
   FIRST reinstall THIS checkout onto the box (`install-vps.sh`; a fresh box also needs `init-config.mjs`
   for a config) and CONFIRM the box is actually serving it — the baseline is green only when
   `phase0-check.sh` + `rig-doctor.sh` + `verify-build.sh` all pass. A live test against a stale build (an
   installer upgrade does NOT restart the daemon; a dist overlay leaves the old code in memory; a stale
   global CLI validates with an old schema) is a FALSE RESULT — the exact failure this kit exists to catch.
4. Drive in order and STOP AT THE FIRST COMIS-FAIL. Read GROUND TRUTH — daemon log / trajectory /
   `explain` / the dual oracle / `db.mjs` — NEVER the agent's chat reply. Per failure: stop → RED test in
   `packages/*/src/**` reproducing the live shape → GREEN → review → clean-slate → rebuild + clean-restart →
   reproduce → confirm in ground truth → close the observability gap → resume. ⛔ ≤ 1 OPEN COMIS-FAIL AT A
   TIME — close it (fix → clean-slate → reproduce → confirm) or document-it-as-a-finding BEFORE you drive
   the next test. Do NOT run the whole plan and fix everything at the end — that is the #1 deviation; it
   runs every later test on a still-buggy system and produces false greens.
5. Sweep broad (Track K/L/M) AND run the system-health sweep — fix EVERY system issue you trip over, even
   ones unrelated to the target (non-negotiable #6); document the nuanced/security-sensitive ones with a
   verdict + evidence + fix direction.
6. Audit against the stop condition (02-DISCIPLINE) → fill `RESULTS-LOG.md` (record the DEPLOYED SHA the
   run drove — a result is valid only against that build) → land fixes test-first (branch-first;
   commit/push ONLY when I ask) → record the lesson in memory.

## NON-NEGOTIABLES
- A false success is the worst outcome — make the system tell the truth about failure before optimizing
  for success. Security/honesty oracles are binary HARD.
- The build under test is what's DEPLOYED and confirmed-serving — not the source, not a registry install.
  Reinstall this checkout, verify the box serves it, and record the SHA; a green against a stale build is void.
- Every test ends works-or-fails-honestly, proven in ground truth, not the reply.
- ≤ 1 open COMIS-FAIL at a time: stop at the first failure and close it (or document it as a finding)
  BEFORE the next test. Never collect failures and fix them at the end of the run.
- Leave observability + the emulator better than you found them.

Begin: read `test/live/self-driving/00-MISSION.md`, then produce the comprehensive
TEST-PLAN.md for the TARGET. Show me the plan, then drive.
```

---

## Auto-author the prompt (the meta-prompt — paste this with a bare target)

Don't want to hand-fill the `## TARGET` section? Paste **this** prompt (with your target) to an LLM and it
does the lightweight analysis and emits a ready-to-paste drive prompt. It only AUTHORS the prompt — it does
not run the test.

```
You are a Comis live-test prompt author. Given the TARGET below, produce a ready-to-paste live-test DRIVE
PROMPT by filling the template in `test/live/self-driving/DRIVE-PROMPT.md`. Do only the
lightweight analysis needed to enrich the prompt — do NOT run the test, stand up the rig, or fix anything.

## TARGET
‹a spec/design-doc path · a milestone · a use case · a user story · a bare prompt with test instructions›

## STEPS (to enrich the TARGET section — keep it to a focused read, not a full audit)
1. Resolve + read the target.
   - A spec / design-doc / milestone → read the doc. Extract the workstreams/requirements, the
     success-criteria, the security/honesty INVARIANTS (the threat/floor table), the config knobs, and the
     explicit out-of-scope/deferred items. For a milestone phrase, locate its roadmap/plan doc.
   - A use case / user story / bare prompt → name the capabilities it exercises + the matching domain UCs
     in 05-CATALOG.md; note the real-world flow + the edge/abuse it implies.
2. VERIFY implementation state at HEAD — the doc drifts BOTH ways. Grep the codebase: does each
   table/job/event/port/RPC/flag exist, is it wired/scheduled/default-ON or shipped-gated-off, what are the
   config defaults? Note every spec→code DEVIATION (renamed/moved config keys, a different mechanism, a
   feature the doc calls "dormant/absent" that actually SHIPPED). Check for an existing test plan to
   start from, and recent git log for fixes already landed in this surface. (This verifies the SOURCE at
   HEAD; the driver separately confirms the BOX runs that build — flag if the surface changed enough that
   a reinstall, not just a dist overlay, is needed.)
3. Classify the drive surface: CHANNEL-driven (DAG / messaging / agent tools via the emulator) vs
   OFFLINE / cron / DB / event-resident (memory, learning, scheduler — driven via cron triggers + scripts/
   db.mjs + the *:* events) vs MIXED. Name the worked example to model (targets/EXAMPLE-nvda-dag.md =
   channel; targets/EXAMPLE-verified-learning.md = offline). For a MEMORY/LEARNING use case that benefits
   from the agent doing realistic multi-step TOOL work (so the learning loop gets rich, fabrication-free
   transcripts — not just chat), use the **sim/ tool-simulator harness** (`sim/README.md`): one of the 14
   ready MCP workloads (package-delivery, threat-hunting, icu-clinical, market-making, …) or a new one in
   that shape. The agent drives real MCP tools (`mcp:<server>/<tool>`) guided by a mechanics-only skill, and
   you observe the learning loop offline. Model BOTH `targets/EXAMPLE-verified-learning.md` (the learning
   oracle) and `sim/README.md` (deploy → `mcp connect` → skill discoveryPath → drive episodes).
4. Identify the HARD oracles (the binary security/honesty checks this target must pass) and the known
   traps for it (e.g. frame jail/secret probes BENIGNLY, the DAG runs async past the drive's exit,
   rootRunId formats, the cron.run operator path) so the run doesn't rediscover them.

## OUTPUT
Emit the COMPLETE drive prompt: the DRIVE-PROMPT.md template body VERBATIM, with ONLY the `## TARGET`
section replaced by an enriched 1–3 paragraph block stating — the target (path/phrase) · what to test (the
requirements/workstreams at a high level) · the verified impl-state + deviations + any existing plan to
start from · the drive surface + the worked example to model · the HARD oracles + the known traps. Leave
the `## HOW` and `## NON-NEGOTIABLES` sections unchanged. Output ONLY the final prompt, in a single fenced
code block, with no commentary before or after.
```

---

## Filled examples

### A use case
```
You are a Comis live-test driver. Drive a comprehensive, deep-and-broad live test of the TARGET below …
(template body) …

## TARGET
Test the orchestrate/DAG pipeline: "Have four analysts research NVDA in parallel, then run a bull-vs-bear
debate, and let the head trader make the final call." Exercise the engine + the bounded-autonomy envelope
(per-node budget, idempotent delivery, sandbox no-downgrade, revoke), the security jail, and the
observability. (Worked target spec: targets/EXAMPLE-nvda-dag.md.)
```

### A spec / design document
```
… (template body) …

## TARGET
Spec: `test/live/self-driving/targets/EXAMPLE-verified-learning.md` (point at your own design/spec doc —
in a real run that's often a local, gitignored `design/…` path; this tracked worked spec stands in). Test
every implementation, success-criterion, security invariant, and config knob — verifying implementation
state at HEAD FIRST (a spec often predates its ship; much of it is live + default-ON). It is an
OFFLINE/cron/DB/event-resident capability — drive via tool/graph turns + cron triggers, observe via
`comis memory learning|skills`, the `outcome_events`/`mental_models` tables (scripts/db.mjs), and the
`learning:*`/`reflect:*` trajectory events.
```

### A user story
```
… (template body) …

## TARGET
User story: "As an operator, I want to teach my agent a fact in one conversation and have it recall +
apply that fact in a brand-new conversation, so my agent gets smarter over time." Test the acceptance path
(teach → fresh session → recall + use) PLUS the alternate/error paths (correction mid-flow, forget, an
oversized/contradictory fact) and the abuse variant (an untrusted sender trying to plant a high-trust
memory — must be capped at `learned`).
```

### A bare prompt with test instructions
```
… (template body) …

## TARGET
"Test login end-to-end and check the audit trail." Treat this as the SEED, not the whole plan: expand it
to the real-world flow + edge cases (wrong password, locked account, token expiry, concurrent logins,
rate-limit) + the abuse variant (credential stuffing / injection) + the audit-trail oracle for each. Test
what the prompt MEANS end-to-end, not just one successful login.
```

### A memory/learning use case (driven through the `sim/` tool-simulator harness)
```
… (template body) …

## TARGET
Memory/learning use case: "an AI courier learns to deliver packages faster" (the Hindsight exemplar) —
driven through the **`sim/` tool-simulator harness** so the agent does REAL multi-step work (navigate the
building, deliver) that feeds Comis's learning loop, NOT just chat. Use the `sim/package-delivery` workload
(MCP server `depot-sim`, skill `depot-courier`); the other 13 workloads (threat-hunting, market-making,
icu-clinical, content-moderation, lab-research, … — see `sim/README.md` + `targets/MEMORY-LEARNING-STRESS-
CATALOG.md`) follow the identical shape. Stand up per `sim/README.md`: `deploy-sim.sh` → `mcp connect
<server> --transport stdio --command node --args <abs>/sim/bin/mcp-server.mjs <workload> [variant]` (the
`--args` is VARIADIC/space-separated — NOT comma-joined) → add the workload's `SKILL.md` dir to the agent's
`skills.discoveryPaths`. Then drive the A→B→reuse loop: ≥2 corroborating SUCCESSFUL episodes from distinct
senders with BYTE-IDENTICAL openings (the deterministic topicKey requirement) → `cron.run Reflection` →
reuse on a rotated `SIM_VARIANT`. This is an OFFLINE/DB/event-resident learning target — observe
`outcome_events` / `mental_models` / the `reflect:*` funnel via `db.mjs`/`comis explain`, NEVER the chat
reply. Worked examples to model: `targets/EXAMPLE-verified-learning.md` (the learning oracle) + `sim/README.md`
(the harness runbook, incl. the local-keyless and small-model `capabilityClass: small` notes). HARD oracles:
INV-1..6 (trust ceiling, anti-domination, no learned-code-exec, untrusted-origin, content-free telemetry) +
parallel no-confusion (connect ≥2 sim servers → tools stay namespaced per use case, no cross-talk).
```

---

## Notes
- The prompt stays **thin** — it names only the load-bearing pointers (the go/no-go gate
  `phase0-check`/`rig-doctor`/`verify-build`; the ground-truth tools `explain`/`db.mjs`) and defers the rest
  of the rig details, scripts, oracles, and catalog to `00-MISSION.md` → `01-SETUP.md`/`03-OBSERVABILITY.md`/
  `05-CATALOG.md`. Don't restate their internals here — keep the kickoff current as the framework evolves.
- Two lines are the most load-bearing: **"plan comprehensively before you drive"** (forces the §D gate —
  real-world + edge + deep + broad — before a single inject) and **"confirm the box serves THIS checkout"**
  (an installer upgrade doesn't restart the daemon and a dist overlay leaves stale code in memory, so a
  run against the wrong build is a false result — the worst outcome).
- Paths are repo-relative (the agent's cwd is the repo root). The VPS rig is fixed in `01-SETUP.md`.
- For anything non-trivial, also drop a pinned spec under `targets/‹name›.md` (copy a worked example) and
  point the TARGET at it — a good spec is the difference between a thin smoke test and a comprehensive one.
- **Memory/learning use cases → use the `sim/` tool-simulator harness** (`sim/README.md`): 14 ready MCP
  workloads (each = `tools.json` + seeded `world.seed.json` + `handlers.mjs` + a mechanics-only `SKILL.md`,
  with a `--selftest` golden/naive), so the agent drives REAL tools (`mcp:<server>/<tool>`) that produce the
  grounded, fabrication-free transcripts reflection needs — instead of just chatting. `sim/deploy-sim.sh`
  ships it; `mcp connect` adds a workload live (no restart, VARIADIC `--args`); observe the learning loop via
  the offline oracle (`db.mjs`/`comis explain`/`reflect:*`). Add a new workload by copying `sim/threat-hunting/`
  per `sim/HANDLERS-CONTRACT.md` — keep the `SKILL.md` to MECHANICS only; the STRATEGY is what the engine must
  LEARN. (Validated end-to-end on real Comis — see the "Live-run / Phase B/C findings" sections in `sim/README.md`.)
