# RESULTS-LOG — real-user Telegram local — 2026-08-06

> Filled during execution. Copy into `runs/<target>-<date>/RESULTS-LOG.md`. The stop-condition checklist at the bottom must be all-checked (or honest-deferred) before the run is "done" (`../02-DISCIPLINE.md §stop`).

## Summary
- **IN PROGRESS**
- **Rig:** isolated local source-tree primary `/home/ubuntu/.comis-live-real-user-telegram-local-20260806-v2`, gateway 48701, tmux-owned daemon, loopback Telegram emulator, `openai-codex/gpt-5.6-luna` confirmed by trajectory.
- **Outcome so far:** Phase 0 and the complete 44-message comparability prelude are complete; prelude runtime ownership/delivery is green, while the reset-burst content diagnostic repeated the prior 1/10 model-sensitive miss; 3 harness COMIS-FAILs are fixed test-first; HARD A/B/C rows have not started.
- **Coverage so far:** SETUP-1–SETUP-7 and every `spine-*`/early `cc*` corpus record complete; next row A11. Full denominator is filled at finish audit.

## Per-test results
Every planned row appears here. `NOT-RUN` is a real verdict — a never-driven row that is omitted reads as covered, and one mislabelled `NO-ACCESS` reads as "the rig can't, and that's fine" (`../02-DISCIPLINE.md §scoring`).
| id | result (OK / fails-honestly / COMIS-FAIL→fixed / NO-ACCESS / NOT-RUN) | pass@k (bar: HARD = k/k, correctness ≥2/3 + failing run explained) | evidence (oracle excerpt) | fix commit |
|---|---|---|---|---|
| SETUP-1 | OK | 1/1 | Both canonical configs validate on literal roots/ports; config, `.env`, and encrypted store are mode 0600. Everyday hashes remain `e972d2…` / `15a21d…` / `6a7c12…`. | — |
| SETUP-2 | COMIS-FAIL→fixed | 2/2 | First primary `rig-doctor` rejected RPC because a checkout-level stale token overrode the selected store. Fresh scratch launch and primary replay both pass after fix. Phase-zero process evidence then named everyday PID 610; fixed replay names selected PID 4072911. | `509664a5`, `0e2dd6ea` |
| SETUP-3 | OK | 1/1 | Metadata-only inventory: 5 encrypted secret names, one agent, zero MCP servers, 13 discovered skills (9 eligible), 69 active tools in the Phase-0 trace, built-in cron ownership scoped to `default`; target model exists and served. | — |
| SETUP-4 | OK | 1/1 | Real Telegram adapter returned the setup-skipped acknowledgement; `BOOTSTRAP.md` is zero bytes. Protected clean restart created `.continuity-protected`; a second clean restart exited 3 before stop and preserved PID/config hash. | — |
| SETUP-5 | OK | 1/1 | Inbound 103 → exactly one wire reply `PONG42`; trace `072709e3-b7cd-4c6a-9e42-1b3aa80dfff9`, served `gpt-5.6-luna`, success, 5,084 ms, 23,389 tokens, $0.023424. Session draft, wire, delivery trajectory, and mirror text agree; `explain` has 11 records/no failures and health is 0% degraded. | — |
| SETUP-6 | OK | 1/1 | 24-fixture manifest hash/size verified: five decodable Opus voices, two deterministic decode failures, clean/blurry/hostile 1200×800 images visually read, valid one-page PDF, 40,000-byte paste, 684,000-byte oversized document, identical learning openings, and reachable benign/hostile public pages. | — |
| SETUP-7 | OK | 1/1 | Baseline: PID 4072911, RSS 1,400,252 KiB, 44 fds, 0 children, root 638,259,676 bytes, logs 51,703 bytes, 2 DB files; LCD/mirror/memory/session counts 0/0/0/0 after protected restart; 5 setup audit rows. | — |
| PRELUDE-SPINE | OK | deterministic | Exact twelve-turn relationship seed established and recalled the move code, three-bullet preference, document checkpoint, ETA, terminal child result, and persisted reminder. A normal primary restart preserved fact, preference, and completed-work recall. | — |
| PRELUDE-CC1–CC4 | OK | deterministic | Exact frozen bursts produced 5/5 at peak concurrency 5, three terminal heavy answers at peak 3, and both 12-second SDK steering corrections with one selected wire delivery and no lost/duplicate output. | — |
| PRELUDE-CC5 | COMIS-FAIL→fixed | deterministic replay | Initial verifier exited when 10 transcript answers but only 9 channel sends were visible; ground truth later reached 10/10. The fixed verifier waits for matching delivery, and a fresh exact ten-message burst passed 10/10 at peak concurrency 10. | `55c05a01` |
| PRELUDE-CC6 | fails-honestly | ownership 1/1; literal content 1/10 diagnostic | Two normal session resets retained 10/10 terminal owners and zero open traces. The wire emitted two selected replies; only final value `100` matched the ten requested terms. Direct DB counts retained move code/preference/checkpoint memories at 1/2/3 rows. OF-04 remains open for the scored three-attempt block. | — |

## Coverage honesty + previous-run diff
| check | this run | previous run | verdict |
|---|---|---|---|
| unreached fraction (NO-ACCESS + NOT-RUN) | | | |
| rows OK before, now NO-ACCESS/NOT-RUN (coverage REGRESSION — each needs an explanation) | | | |
| rows NO-ACCESS on both runs (hardening into a permanent blind spot — escalate, don't re-record) | | | |
| pass@k rates that MOVED since last run (intermittency = race signature; a finding even if today passes) | | | |

## Fifth-axis baselines (`../04-DERIVE-TESTS.md §D2` — a functional predicate cannot see these)
Latency and cost are mechanical and belong here every run, even when the target is not about performance: without a recorded baseline the product gets slower and dearer every release with every test green.
| measure | representative turn(s) | this run | previous run | delta | verdict |
|---|---|---|---|---|---|
| per-turn `durationMs` | | | | | |
| cost per turn (+ cache-read rate) | | | | | |
| soak: RSS / fd / orphan procs / DB size (state the DURATION) | | | | | |
| upgrade-in-place from last release over a populated data dir | | | | | |
| first-run/onboarding on a fresh box (incl. wrong-input branches) | | | | | |
| sustained concurrency (≥2 senders, ≥2 sessions, overlapping) | | | | | |

## Provider matrix (Track K)
| provider | model | OK / NO-ACCESS / COMIS-FAIL | modelId==config? | cache-read (if caching) |
|---|---|---|---|---|
| selected local RPC token | wrong-rig selection / harness | `test/live/self-driving/scripts/remote-root.test.ts` | `509664a5` | fresh scratch and primary `capabilities.introspect` pass even with stale 48-byte `GWTOKEN` |
| phase-zero daemon owner | wrong-rig evidence / harness | `test/live/self-driving/scripts/remote-root.test.ts` | `0e2dd6ea` | live Phase 0 names selected PID 4072911, not everyday PID 610 |

## Fixes (test-first)
| issue | root cause (class) | RED test path | fix commit | confirmed-live (oracle) |
|---|---|---|---|---|
| Terminal burst answer reported lost before channel post-processing finished | harness false negative: settle race | `test/live/self-driving/scripts/concurrency-oracle.test.ts` | `55c05a01` (RED `695a9ae9`) | original manifest reconciles 10/10; fresh zero-delay burst reconciles 10/10 with peak concurrency 10 |

## Observability / emulator gaps closed (or dated TODO)
| gap | how closed (signal threaded to explain/system · verb/method/fault/oracle added) | litmus proven? |
|---|---|---|
| Local helper inherited another rig's gateway token | Selected local encrypted-store resolution now precedes helper `GWTOKEN`; explicit `COMIS_GATEWAY_TOKEN` remains available for negative probes. | Yes: one command passes on fresh scratch and selected primary. |
| Phase-zero process check used host-wide `pgrep` | Local check now calls lifecycle-owner-aware `rig_daemon_pid`. | Yes: line names selected PID while several other daemons remain live. |
| Burst verifier treated terminal transcript state as terminal delivery | Settle now distinguishes resolved turns from matching Telegram wire delivery and retains the bounded quiet-period negative path. | Yes: the original late send and a fresh ten-way burst both reconcile 10/10. |

## Defaults verdict — the out-of-the-box experience (`../00-MISSION.md` STEP 4.6)
One row per behavior-changing knob the run exercised. A knob exercised but not judged is an omission; a class with no measurement behind it is a guess. Both HARD guards apply: never tune toward this run's domain, never relax a security default for UX.
| knob | shipped default | what you MEASURED (number · traffic · rig) | class (DEFAULT-OK / EXPERIENCE-WRONG / DEFAULT-WRONG / TRADEOFF / DEAD) | action: new value + RED test + docs, or recommendation |
|---|---|---|---|---|
| | | | | |

## Open findings (documented — NEVER silently dropped)
| finding | class (built-but-not-wired / masked-4xx / silent-substitution / …) | severity | recommendation |
|---|---|---|---|
| | | | |

## Stop-condition checklist
- [ ] Every deep test works / fails-honestly; **zero false success**; all HARD oracles green
- [ ] Track K complete; **0 COMIS-FAIL open**; modelId==config on OK rows; NO-ACCESS reasons recorded
- [ ] Track L walked; admin-gated methods reject non-admin
- [ ] Dual-oracle clean (channel oracle == delivery_mirror)
- [ ] Logs clean; no unexplained ERROR/FATAL; **no secret/canary residency** (logs+trajectory+memory.db)
- [ ] `pnpm validate` green on the fix branch; **config restored**; daemon healthy on the fixed build
- [ ] pass@k reported **and meeting its bar** (HARD = k/k; correctness ≥2/3 with the failing run explained); every moved rate raised as an intermittent-defect finding
- [ ] **Coverage honesty:** every planned row accounted for (incl. `NOT-RUN`); unreached fraction stated in the summary; a run over ~20% labelled **PARTIAL in its first line**
- [ ] **Previous-run diff done:** every coverage regression (was OK, now NO-ACCESS/NOT-RUN) explained; every twice-NO-ACCESS row escalated rather than re-recorded
- [ ] **Fifth-axis baselines recorded** (`04-DERIVE-TESTS §D2`) — latency and cost diffed against the previous run at minimum; the other four planned or explicitly out of scope
- [ ] Observability loop closed (every friction fixed test-first or dated TODO)
- [ ] Track M two-sided (both polarities; relaxed defaults surfaced)
- [ ] **Defaults verdict table filled** — every exercised knob judged with a measurement; each changed default has a RED test pinning value + reason, docs updated in the same change, and before/after recorded
- [ ] Emulator loop closed (no `@comis/*`/`bundledDependencies` edge added)
