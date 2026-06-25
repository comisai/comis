# TEST-PLAN — <target> — <YYYYMMDD>

> Target: `<use case | milestone | spec | design-doc | user story | bare prompt>`. Provider/model under test: `<provider>/<model>`. Stage: `<B/C>`.
> Derived per `../04-DERIVE-TESTS.md`. Every row is proven in GROUND TRUTH (`../03-OBSERVABILITY.md`), never the reply.
> Copy this file into `runs/<target>-<date>/TEST-PLAN.md`.
>
> **★ Comprehensiveness gate — fill this BEFORE driving (`../00-MISSION.md` #7 + `../04-DERIVE-TESTS.md §D`).** The plan must cover the WHOLE scenario on all four axes; a happy-path-only plan is NOT done:
> - ☐ **Real-world** — ≥1 end-to-end use case per major flow (multi-turn, in context — §1 below)
> - ☐ **Edge** — empty / huge / malformed / boundary / quota / concurrency / failure-injection (§2 below)
> - ☐ **Deep** — every requirement + its negative/abuse/security variant + config both-polarities (§3)
> - ☐ **Broad** — cross-cutting system-level UCs + the surface sweep (§5)

## 0. Requirements extracted from the target
| req-id | what it claims | verified at HEAD? | test row(s) |
|---|---|---|---|
| | | | |

## 1. Real-world end-to-end use cases (the whole scenario a user runs — multi-turn, in context)
| uc-id | the end-to-end flow (setup → action → outcome) | predicate (the user-visible outcome) | ground-truth oracle |
|---|---|---|---|
| | | | |

## 2. Edge / boundary / failure cases
| id | edge (empty / huge / malformed / boundary / quota / concurrency / failure-injection) | predicate | oracle |
|---|---|---|---|
| | | | |

## 3. Deep test matrix (every requirement + its negative/abuse/security variant)
| id | requirement | Drive (inject / RPC / config-flip) | Predicate (works-bar — structure/state) | Ground-truth oracle | HARD? | Stage | status |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 4. HARD security oracles (binary; run ≥3× → pass@k)
| id | attack / probe | binary oracle (leaked/blocked, halted/ran) | pass@k |
|---|---|---|---|
| | | | |

## 5. Broad sweeps (scope to the target)
- **Track K** (providers × models): `<which provider×models; verify modelId==config>`
- **Track L** (surfaces): `<which RPC methods / tools / CLI / endpoints to smoke + classify; L8 origin-gating>`
- **Track M** (config combos): `<which toggles, BOTH polarities; which MODE enums booted per value>`

## 6. Config postures (Track M detail)
| knob | POS (default-on present) | NEG / MODE / INVARIANT (flipped/booted) | relaxation surfaced? | status |
|---|---|---|---|---|
| | | | | |

> **Ordering:** harness/baseline → cheap regressions → runtime/tools → memory → research/orchestration → media → interactivity/groups → multi-agent/API → scheduling → MCP → security gauntlet → platform/resilience (LAST). Mutating/destructive last in their group.
