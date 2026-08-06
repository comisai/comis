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
