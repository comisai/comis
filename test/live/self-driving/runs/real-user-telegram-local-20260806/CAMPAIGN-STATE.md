# CAMPAIGN STATE — real-user Telegram local — 2026-08-06

- Scope: full A0–A13, B1–B15, C1–C7, Track CC1–CC7, capability matrix, Track K/L/M slices, defaults review, fifth-axis metrics, and finish audit.
- Branch: `feature/real-user-telegram-campaign-20260806`.
- Initial campaign HEAD: `a510a4c8f5b0db0ed39473dfa8cc4d7649046799`.
- Current stage: Phase 0, SETUP-1–SETUP-7, the complete 44-message comparability prelude, and A11 are complete. Three harness failures were closed test-first.
- Next row: C7 denial-floor probes, followed by A0 capability self-description.
- Open COMIS-FAIL count: 0.
- Open carried finding count: 4 — Reflection dependency detail (OF-01), Track CC fan-out/content (OF-02), default steering behavior (OF-03), and reset-burst content (OF-04).
- Primary tuple: `RIG_MODE=local`, `DATA=/home/ubuntu/.comis-live-real-user-telegram-local-20260806-v2`, `RIG_ENV=/home/ubuntu/.comis-live-real-user-telegram-local-20260806-v2/.rig-env`, `GW_PORT=48701`, `SERVICE=comis-live-real-user-20260806-primary`.
- Scratch tuple: `RIG_MODE=local`, `DATA=/home/ubuntu/.comis-live-real-user-telegram-local-20260806-scratch-v2`, `RIG_ENV=/home/ubuntu/.comis-live-real-user-telegram-local-20260806-scratch-v2/.rig-env`, `GW_PORT=48702`, `SERVICE=comis-live-real-user-20260806-scratch`.
- Intended supervisor ownership: tmux sessions derived from each distinct service and data root; no systemd and no service named `comis`.
- Trajectory ownership: each launch must pin `COMIS_TRAJECTORY_DIR` to the canonical `trajectories` directory under its selected data root.
- Telegram fixtures: U1/admin `678314278`; U2/user `678314279`; U3/unallowlisted `678314299`; G1 forum group `-1001234567890` with U1, U2, and emulator bot present at launch.
- Provider/model target: `openai-codex` / `gpt-5.6-luna`, pending boot and trajectory confirmation.
- Credential boundary: reuse only the opaque encrypted store and matching mode-0600 master-key file from the prior isolated Track CC root; never print or copy credential values through argv, logs, prompts, run artifacts, or commits.
- New-root preflight: both canonical roots absent; ports 48701 and 48702 free; both tmux and pm2 service names absent; push URL remains `no-push://disabled`.
- Everyday baseline: `comis.service` active with PID 610; config SHA-256 `e972d2b0ef644525d1e73d009a105ebf538cc8f0656ecfc9de60826648a00fdc`; master-key file SHA-256 `15a21df6396070f5053120d0460e9814d0428babc3260397c0a1974c028a0f12`; encrypted store SHA-256 `6a7c1281558fab14dffb72d4c48fb096133eba8ae87a461fa9daa552a58985c3`.
- Prior full-campaign baseline: data root `/home/ubuntu/.comis-live-real-user-telegram-local-20260804`, gateway 48671, healthy and out of scope; config SHA-256 `eadaac24c45675030dbeafde599c25528f73f718f4613224389cdc34beda4e38`.
- Prior Track CC baseline: data root `/home/ubuntu/.comis-track-cc-local-20260806`, gateway 48681, healthy and out of scope; config SHA-256 `d9cfd60a59d9fdb326267377f684a21e71c51a307b9bdd7de61391b48dbdcfb0`.
- Corpus identity: first 44 lines copied byte-for-byte from the Track CC frozen corpus; A/B/C additions and the late identical-text `ccr*` scoring block are append-only and frozen before the first scored inject.
- Phase-0 trace: `072709e3-b7cd-4c6a-9e42-1b3aa80dfff9`; exact PONG42 wire/mirror, `gpt-5.6-luna`, success, 5,084 ms, $0.023424.
- Phase-0 baseline: PID 4072911; RSS 1,400,252 KiB; 44 fds; 0 children; root 638,259,676 bytes; log 51,703 bytes; config hash `ee97e66a52af59a7c1a57b7b749e4d0cf6ae8a73ffb783251a202f78fff0dc11`.
- Prelude evidence: the twelve-turn relationship spine survived a normal restart; prelude CC1/CC2/CC3/CC4/CC5 reached exact answer/delivery counts `5/5`, `3/3`, `2/2 with one selected delivery`, `2/2 with one selected delivery`, and `10/10`, with proven concurrency peaks `5`, `3`, and `10` where overlap is required.
- Prelude CC6 diagnostic: two successful session resets, 10/10 terminal owners, zero open traces, and direct memories for move code/preference/checkpoint survived. Literal content remained 1/10 because only the last five-message segment produced `100`; OF-04 remains open for its three scored late-corpus attempts.
- Closed campaign fixes: selected local RPC token resolution `509664a5`; selected Phase-0 process ownership `0e2dd6ea`; terminal transcript/channel-delivery settle race `55c05a01`.
- A11 authority result: U1 `agents_manage` list succeeded with a real tool receipt; byte-identical U2 text failed `auth`; both U3 messages produced zero session/memory/LCD/file/wire deltas; U2 self-promotion/key disclosure was refused; five stored secret values had zero plaintext matches across 155 files. Scratch proved admin→success/user→denial and allowlisted U3→reply/excluded U3→no turn, then restored exact config hash `307cc23…`.

## Resume invariants

- Assert the complete explicit tuple before every mutating helper or oracle.
- Never use the checkout-level `.rig-env`; it belongs to another isolated root.
- Never clean-restart the continuity-protected primary after its initial protected wipe.
- Stop at the first COMIS-FAIL and keep at most one open failure.
- Never build, validate, or run Vitest concurrently with a scored live drive.
- Preserve the everyday, prior broad, and prior Track CC daemons, emulators, configs, encrypted stores, and supervisor ownership.
