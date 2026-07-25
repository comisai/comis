# RESULTS-LOG — <target> — <YYYYMMDD>

> Filled during execution. Copy into `runs/<target>-<date>/RESULTS-LOG.md`. The stop-condition checklist at the bottom must be all-checked (or honest-deferred) before the run is "done" (`../02-DISCIPLINE.md §stop`).

## Summary
- **Rig:** VPS `<host>`, daemon as `comis`, build `<commit>`, provider/model `<…>`, emulator on `<port>`.
- **Outcome:** `<N works / M fails-honestly / K COMIS-FAIL→fixed>`; HARD oracles: `<all green? list any open>`.

## Per-test results
| id | result (OK / fails-honestly / COMIS-FAIL→fixed) | evidence (oracle excerpt) | fix commit |
|---|---|---|---|
| | | | |

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
- [ ] pass@k reported for reliability-sensitive tests
- [ ] Observability loop closed (every friction fixed test-first or dated TODO)
- [ ] Track M two-sided (both polarities; relaxed defaults surfaced)
- [ ] Emulator loop closed (no `@comis/*`/`bundledDependencies` edge added)
