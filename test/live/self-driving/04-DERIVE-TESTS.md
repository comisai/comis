# 04 — DERIVE TESTS: turn ANY target into a deep + broad test matrix

> The generic engine. Input: **any target** — a use case, a milestone, a spec / design doc, a **user story**, or a
> **bare prompt with test instructions**. Output: a **comprehensive** `TEST-PLAN.md` where every row is
> `id · requirement · Drive · Predicate · Ground-truth oracle · HARD? · Stage`. The same method scales from
> "test one feature" to "test a whole milestone" — and in **every** case the plan must cover the **whole
> scenario** (real-world use cases + edge cases + deep + broad) **before any driving** (`00-MISSION.md`
> non-negotiable #7 + the §D gate below).

## A. Extract requirements from the target

### A1. Target = a USE CASE (a scenario/prompt)
"Test the DAG pipeline" / "memory recall across sessions" / "STT round-trip".
1. Name the **capabilities** it exercises (cross-reference `05-CATALOG.md §domains` + the catalog's UC table — find the matching UC and start from its predicate/oracle).
2. Enumerate the **happy path** + the variants that matter for THAT capability:
   - **edge**: empty / huge / malformed input; the boundary (the oversized-context, the position-limit, the quota edge);
   - **abuse/negative**: the adversarial version (injection, exfil, a runaway, a spoof) — every capability that takes untrusted input or acts outward gets a HARD oracle;
   - **reliability**: re-run N≥3× → pass@k if content-sensitive.
3. Add the **config postures** that change this capability's behavior (the toggle both-polarities — `05-CATALOG.md §Track-M`).

### A2. Target = a MILESTONE (a named release / feature set)
1. Locate its source: grep the roadmap/plan for the milestone name. The roadmap/plan lists **phases → requirements → success-criteria**.
2. Each **requirement + success-criterion** is a test row. Each **security invariant** is a HARD oracle. Each **config knob** the milestone adds is a Track-M pair.
3. Cross-check any prior milestone-coverage audit — if it flagged a GAP for this milestone's capabilities, cover it.
4. Add the **regression slice**: the surfaces this milestone touches still work for the *previous* behavior (a "no silent break" check).

### A3. Target = a DESIGN DOCUMENT (a path)
1. Read it **fully**. Extract every: **implementation** ("X does Y"), **success-criterion** (the doc's own acceptance list — these are gold; they're pre-written predicates), **security invariant** (the threat/floor table), **config key / default**, and **out-of-scope** statement (don't test what's deferred).
2. **Verify each claim against HEAD before trusting it — the doc lies in BOTH directions.** A draft/spec drifts: (a) a claim marked "existing" the code removed/moved (the doc's anchors are evidence, not contracts — `grep -rn`, read the seam); AND (b) — the one that bites hardest — a feature the spec calls **"NEW / dormant / absent / not wired"** that has since **SHIPPED and is DEFAULT-ON**. *For example, a learning subsystem's spec marked its proposed workstreams as future proposals; at HEAD they were all implemented, wired, and the per-agent flags defaulted `enabled:true`.* So before deriving tests, **establish the real implementation state** (a focused codebase scan: does the table/job/event/port exist, is it scheduled/dispatched/called, what are the config defaults) and test what's LIVE — testing the doc's stale prose wastes the run. A claim either way the code contradicts is itself a finding.
3. Map each **live** implementation → a test that drives it (channel turn, RPC, or the offline trigger per §B) and reads ground truth. Map each invariant → a HARD oracle driven adversarially (or benignly-but-deterministically per `03 §benign probes`). Out-of-scope/deferred items: don't test; absent-but-claimed-shipped: a finding.

### A4. Target = a USER STORY
*"As a `<role>`, I want `<capability>` so that `<outcome>`."*
1. Each **acceptance criterion** is a requirement (a predicate). The **"so that `<outcome>`"** is the real-world end-to-end test — drive the whole flow a user would, multi-turn, in context (not one isolated call).
2. Enumerate the **alternate + error paths** the story implies — missing/invalid input, the provider down, the user correcting mid-flow, a concurrent actor — these are the edge cases.
3. Add the **abuse variant** (the story exercised by a hostile/untrusted actor → a HARD oracle) + the config postures that change the outcome.

### A5. Target = a BARE PROMPT WITH TEST INSTRUCTIONS (the user hands you the scenario + what to check)
1. The prompt is the **seed, not the plan.** Expand it: what real-world end-to-end use case does it imply? what edge/boundary/failure cases? what deep variants (negative/abuse/security) + broad cross-cutting flows?
2. **Test what the prompt *means*, not its literal words.** ("Test login" means: happy login + wrong password + locked account + concurrent + token expiry + the audit trail + the rate-limit + the injection attempt — not one successful login.)
3. The instructions are the must-pass **core**; surround them with the implied edge + deep + broad matrix so the whole scenario is covered.

## B. The DEEP axis (per requirement)

For each requirement, write the row **before driving**:
- **Drive** — the exact inject (a `drive.mjs` prompt, or an RPC via `revoke.mjs`, or a config flip + restart). Channel-shaped → drive through the emulator; non-channel platform op → the gateway RPC.
- **Predicate** — the works-bar, on **structure/state not wording**: "this tool ran (audit row exists), this `delivery_mirror`/`outcome_events`/`learned_skills` row exists, this file was written with these bytes, this node completed, this denial was emitted." Pick something you can read in ground truth.
- **Ground-truth oracle** — *where* the real artifact lives (trajectory event, DB row, workspace file, daemon-log line, the recorded outbound). Name it now so you don't fall back to a raw grep later.
- **HARD?** — if the requirement is a security/honesty invariant, the predicate is **binary** (leaked / not-leaked, blocked / reached, halted / ran-on). No partial credit. Run ≥3×.
- **Stage** — B (keyless/local, $0, unlimited) or C (real keyed provider / the single real-channel confirm).

**Predicate recipes (the common shapes):**
- *Tool ran* → trajectory `tool.result` + the per-cap audit row (`{capability,tool,decision}`).
- *Reply delivered* → `delivery_queue` terminal `delivered` + a `delivery_mirror` row + dedupe (`idempotency_key`, no dup) + the dual-oracle cross-check.
- *Memory recall* → a fresh-session turn recalls it (cross-session LTM, not LCD) + `memory.db` counts reconcile; correction supersedes; "forget" clears both vec+fts; abstain is honest (no fabricated citation).
- *Multi-step/DAG* → the graph reaches terminal; per-node completion; the synthesis is grounded; bounded by budget/ceiling; the spawn-tree in `explain`.
- *Secret/exfil (HARD)* → **zero residency** in the reply AND logs AND trajectory AND `memory.db`; the refusal is truthful.
- *Honest-keyless* → the error **names the missing knob**; zero false success.
- *Offline / cron / learning (not channel-shaped)* → the **Drive** is a tool/graph turn the job consumes, or a cron run (`cron.run {id}`; the system crons are `cron.list`-visible rows) — NOT a chat reply; the **oracle** is the DB (`scripts/db.mjs` on `outcome_events`/`learned_skills`/`tuned_alpha`/`memory_usefulness`/`memories`) + the CLI obs (`comis memory learning|skills`) + the `learning:*`/`memory:*` trajectory events. DB-resident HARD invariants read straight from the schema (`db.mjs schema <t>` → a `CHECK` constraint; `db.mjs cols <t>` → a present/absent column). See `03 §offline-oracles`. **Verify the capability is actually live at HEAD first** (it may be shipped + default-ON even when the spec says "dormant").

## C. The BROAD axis (cross-cutting, after the deep rows)

- **System-level UCs** — the end-to-end real-world flows that span capabilities (the `05-CATALOG.md §UC-catalog`: develop-a-complete-app, the long-session marathon, verified-learning A→B, the multi-agent debate). Run the ones the target plausibly touches; these catch integration bugs the per-requirement tests miss.
- **Track K (providers × models)** — if the target touches model resolution / a new provider path / caching: sweep every provider × catalog model (`scripts/models-sweep.sh`), classify, verify `modelId`==config.
- **Track L (surface completeness)** — if the target ships RPC methods / tools / CLI / endpoints: smoke-call each + classify; admin-gated reject non-admin.
- **Track M (config combinations)** — every behavior-changing toggle the target adds, both polarities; modes booted per value; relaxed security defaults must surface.

## D. Comprehensiveness GATE (mandatory before STEP 3 — `00-MISSION.md` non-negotiable #7)
**The plan is drive-ready only when it covers the WHOLE scenario on all four axes.** If any axis is empty for a capability the target exercises, the plan is **not done — do not start driving.**
- **Real-world** — ≥1 **end-to-end** use case per major flow: how a user *actually* exercises it (multi-turn, in context, with the surrounding setup/teardown), not a single isolated call. The "develop-a-complete-app" / "long-session marathon" / "the canonical demo" shapes (`05-CATALOG §UC-catalog`).
- **Edge** — empty / huge / malformed / boundary / quota / concurrency / **failure-injection** for every input-taking or stateful capability the target touches.
- **Deep** — every requirement → ≥1 row; every capability category → ≥2 rows (happy + edge/abuse); every untrusted-input or outward-acting capability → a **HARD** oracle; every config knob → a **Track-M both-polarities** pair; every claimed mechanism → **verified at HEAD**.
- **Broad** — the cross-cutting **system-level UCs** + the **surface sweep** (Track L, incl. L8 origin-gating) the target plausibly touches.
- **Fifth axis (§D2)** — the six classes a functional predicate cannot see: latency regression · resource
  leak / long-run decay · upgrade-migration breakage · cost regression · first-run experience ·
  concurrency. Latency and cost are mechanical (record a baseline, diff it) and belong in **every** plan.

### D2. The FIFTH axis — defect classes a functional drive structurally cannot see

The four axes above all ask *does it do the right thing once*. Six production defect classes answer "yes"
to that and still reach customers, because nothing in a pass/fail predicate looks at them. For each: if the
target plausibly touches it, plan a row; if not, say so. **Every one of these has reached a real user in a
system whose functional tests were green.**

| class | why a green run misses it | the row that catches it |
|---|---|---|
| **Latency regression** | `durationMs` is recorded but compared to nothing, so a turn that went from 8s to 40s still "works". Users experience that as broken. | Capture per-turn `durationMs` for a fixed set of representative turns and **diff against the previous run's numbers**. A >2× move with no explanation is a finding, not noise. |
| **Resource leak / long-run decay** | The longest arc is a simulated multi-day thread inside one process-hour. Memory growth, fd and tmux orphans, unbounded table growth only show up after hours. | One sustained soak: keep the daemon up under periodic load, then compare RSS, fd count, orphan processes and DB size against the start. State the duration — a 10-minute "soak" proves nothing. |
| **Upgrade / migration breakage** | The rig installs THIS checkout onto a clean or same-version box. It never boots the new build against a **populated data dir written by the previously released version**. The kit's own docs record that a leftover legacy config key FATALs the boot under `z.strictObject` — that is this class, found by accident. | Install the last released version, use it enough to populate config + `memory.db` + sessions, THEN upgrade in place and prove the daemon boots, the history survives, and no schema migration silently drops rows. |
| **Cost regression** | Cost oracles check whether the agent reports spend *truthfully*, never whether spend *grew*. A change that doubles tokens per turn passes every predicate. | Record cost-per-representative-turn and diff it against the previous run. Cache-hit rate belongs here too: a prefix change that silently stops cache reads is a pure cost regression with no functional symptom. |
| **First-run / onboarding** | The rig bootstraps config with a script, bypassing the real interactive setup a customer actually runs. So the highest-stakes ten minutes of the product are the least tested part of it. | Drive the real onboarding path on a genuinely fresh box at least once per release-shaped run, including the wrong-input branches (a too-short token, a bad key, an unreachable provider) — first-run defects are disproportionately abandonment-causing. |
| **Concurrency / races** | The drive rule is "one clean inject per turn" — correct for attribution, but it means sustained concurrency is never exercised. Races are also the class that pass@k variance hints at and a single run hides. | Sustained overlapping load from ≥2 senders across ≥2 sessions (`scripts/parallel-chat.mjs`), asserting isolation and no duplicate delivery *under overlap*, not just in sequence. |

Two of these — latency and cost — are **cheap and mechanical**: they need a recorded baseline and a diff,
nothing more. Their absence is the reason a run can be green while the product gets slower and more
expensive every release. Record both in the results log even when the target is not about performance.

Ordering: cheap regressions → expensive flows → mutating/destructive **LAST**. Scale to the ask (a one-feature use case needs only the slices it touches; a milestone/spec wants the full matrix) — but **never** skip an axis that applies. When unsure, lean comprehensive: the cases you leave out of the plan are the ones that break in production.

---

## Worked examples

### Example 1 — USE CASE: "test the orchestrate/DAG pipeline"
Requirements (derived): ORCH one-turn stdout-only · WEB daemon-side (real results) · DISPATCH cap-mapped routing · LEASE mint-per-root · AUDIT per-cap row · graph fan-out (N analysts ∥ → debate → trader) · BUDGET bounds a fan-out · REVOKE halts a live tree · JAIL egress-blocked (HARD) · env-scrub (HARD).
A few rows:
| id | Drive | Predicate | Oracle | HARD | Stage |
|---|---|---|---|---|---|
| ORCH-1 | "use orchestrate to web-search X, print RESULT:" | one jailed turn, stdoutBytes bounded, RESULT correct | trajectory `orchestrate run complete` + reply | — | B/C |
| JAIL-1 | benign in-jail `fetch('https://example.com')` probe | `NET:BLOCKED` (no egress) | drive.mjs stdout | ✅ | B/C |
| BUDGET-1 | lower budget, run the DAG | over-budget sub-agents `spend_exceeded`, fan-out bounded | daemon log + `explain` | ✅ | B/C |
| REVOKE-1 | launch DAG, `run.kill {rootRunId}` mid-flight | `{killed:N>0}`, sub-agents abort | revoke.mjs + daemon log | ✅ | B/C |

### Example 2 — MILESTONE: "Secure Agent Autonomy"
STEP 1 finds the milestone's design doc — a platform-foundation doc with ~56 reqs across its phases: CAP/ORIGIN/PROFILE/MIG · LEASE/ENDPOINT/JAIL · ORCH/DISPATCH/READ/WEB/REF · BUDGET/CEIL/RATE/QUOTA/REVOKE · SKILL · AUDIT/TREE/INTRO. Each req → a row; each "Security invariants must hold" → a HARD oracle; the profile resolver → a Track-M sweep (assistant/standard/unattended/max). The worked test plan for that milestone is the output of exactly this method.

### Example 3 — DESIGN DOC: a fresh design/spec document
Read it → its "Success criteria" list becomes predicates verbatim; its "Threat model" / "invariants" become HARD oracles; its config table becomes Track-M pairs; its "Out of scope" tells you what NOT to test. Verify each cited `file:line` at HEAD; test the actual behavior; write the plan; drive per `00-MISSION.md`.
