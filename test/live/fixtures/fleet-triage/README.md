# Fleet-triage corpus (Phase 158 — PROVE & gate: fleet-triage baseline, M1)

This directory is the **M1 deliverable**: a frozen, committed corpus encoding **this session's
manual v2.14-review daemon-wide triage** as structured reference data — the reference the
`obs.fleet.health` lens (v2.15 "Glass Box II") must reproduce, plus the manual cost/effort to
beat. The source is **already-written prose**: `.planning/FLEET_HEALTH_LENS_PHASE.md` §2 (the
"What I found by hand" table + the manual cost/effort-to-beat line). This is the direct twin of
Phase 149's `test/live/fixtures/diagnosis/`, **minus the LLM apparatus** — 158 is a deterministic
count/group-by, not a judged diagnosis.

Both files are read by `loadCorpus` (`test/live/support/fleet-triage-corpus.ts`) into a typed
`FleetCorpus`:

| File | Shape |
|------|-------|
| `triage-corpus.json` | `{ "signals": FleetSignal[] }` — the §2 by-hand findings as structured data. Each entry: `{ signal, byHandCount, location, alreadyStructured, errorKind? }`, where `signal`/`location` are CLOSED string unions (an out-of-enum value fails the loader's shape-guard). Counts + typed enums only, **never raw log bodies**. |
| `manual-cost-to-beat.json` | `ManualCostToBeat` — `{ severityHistogram, groupByMessage, pm2ModelScrape }`. The manual triage this session ran by hand (the severity histogram over `daemon.log` + the recurring-WARN group-by + the pm2 native-stdout model-health scrape step). **This is the RE-PROVE bar Phase 162 (P1) asserts the lens replaces in ONE call.** |

> **CRITICAL — encoding, not archaeology (RESEARCH.md Pitfall 1).** This corpus is an
> **ENCODING** of already-written prose (`FLEET_HEALTH_LENS_PHASE.md` §2), **not a reconstruction**
> from a rotating `daemon.1.log`. There is **no** `trajectory.jsonl` to parse and **no daemon was
> re-run** — `loadCorpus` reads the static frozen JSON in this directory. M1 is a transcription
> into structured JSON, not a measurement. (Phase 158's *measurement* against today's real
> `~/.comis` is Plan 03's deterministic gap-gate, a separate, git-ignored artifact.)

## The §2 findings encoded here

| signal | byHandCount | location | alreadyStructured | errorKind | note |
|--------|-------------|----------|-------------------|-----------|------|
| `lcd-ingest-skipped` | 7 | `daemon.log` | false | `precondition` | the milestone's flagship signal (live/store divergence — `lcd-ingest.ts:276` + the compaction/condense twins) |
| `config-posture` | 3 | `daemon.log` | false | `config` | TLS-off / stranded secret / canary-fallback (`setup-storage-mismatch-warn.ts` WARNs). **Partially** structured (`config-audit.jsonl` captures config READS/WRITES, NOT the posture FINDINGS — Pitfall 5). |
| `model-health-deferred` | 1 | `native-stdout` | false | — | the embedding tokenizer "may not work as intended" line + reranker load — **OUT of the milestone** (native node-llama-cpp stdout, invisible to Pino). |
| `mcp-reconnect` | 3 | `trajectory.jsonl` | false | `mcp` | yfinance MCP churn (`mcp:server:reconnect_failed` → `health:budget_exceeded`) — evented to trajectory JSONL only, NOT `obs_diagnostics`. |
| `budget-exceeded` | 0 | `trajectory.jsonl` | false | — | the `health:budget_exceeded` twin of the MCP churn — its own row so Plan 03 can count it separately and every enum member has a corpus row. |
| `session-degradation` | 0 | `obs_diagnostics` | true | — | degradation rate / top errorKinds / breaker trips / cost — **the contrast item, ALREADY structured** (`session_summary` rows + billing aggregates). `byHandCount` is 0 because this is a RATE/already-structured verdict, not a recurrence count. |

## Verdict mapping (how the corpus feeds the Plan-03 gate)

Each §2 signal maps to a gate verdict class so a reader understands how this corpus shape feeds
the deterministic gap-gate (`fleet-recurrence-gate.ts`):

- `lcd-ingest-skipped` / `mcp-reconnect` / `config-posture` / `budget-exceeded` →
  **INSTRUMENT-160-candidate** (log-only / trajectory-only today; the gap the I-track closes,
  gated by Plan 03's measured recurrence against the real `~/.comis`).
- `session-degradation` → **ALREADY-STRUCTURED** (queryable cross-session today; the contrast item).
- `model-health-deferred` → **OUT-OF-SCOPE** (native-stdout, deferred — the gate does not score it
  as instrumentable).

## Secret / PII gate (this corpus is COMMITTED — unlike the git-ignored ledger)

Every committed file in this directory passes the secret/PII sweep: **`scanForSecrets` (from
`test/live/cost.ts`) returns zero matches** on each of `triage-corpus.json`,
`manual-cost-to-beat.json`, and this `README.md`.

The §2 findings are **already PII-free** — they are COUNTS + typed message labels + canonical
**source-code WARN strings** (e.g. `"LCD ingest skipped: live/store divergence"`, which is
source-code text from `lcd-ingest.ts`, not operator content), **never raw `daemon.log` bodies**.
So **no field-aware scrub was needed**. For completeness, the standard 149-02 scrub procedure that
**would** apply had any log content been captured (because the operator PII below is **not**
credential-shaped and slips past `SECRET_PATTERN` — Pino does not redact it either). The
"source" side is described, not written verbatim, so this README itself carries zero live PII
tokens (it must pass the same `scanForSecrets` + PII-absence gate as the JSON):

- `hostname` (the machine's `*.local` hostname) → `test-host`
- `pid` (the live process id) → `0`; `instanceId` (the boot instance id) → `test`
- OAuth email (the operator's `<user>@<provider>` login) → `test-user@example.com`
- home-directory PII in path fields (`/Users/<operator>/.comis/…`) → `/Users/test-user/.comis/…`
- **Verified:** zero residual operator-hostname / operator-home-path / operator-email occurrences
  in any committed file (a hand grep in addition to `scanForSecrets`).

Only the Plan-03 RUN ledger under `benchmarks/live/` (and the `.planning/` reorder doc) are
git-ignored; this corpus IS committed.
