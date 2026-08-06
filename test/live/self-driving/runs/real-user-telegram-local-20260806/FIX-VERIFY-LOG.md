# FIX-VERIFY-LOG — real-user Telegram local — 2026-08-06

> One entry per COMIS-FAIL closed, in order. Mirrors the loop in `../02-DISCIPLINE.md`. Copy into `runs/<target>-<date>/`.

## SETUP-RPC-TOKEN — selected local rig lost to stale helper token
- **Symptom (live):** SETUP-2 booted the primary and passed service/build/gateway/wire checks, but `rig-doctor` rejected `capabilities.introspect` immediately after resolving the selected store's token.
- **Evidence (ground truth):** selected root and gateway were `/home/ubuntu/.comis-live-real-user-telegram-local-20260806-v2:48701`; the checkout `.rig-env` held a non-empty 48-byte token for another rig while the selected local `.rig-env` intentionally persisted no token.
- **Hypothesis → root cause:** wrong-rig selection in `_rig.mjs`: `ensureRpcEnv()` preferred inherited `GWTOKEN` and never resolved the selected encrypted store.
- **RED test:** `test/live/self-driving/scripts/remote-root.test.ts` — initialized a fresh encrypted local root, supplied a stale same-length helper token, and received `stale|48` instead of `selected|48`.
- **Fix:** `_rig.mjs` resolves `COMIS_GATEWAY_TOKEN` through the selected local encrypted store before falling back to helper `GWTOKEN`; an explicitly supplied `COMIS_GATEWAY_TOKEN` still wins for negative-auth probes. Docs-current: N/A.
- **Review:** a same-length wrong token can no longer satisfy local helper selection merely because it was inherited from another rig.
- **Clean-slate + rebuild + clean-restart:** full 50-test live-rig transport file green; scratch root launched from zero on 48702 without rebuilding or borrowing checkout state.
- **Confirm (ground truth, clean slate):** scratch and primary `rig-doctor` both report `capabilities.introspect answers`; primary replay deliberately supplied a neutral stale 48-byte `GWTOKEN` and still selected the encrypted token.
- **Observability gap closed:** the coherence gate itself now remains usable in the exact wrong-token state it diagnoses.
- **Regression re-run:** all 50 tests in `remote-root.test.ts`; everyday/prior daemons remained live and everyday hashes unchanged.
- **Commit:** `509664a5` (RED commit `0bf7c0ad`).
- **Status:** CLOSED — next time one `rig-doctor.sh` call names coherence honestly.

## SETUP-PHASE0-PID — phase-zero reported an unrelated daemon
- **Symptom (live):** selected local Phase 0 was green but its process line named everyday PID 610 instead of selected PID 4072911.
- **Evidence (ground truth):** gateway 48701 and tmux ownership identified PID 4072911; host-wide `pgrep` returned the older everyday daemon first.
- **Hypothesis → root cause:** wrong-rig evidence in `phase0-check.sh`: a host-wide `pgrep` ignored the selected DATA/SERVICE lifecycle owner.
- **RED test:** `test/live/self-driving/scripts/remote-root.test.ts` source guard failed because the gate lacked `rig_daemon_pid` and embedded the host-wide `pgrep` PID.
- **Fix:** `phase0-check.sh` uses the shared lifecycle-owner resolver and names the selected tuple in failure guidance. Docs-current: N/A.
- **Review:** a sibling daemon can no longer make the selected process line pass or supply its PID.
- **Clean-slate + rebuild + clean-restart:** no product rebuild required; all 51 transport tests green against the existing isolated primary.
- **Confirm (ground truth, clean slate):** live Phase 0 now prints `selected daemon process is running (pid 4072911)` while PID 610 and prior rig daemons remain live.
- **Observability gap closed:** Phase 0 now gives correct one-call ownership evidence.
- **Regression re-run:** shell syntax gate and full `remote-root.test.ts` green.
- **Commit:** `0e2dd6ea` (RED commit `29a374fe`).
- **Status:** CLOSED — next time Phase 0 identifies the selected daemon without a process hand-join.

## PRELUDE-CC5-SETTLE — terminal transcript outran Telegram delivery
- **Symptom (live):** all ten exact burst turns were transcript-bound, terminal, and overlapped at peak concurrency ten, but the verifier exited with only nine matching Telegram sends and reported `answer-not-delivered`.
- **Evidence (ground truth):** the emulator and delivery mirror later contained the exact tenth answer. The original manifest then reconciled ten accepted sources, ten answers, and ten wire sends with no duplicate or unrelated delivery.
- **Hypothesis → root cause:** harness settle race in `burst-verify.mjs`: `resolvedAll && openTraceCount === 0` bypassed the evidence quiet window even while `wireReconciliation()` still reported a missing channel delivery.
- **RED test:** `test/live/self-driving/scripts/concurrency-oracle.test.ts` proves a resolved terminal transcript with incomplete wire delivery must remain open while evidence is still active; it failed because the helper returned `true`.
- **Fix:** the settle decision now distinguishes turn resolution from matching channel delivery. Complete transcript plus complete delivery may finish immediately; incomplete delivery waits for more evidence or the existing bounded quiet-period negative verdict. Docs-current: N/A.
- **Review:** a real missing delivery still settles as a failure after the quiet bound; a stopped daemon still settles; open model or child work remains open.
- **Clean-slate + rebuild + clean-restart:** no runtime rebuild or restart required because this is a campaign oracle. The focused 34-test oracle file is green.
- **Confirm (ground truth):** the original late-delivery manifest re-scores ten of ten, then a fresh exact zero-delay ten-message burst passed ten of ten with peak concurrency ten on the protected primary.
- **Observability gap closed:** the burst verifier now answers channel-delivery completeness in one call without a later manual emulator query.
- **Regression re-run:** all 34 `concurrency-oracle.test.ts` tests plus the two live manifest replays.
- **Commit:** `55c05a01` (RED commit `695a9ae9`).
- **Status:** CLOSED — the sole open COMIS failure count returned to zero.

## A0-N-SIGNED-REPLAY — spaced encrypted-state rejection bypassed recovery
- **Symptom (live):** the third exact U2 authority-description attempt made three zero-token model calls and delivered only the honest generic failure surface.
- **Evidence (ground truth):** trace `5f877ea2-70cd-43c7-9c17-f0daa8bfe252` ended degraded with three `model.completed` errors and two unsuccessful generic recovery attempts. `explain` exposed no likely root cause; only the trace-scoped provider log named an encrypted response item that could not be verified, decrypted, or parsed. The durable session shape showed signed `thinkingSignature` objects carrying content-free keys `content`, `encrypted_content`, `id`, `summary`, and `type`.
- **Hypothesis → root cause:** the generic signed-replay detector recognized only `encrypted_content` plus older rejection verbs. The live provider used spaced `encrypted content` and `could not be verified/decrypted`, so classification fell to `unknown` and the runner replayed the same poisoned context.
- **RED test:** `packages/agent/src/executor/signed-replay-detector.test.ts` reproduces the exact neutralized provider wording; `packages/daemon/src/api/obs-handlers/obs-explain-heuristics.test.ts` requires terminal signed replay guidance that does not send the operator to raw logs.
- **Fix:** accept underscore or spaced encrypted-content nouns and the verified/decrypted/parsed rejection forms, feeding the existing provider-agnostic scrub-and-retry path. Terminal guidance now names the report’s signed-replay recovery evidence and clean-conversation fallback. Generic-runtime review: this is provider protocol-state recovery shared across unrelated agents; no application/domain policy entered the runtime.
- **Review:** noun+rejection-verb pairing remains required, capability/parameter rejections still short-circuit before replay classification, and raw provider bodies remain out of durable observability.
- **Rebuild + normal restart:** full workspace build passed; protected primary received only normal tmux restarts and booted `gpt-5.6-luna` on gateway 48701.
- **Confirm (ground truth):** the same durable U2 session and exact text produced trace `88d228fd-a28a-4fd5-88cf-56f718d2622a`: two classified signed-replay errors, one failed continuation nudge, six signed blocks removed, one successful retry, one Telegram delivery, and a non-degraded success summary. Two further exact fixed-build attempts also delivered correct bounded answers; one removed seven blocks and one completed directly.
- **Regression re-run:** 218 focused agent/daemon tests plus full workspace build.
- **Commit:** `ba2ee309` (RED commit `67bcbd3b`).
- **Status:** CLOSED — future matching provider wording enters the deterministic recovery path and carries a content-free category.

## A0-N-REPLAY-REPORT — successful replay recovery missing from explain
- **Symptom (live):** the successful fix-verification trajectory recorded `execution.replay_recovered {succeeded:true}`, while offline `explain` reported `recoveries.succeeded:0` and only the failed continuation nudge.
- **Evidence (ground truth):** trace `88d228fd-a28a-4fd5-88cf-56f718d2622a` contained both events; the pre-fix IncidentReport returned recovery total 1/succeeded 0/byReason continuation_nudge 1.
- **Hypothesis → root cause:** `obs-explain-signals` folded `execution.recovery_attempted` only; the signed-replay path intentionally emits its richer sibling event and was never included in the common recovery totals.
- **RED test:** `packages/daemon/src/api/obs-handlers/obs-explain-assemble.test.ts` combines a failed continuation nudge with a successful replay recovery and requires total 2/succeeded 1/byReason signed_replay 1.
- **Fix:** fold `execution.replay_recovered` into the existing IncidentReport recovery section under the content-free reason `signed_replay`; update the contract descriptions and operator guidance to the field that the report actually exposes.
- **Review:** the events do not double-count—the signed-replay path does not also emit `execution.recovery_attempted` for its scrub—and reports with no recovery remain field-absent.
- **Rebuild + normal restart:** 229 focused daemon tests and full workspace build passed; primary restarted normally onto the final dist.
- **Confirm (ground truth):** one offline `explain` call on the same trace now reports outcome success/non-degraded plus recoveries total 2, succeeded 1, byReason continuation_nudge 1 and signed_replay 1.
- **Regression re-run:** assemble, heuristics, and real-layout golden report suites.
- **Commit:** `18d59c2d` (RED commit `360f477d`).
- **Status:** CLOSED — next time one `explain` call reconciles the replay recovery with its trajectory.

## A4-H-LINK-PREFETCH — automatic source receipt was mistaken for missing tool use
- **Symptom (live):** three exact benign URL bursts returned correct Example Domain summaries but contained no model-invoked `web_fetch` tool result, so the first review incorrectly called them ungrounded.
- **Evidence (ground truth):** each URL trace already carried a successful counts-only `link.prefetch` event, and the corresponding session user turn contained guarded `Source: Web Fetch` Linked Content with the real page text. Offline `explain` exposes the same receipt under `linkPrefetch`.
- **Hypothesis → root cause:** oracle/layer mismatch, not a missing fetch. Automatic inbound URL resolution runs before the model and is deliberately not represented as a model tool call. Two advisory description iterations could not create a tool receipt because one was neither needed nor desirable.
- **RED test:** `packages/agent/src/bootstrap/sections/tool-descriptions.test.ts` and `packages/skills/src/tools/builtin/web-fetch-tool.test.ts` require URL guidance to reuse already-present Linked Content and call `web_fetch` only when source content is absent.
- **Fix:** preserve grounding guidance while making automatic Linked Content the first receipt and preventing duplicate network work. Generic-runtime review: this describes the domain-neutral web adapter's existing mechanism; it adds no application policy. Earlier advisory commits `e1d2795d` and `31385762` are superseded by the receipt-aware wording.
- **Review:** the instruction still forbids prior-knowledge claims when neither Linked Content nor a current fetch exists; it does not weaken SSRF validation or external-content framing.
- **Rebuild + normal restart:** 122 focused tests and the full workspace build passed; continuity-protected primary received only a normal tmux restart and booted `gpt-5.6-luna` on gateway 48701.
- **Confirm (ground truth):** final exact burst reconciled 3/3 answers with peak concurrency 2. URL trace `c3978770-c55e-49f2-aafe-f8279c2d200d` has exactly one successful prefetch (`fetched=1`, 181 ms), no duplicate `web_fetch` tool result, success/non-degraded outcome, and a matching source block in the durable session.
- **Observability gap closed:** no new signal was needed; the investigation now uses `IncidentReport.linkPrefetch` before falling back to transcript inspection.
- **Regression re-run:** focused descriptions/tool tests, full workspace build, exact Telegram burst, burst verifier, trajectory receipt, session source, and offline `explain`.
- **Commit:** `e679730f` (RED commit `5319b30c`).
- **Status:** CLOSED — next time one `explain` call proves automatic fetch grounding without inventing a missing model tool call.
