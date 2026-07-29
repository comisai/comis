# RESULTS-LOG — <target> — <YYYYMMDD>

> Filled during execution. Copy into `runs/<target>-<date>/RESULTS-LOG.md`. The stop-condition checklist at the bottom must be all-checked (or honest-deferred) before the run is "done" (`../02-DISCIPLINE.md §stop`).

## Summary
- **COMPLETE or PARTIAL:** `<one word, FIRST — PARTIAL if NO-ACCESS + NOT-RUN exceeds ~20% of the planned matrix>`
- **Rig:** VPS `<host>`, daemon as `comis`, build `<commit>`, provider/model `<…>`, emulator on `<port>`.
- **Outcome:** `<N works / M fails-honestly / K COMIS-FAIL→fixed>`; HARD oracles: `<all green? list any open>`.
- **Coverage:** `<planned rows>` planned → `<n>` OK · `<n>` fails-honestly · `<n>` COMIS-FAIL · `<n>` NO-ACCESS · `<n>` **NOT-RUN** = `<pct>`% unreached.

## Per-test results
Every planned row appears here. `NOT-RUN` is a real verdict — a never-driven row that is omitted reads as covered, and one mislabelled `NO-ACCESS` reads as "the rig can't, and that's fine" (`../02-DISCIPLINE.md §scoring`).
| id | result (OK / fails-honestly / COMIS-FAIL→fixed / NO-ACCESS / NOT-RUN) | pass@k (bar: HARD = k/k, correctness ≥2/3 + failing run explained) | evidence (oracle excerpt) | fix commit |
|---|---|---|---|---|
| | | | | |

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
| | | | | |

## Fixes (test-first)
| issue | root cause (class) | RED test path | fix commit | confirmed-live (oracle) |
|---|---|---|---|---|
| | | | | |

## Observability / emulator gaps closed (or dated TODO)
| gap | how closed (signal threaded to explain/system · verb/method/fault/oracle added) | litmus proven? |
|---|---|---|
| | | |

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
