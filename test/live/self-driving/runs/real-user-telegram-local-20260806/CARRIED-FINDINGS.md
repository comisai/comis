# CARRIED FINDINGS — real-user Telegram local — 2026-08-06

Sources:

- `runs/real-user-telegram-local-20260804/{TEST-PLAN.md,RESULTS-LOG.md,FIX-VERIFY-LOG.md,SURFACE-MATRIX.md}` for the full A/B/C baseline.
- `runs/track-cc-local-20260806/{TEST-PLAN.md,RESULTS-LOG.md,FIX-VERIFY-LOG.md,CORPUS.jsonl}` for the newest concurrency and steering baseline.

Any failed one-pass re-verification is a regression and preempts every unstarted row.

## Verified fixed — re-verify once, do not re-diagnose

| id | closed behavior | single re-verification oracle | risk position |
|---|---|---|---|
| CF-01 | isolated local emulator lifecycle cannot stop another rig | all four old/new emulator and gateway owners remain live after new emulator launch | SETUP-2 |
| CF-02 | selected local gateway credentials resolve from the selected encrypted store and schema-native SecretRef | authenticated `rig-doctor.sh` RPC plus count-only residency scan | SETUP-3 |
| CF-03 | clean restart removes selected sessions and trajectories | scratch session/trajectory count is zero before its first replay | SETUP-4 |
| CF-04 | General-topic group messages are attributable and the emulator installs the bot member | exact G1 `GROUP43`-style reply with topic/session match | SETUP-5 |
| CF-05 | terminal auth failure outranks incidental recall and is visible through `explain`/health | forced missing-provider scratch trace reports auth as root cause without raw logs | SETUP-3 |
| CF-06 | capability self-description is constrained by current tools, trust, and provider evidence | A0 exact 3/3 capability/authority inventory comparison | A0 |
| CF-07 | current trust denial cannot reuse a historical admin receipt | identical U1/U2 `agents_manage` request produces success/denial with zero partial effect | A11 |
| CF-08 | delivery reconciliation selects the exact Telegram conversation and includes accepted failure replies | U1/U2 success and forced-failure wire/mirror hashes match independently | A11/A3 |
| CF-09 | old-message replies preserve the referenced content in typed current context | A3 reply-to-old-bot replay resolves the exact referent | A3 |
| CF-10 | granted non-origin sends require a unique observed endpoint and remain recipient-bound | exact grant delivers once; removed grant delivers zero | A3 |
| CF-11 | web/tool receipt probes follow the real trajectory pointer | A4 receipt probe reports the current fetch call/result and existing source path | A4 |
| CF-12 | missing STT and media providers name exact credential/config knobs | A5/A7 absent-provider replies name the current secret/config keys and emit no artifact | A5/A7 |
| CF-13 | global vision disable and explicit provider selection cannot silently fall through | A6 scratch polarities emit zero image content/artifact on disabled/unavailable paths | A6 |
| CF-14 | successful message-tool delivery is not delivered again as a redundant final | A8 fresh-topic substantive wire count equals scoped mirror count | A8 |
| CF-15 | current group activation/history settings reach the trusted prompt and use exact knob names | A8 polarity question names both current keys and values | A8 |
| CF-16 | collect uses `queue.defaultDebounceMs`; removed debounce surfaces stay absent | A12/CC5 collect emits one coalesced batch with complete source accounting | A12/CC5 |
| CF-17 | approvals bind authenticated principal, topic, and exact pending action | concurrent opposite A9 approvals mutate only their own requested targets | A9 |
| CF-18 | current tool result outranks transient recalled memory | A9 deletion reply reconciles with filesystem and current receipt | A9 |
| CF-19 | successful identical-result loops trip the six-result governor and name the bound | A10 live never-flip trace plus `explain` | A10 |
| CF-20 | max-step and per-root budget failures name exact knobs, values, and attempted totals | A10 low-limb wire plus `explain` arithmetic | A10/B12 |
| CF-21 | child loop failure disclosure is not duplicated or rewritten as success | delegated A10 child emits one warning and one bound disclosure | A10 |
| CF-22 | background lifecycle remains origin-bound, terminal, and honest | B1 promoted task joins origin trace/chat and one later mirror row | B1 |
| CF-23 | child caps, counts, steering, failures, and node budgets remain attributable | B2 spawn tree and child/session stores reconcile | B2 |
| CF-24 | graph cancellation kills owned processes and durability resumes the same frontier | B3 cancel/process proof and restart probe | B3 |
| CF-25 | completion claims cannot escape through outbound tools after failed mutations | B4 independent browser/test run plus absence of unsupported done claim | B4 |
| CF-26 | every research citation has a current fetch receipt and receipt-free answers emit no URLs | B5 hostile/receipt polarity 3/3 | B5 |
| CF-27 | delayed MCP/skill work preserves originating trust and current registry authority | B6/B7 U1 success, U2 denial, removed-skill invocation denial | B6/B7 |
| CF-28 | MCP call timeout is caller-visible and old invalid background records surface through health | B6 low-timeout elapsed time plus health recovery-scan finding | B6 |
| CF-29 | learning respects corroboration, trust, drift, and memory-off gates | B8 DB/funnel/reuse/eviction oracle | B8 |
| CF-30 | inferred-task parse/suppression reasons reach trajectory, `explain`, and exact-origin delivery | B10 admitted/dismissed/delivered trio without raw log | B10 |
| CF-31 | hot-added agents remain model/session/memory/cron isolated and delete without active residue | B11 wildcard inventory plus cross-agent denial | B11 |
| CF-32 | provider breaker preserves consecutive failures, halts retries, and reaches explain/health | B13 dead-provider replay shows one trip and zero post-open calls | B13 |
| CF-33 | authored schedule updates require current receipts and wake/fire outcomes remain diagnosable | A2/B14 list/run/delivery evidence | A2/B14 |
| CF-34 | config history/rollback, last-channel guard, token lifecycle, and immutable paths cannot lock out operator | B15/C5/C6/C7 baseline hash and control-plane probe | B15/C5–C7 |
| CF-35 | oversized current attachment rejection cannot substitute an older same-name file | B9 rejection receipt immediately precedes prompt and next short turn succeeds | B9 |
| CF-36 | burst verifier waits for open work, selects the intended transcript/trace, and scopes wire evidence | Stage-1 live overlap and stopped-scratch negative control | Track CC gate |
| CF-37 | SDK steering uses current-user correction authority while preserving the external-content fence | CC4-D exact replacement 3/3, no superseded work | CC4-D |
| CF-38 | caller cancellation suppresses retry/continuation/output escalation | CC4-S exact replacement 3/3, zero late child/delivery | CC4-S |
| CF-39 | collect/reset/steer scorers account for every source and terminal owner without residual arithmetic | CC5/CC6 source-owner ledgers plus direct token fields | CC5/CC6 |

## Open — this is the work

| id | unresolved finding | evidence anchor | closing oracle | risk position |
|---|---|---|---|---|
| OF-01 | Reflection internal-action dependency detail is absent from `cron runs`, `system-health`, and `explain`; prior provider-overload failures required a raw-log query | prior broad `RESULTS-LOG.md` Open findings and B8 closure | forced Reflection dependency failure whose sanitized provider/error preview is visible through `cron runs` and one of `explain`/`system-health`, with no raw log | immediately after Phase 0, before new learning rows |
| OF-02 | Track CC model/tool-choice fan-out reached the complete three-way mechanism shape only 1/3 and content-complete 0/3 | Track CC CC2 attempts | same frozen CC2 corpus reaches own terminal fan-out/DAG units at ≥2/3, or fails honestly with a new evidence-backed explanation and no runtime attribution defect | early after orchestration preflight |
| OF-03 | Default SDK steering honored the narrowing only 1/3 even though delivery integrity was 3/3 | Track CC CC3-D | same frozen CC3 messages at real in-flight timing meet behavioral correctness ≥2/3 and HARD delivery k/k | Track CC after relationship spine |
| OF-04 | Reset-burst ownership was 3/3 but literal requested content was only 1/10, 0/10, 1/10 | Track CC CC6 | same frozen reset corpus preserves ownership and answers at least the correctness bar, with memory facts corroborated independently | Track CC after CC5 |

An open finding that survives this second applicable run is escalated in the final report with an owner and focused RED-test direction; it is never normalized as expected noise.
