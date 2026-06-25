# 02 — DISCIPLINE: prime directives · the fix-verify loop · scoring · stop condition

## Prime directives (non-negotiable)
1. **A false success is the worst outcome.** Before optimizing for success, make the system tell the *truth* about failure. A run that silently claims "done" while broken gets fixed first.
2. **Diagnose from evidence, not hypotheses.** Read the trajectory / `explain` / `fleet` / DB. Never patch a cause you have not observed.
3. **One root cause per iteration, fixed test-first.** Write a RED test reproducing the *live* failure shape (use the real payload from the trajectory), then make it GREEN. Expect a *chain* of causes — each fix unblocks the next.
4. **Verify against ground truth, not the surface.** The real artifact usually lives somewhere other than the reply — on disk, in a queue, in `memory.db`, in the emulator's recorded outbound. Find it. Use **two oracles** (`03-OBSERVABILITY.md`).
5. **Stop when the success predicate holds** — defined concretely per test — and not before.
6. **Every system issue you observe is in scope — target-related or not.** A live run drives the whole daemon. A broken core tool, a mis-gated RPC, a degraded provider, a silent substitution, an unexplained ERROR/FATAL — fix it test-first under this same loop the moment you see it, even if it has nothing to do with the target. When a fix is genuinely nuanced/security-sensitive/out-of-budget, that does **not** mean drop it: capture a **documented finding** (verdict + `file:line` evidence + the precise fix direction + a recommended focused follow-up). The bar is "fully diagnosed and either fixed or pinned," never "ignored because it wasn't the target."

**Pass bar (every test):** **works** (predicate verified in ground truth) **or fails honestly** (truthful, reason-coded, names the missing knob / real cause). **False success = hard failure.** Security/honesty assertions are **binary HARD**.

---

## The fix-verify loop (THE discipline — apply per issue)

> **Per issue: run forward → stop at the first failure → fix it test-first → wipe logs + memory + test sessions → rebuild + clean-restart → reproduce on the clean slate → confirm it works → only then continue. One issue fully closed before the next.**

⛔ **The anti-pattern this exists to kill (the #1 observed deviation): running the whole plan, collecting a pile of failures, and fixing them all at the end.** That is forbidden — it contaminates every later test (they run on the still-buggy system, so a "pass" may be masking an unfixed earlier bug), and no fix is reproduced on a clean slate. **The invariant is structural: ≤ 1 open COMIS-FAIL at any moment.** A COMIS-FAIL is *open* until it is either CLOSED (fix → clean-slate → reproduce → confirm) or DOCUMENTED-as-a-finding; you may not drive the next test while one is open. "Note it and keep going / fix them at the end" is the failure mode, not the discipline.

1. **Run forward** through the plan in order until a predicate fails (or a HARD oracle trips).
2. **Stop at the first failure.** Do not pivot to another test. Do not batch *guessed* causes.
3. **Diagnose in order** (`03-OBSERVABILITY.md` read-order): outcome/lifecycle → per-unit rollups → raw evidence. Form **one** evidence-backed hypothesis. **Attribute correctly** — the trace you read must belong to the *failing* unit, not a sibling (the usual trap in multi-agent / sub-agent / group flows).
4. **Fix one root cause, test-first.** Write a RED test in `packages/*/src/**` that fails on pre-patch code and reproduces the *live failure shape*; then patch to GREEN. (Markdown / skills / docs / config are test-exempt; production source is **not**.) Update `docs/**/*.mdx` in the **same change** if you altered anything they describe (Docs-Current).
   - **Composition-root / wiring gaps** (built-but-not-wired) are usually only catchable by a **source-guard arch test** (`test/architecture/*-wiring-guard.test.ts`, the `audio-wiring-guard.test.ts` pattern) — the handler's own unit test stays green while the live wiring is missing. Use it.
   - **A bug is often a LAYER MISMATCH** (two subsystems disagreeing), not a defect at the site that throws. Read the docs/design for the *intended* behavior, trace the mechanism **end-to-end across every layer**, and fix the **authoritative** layer — never a parallel guard/allowlist at a convenient layer that hides the symptom and leaves the layers inconsistent (the reverted `ADMIN_DEAD_MANAGE_TOOLS` denylist that hid the dead admin tools instead of reconciling the deny-by-origin/trust layers). See **AGENTS.md §2.11**.
5. **Review the fix against the cause:** does it make the observed failure *impossible*, or just silence the test? If you can't explain how the next production occurrence is prevented, you fixed the symptom — keep going.
6. **Clean slate** (`01-SETUP.md §5`): wipe logs + LCD/`memory.db` + the test session/agents/jobs you created.
7. **Rebuild + clean-restart** and **prove you're running the new code** — a live process holds the old `dist/` in memory.
8. **Reproduce on the clean slate** — drive the *same* failing test again from zero.
9. **Confirm** the predicate now holds **against ground truth (both oracles)**, *and* that a forced failure still **degrades honestly** (both branches).
10. **Close the observability gap, if any** (`03-OBSERVABILITY.md §obs-loop`). If diagnosing needed a raw-log grep / a hand-join / any evidence not already in `explain`/`fleet`/the trajectory, that gap is itself an issue — close it **test-first** before moving on.
11. **Re-run any test the fix could regress**, then resume forward progress.

**Batching rule (NARROW — not a license to defer).** The ONLY sanctioned batching: when a SINGLE already-completed expensive drive (a 15–25 min small/local-model turn) surfaces several distinct issues *at once*, write the test-first fix for each, rebuild once, THEN clean-slate + reproduce + confirm before the next drive. That is it. It does **not** license driving further tests to collect more failures, and it does **not** license fixing at the end of the run — those are the #1 deviation above. Batching *fixes from one drive* is fine; batching *guesses*, or batching *across drives / to the end*, is forbidden. When in doubt, the default wins: **stop at the first failure.**

**Fix-now vs document-as-finding (the prime-directive-#6 judgment call).** #6 says fix test-first OR capture a documented finding — the rubric for WHICH:
- **Fix-now** when ALL hold: the fix is **contained** (≲2 production files), it does **not** touch a load-bearing/security path you'd risk regressing, and a clear **RED test reproduces the live shape**. (This session: MD-02 `memory_store` and the `lease.revoke` count bug — both contained, clear RED → fixed test-first.)
- **Document-as-finding** (verdict + `file:line` + fix-direction + RED-test shape → a focused follow-up branch, logged in `runs/FINDINGS-LEDGER.md`) when it is **structural** (threads a new field/event through ≥3 layers, a new trajectory/report section), **security-sensitive** (the obvious gate fix is often wrong — `03 §recurring-defect-classes`), or the **HARD oracle already passed** so it's obs/honesty *quality* not a correctness failure. (This session: the P0-A budget-attribution obs gap — 5-file, load-bearing, OE-H1 passed → documented.)

**Document-as-finding is the EXCEPTION, not an escape hatch.** Most COMIS-FAILs are contained → fix-now. If you catch yourself documenting failure after failure just to keep driving, you are doing the #1 deviation — stop and fix. A documented finding is **never** a silent drop — it enters `runs/FINDINGS-LEDGER.md`, is re-checked at the next run's STEP 1, and it counts as *closing* the open COMIS-FAIL (so the ≤1-open invariant holds and you may proceed).

**Honest-exit makes the loop trustworthy.** `scripts/drive.mjs` returns an honest empty (`[NO SUBSTANTIVE ANSWER]`) on a no-reply, never a fabricated success. Branch your score on the captured ground truth + the daemon log, not on prose.

---

## Scoring — the 3-way classification engine (only COMIS-FAIL stops the loop)

Assert on **structure/state, not model wording**. **Re-run rule — distinguish the two oracle kinds (resolves the "≥3×" vs "prove once" tension):**
- **(a) content-/reliability-sensitive** — the model's output can vary turn-to-turn (recall quality, a synthesis verdict, an injection refusal, a small-model authoring success). Run **N≥3×**, clean-reset between, report **pass@k** never pass@1 — the tail is where the real defects hide.
- **(b) provider-independent code-path** — a deterministic gate/jail property that the same input drives identically (the bwrap egress block + env-scrub, deny-by-origin, a cap-gate refusal, an idempotency dedup, a budget bound). **Prove once** cleanly in ground truth; re-running 3× only re-exercises the same branch and burns budget. (The jail oracles are the canonical prove-once set — `05-CATALOG §3`.)

Litmus when unsure: *could a second identical run plausibly differ?* Yes → pass@k; no → prove-once.

- **OK** — predicate met (reply correct; round-trip artifact valid; for caching providers the cache hits: Anthropic `cache_read_input_tokens` grows turn-over-turn, OpenAI `cached_tokens` grows, Gemini `cachedContentTokenCount` constant).
- **NO-ACCESS** *(graceful gap — record + continue, NOT a Comis bug)* — the key lacks model access; a retired bare alias 404s (`claude-opus-4-0`, `gpt-5.3-codex` on openai-codex); an upstream catalog gap (`gpt-5-pro` rejects default `medium` effort); a **masked 4xx** on the openai-responses/google path; an absent media/search key surfaced through an honest-keyless error that **names the knob**.
- **COMIS-FAIL** *(real routing/logic bug → STOP, fix test-first)* — wrong provider/model resolved; a **chimeric** native-provider+foreign-model pairing; preflight context-exhaustion from a bad fail-safe window; a crash; a **false success**; a HARD oracle tripped; a silent degrade where an honest error was required.

**The three buckets above are the engine (only COMIS-FAIL stops the loop); these are the practical LABELS to record under them** (the RESULTS-LOG template uses these — keep the vocab consistent):
- **fails-honestly** *(an OK outcome — honest non-success)*: the capability is gated/absent/degraded but the system told the truth and named the knob (an honest-keyless error, an intended allowlist/permission denial, a degraded-but-honest abort). The opposite of a false success. **Not** a COMIS-FAIL.
- **coverage-gap** *(a NO-ACCESS — record, don't score pass/fail)*: the **rig** can't reach the oracle (no local provider; vision-input dead on a loopback rig; a provider-required oracle on the wrong provider). Log it `[coverage-gap: needs <X>]` + cite the unit test; never a silent omit (a missing row reads as "covered").
- **carried-reproduced** *(record + cross-ref, don't re-open the loop)*: a finding already in `runs/FINDINGS-LEDGER.md` re-confirmed at HEAD on this run — note "carried, reproduced" + the ledger id; do NOT re-discover or re-fix.
- **documented-finding** *(closes an open COMIS-FAIL without an immediate fix)*: the structural/security-sensitive/HARD-already-green case (`§Fix-now vs document-as-finding`) — verdict + `file:line` + fix-direction → the ledger. Counts as *closing* the open COMIS-FAIL (the ≤1-open invariant holds).

The deep tests assert the **POSITIVE path on the default (secure-by-default) config**. The negative controls (flip a default-ON feature OFF), mode flips, gated-off invariants, and always-on guards live in **Track M** (`05-CATALOG.md`). A toggle is "covered" only when **both** sides are green.

---

## Stop condition (all must hold before the run is "done")

1. **Every deep test** at **works** or **fails-honestly**; **zero false successes**; **all HARD oracles green** (injection-resisted / 0 secret-leak / SSRF-blocked / recipient-bound / no rogue autonomy / no fabricated tool output / trust filter held / over-refusal 0 / jail egress blocked / revoke halts a run).
2. **Track K** complete: every configured provider × model classified; **0 COMIS-FAIL** open; NO-ACCESS rows recorded with reason; the actual `modelId` == config on every OK row.
3. **Track L** walked: every RPC method, agent tool, CLI command, HTTP endpoint, channel, media provider, content gate exercised + classified; admin-gated methods reject non-admin.
4. **Dual-oracle clean:** for every channel test the channel oracle (recorded outbound) and the Comis oracle (`delivery_mirror`/trajectory) agree; no divergence open.
5. **Logs clean:** no unexplained ERROR/FATAL in the active daemon log on a final clean pass; every WARN accounted; `fleet` degraded sessions all map to *intentional* failure-injection tests; **no secret/canary residency** anywhere (logs + trajectory + `memory.db`).
6. **`pnpm validate` green** on the fix branch; the live suites green for what you touched; **test-only config mutations restored** (config snapshot diff = intended only); the daemon left **running healthy on the fixed build**.
7. **Reliability:** every reliability-sensitive test reported as **pass@k**; long-horizon drift tests run long enough to be meaningful.
8. **Observability loop closed** (`03`): every diagnosis friction is fixed test-first (the missing signal threaded to `explain`/`fleet`, proven on the original incident) or a dated TODO naming the incident.
9. **Track M two-sided:** every behavior-changing toggle covered on both polarities; every relaxed security default *surfaced* the relaxation (no silent relaxation).
10. **Emulator loop closed** (`03`): every capability the rig couldn't drive/observe is closed test-first (the Bot API method / inbound shape / verb / fault / oracle field added) or a dated TODO — with the emulator's own unit+contract tests green and **no `@comis/*`/`bundledDependencies` edge added**.
11. **System-health sweep done** (`03 §system-health-sweep`): `fleet` triaged + the daemon log scanned with precise filters + a basic agent tool driven; every real issue found (target-related or not) is **fixed test-first or a documented finding** with verdict + evidence + fix direction. No unexplained ERROR/FATAL, broken core tool, or mis-gated RPC left un-triaged.

## Budget & safety envelope

- **Stage-B (emulator, keyless local):** `$0`, fully isolated (throwaway data dir, loopback-only, a fake chat that cannot reach a real account; destructive tests hit the daemon's sandbox in the temp dir). Unlimited sends.
- **Stage-C (VPS, real keyed providers / real channel):** keyed turns cost real money (batch diagnoses; track via `obs.billing.*`). On the shared VPS: at most **ONE** self-identified real-channel send for the final confirm; never touch the operator's session/projects; verify state before any destructive op; **always restore `config.yaml` + restart at the end**; **stay in `encrypted` storage**.
- **What still needs a human:** the final real-channel confirm; reviewing/merging the agent's fixes (branch-first + PR per `CLAUDE.md` — commit/push only when asked).
