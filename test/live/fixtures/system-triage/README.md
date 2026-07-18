# System-triage corpus (the system-triage baseline)

This directory is a frozen, committed corpus encoding a **manual
daemon-wide triage** as structured reference data — the reference the
`obs.system.health` lens must reproduce, plus the manual cost/effort to
beat. The source is an already-written by-hand triage: the
"What I found by hand" table + the manual cost/effort-to-beat line. This is the direct twin of
`test/live/fixtures/diagnosis/`, **minus the LLM apparatus** — this corpus is a deterministic
count/group-by, not a judged diagnosis.

Both files are read by `loadCorpus` (`test/live/support/system-triage-corpus.ts`) into a typed
`SystemCorpus`:

| File | Shape |
|------|-------|
| `triage-corpus.json` | `{ "signals": SystemSignal[] }` — the by-hand findings as structured data. Each entry: `{ signal, byHandCount, location, alreadyStructured, errorKind? }`, where `signal`/`location` are CLOSED string unions (an out-of-enum value fails the loader's shape-guard). Counts + typed enums only, **never raw log bodies**. |
| `manual-cost-to-beat.json` | `ManualCostToBeat` — `{ severityHistogram, groupByMessage, pm2ModelScrape }`. The manual triage run by hand (the severity histogram over `daemon.log` + the recurring-WARN group-by + the pm2 native-stdout model-health scrape step). **This is the RE-PROVE bar that asserts the lens replaces the by-hand triage in ONE call.** |

> **CRITICAL — encoding, not archaeology.** This corpus is an
> **ENCODING** of the already-written by-hand triage, **not a reconstruction**
> from a rotating `daemon.1.log`. There is **no** `trajectory.jsonl` to parse and **no daemon was
> re-run** — `loadCorpus` reads the static frozen JSON in this directory. It is a transcription
> into structured JSON, not a measurement. (The *measurement* against today's real
> `~/.comis` is a separate deterministic gap-gate, a git-ignored artifact.)

## The by-hand findings encoded here

| signal | byHandCount | location | alreadyStructured | errorKind | note |
|--------|-------------|----------|-------------------|-----------|------|
| `lcd-ingest-skipped` | 7 | `daemon.log` | false | `precondition` | the flagship signal (live/store divergence — `lcd-ingest.ts:276` + the compaction/condense twins) |
| `config-posture` | 3 | `daemon.log` | false | `config` | TLS-off / stranded secret / canary-fallback (`setup-storage-mismatch-warn.ts` WARNs). **Partially** structured (`config-audit.jsonl` captures config READS/WRITES, NOT the posture FINDINGS). |
| `model-health-deferred` | 1 | `native-stdout` | false | — | the embedding tokenizer "may not work as intended" line + reranker load — **OUT of scope** (native node-llama-cpp stdout, invisible to Pino). |
| `mcp-reconnect` | 3 | `trajectory.jsonl` | false | `mcp` | yfinance MCP churn (`mcp:server:reconnect_failed` → `health:budget_exceeded`) — evented to trajectory JSONL only, NOT `obs_diagnostics`. |
| `budget-exceeded` | 0 | `trajectory.jsonl` | false | — | the `health:budget_exceeded` twin of the MCP churn — its own row so the gate can count it separately and every enum member has a corpus row. |
| `session-degradation` | 0 | `obs_diagnostics` | true | — | degradation rate / top errorKinds / breaker trips / cost — **the contrast item, ALREADY structured** (`session_summary` rows + billing aggregates). `byHandCount` is 0 because this is a RATE/already-structured verdict, not a recurrence count. |

## Verdict mapping (how the corpus feeds the gate)

Each signal maps to a gate verdict class so a reader understands how this corpus shape feeds
the deterministic gap-gate (`system-recurrence-gate.ts`):

- `lcd-ingest-skipped` / `mcp-reconnect` / `config-posture` / `budget-exceeded` →
  **INSTRUMENT-160-candidate** (log-only / trajectory-only today; the instrumentation gap,
  gated by the measured recurrence against the real `~/.comis`).
- `session-degradation` → **ALREADY-STRUCTURED** (queryable cross-session today; the contrast item).
- `model-health-deferred` → **OUT-OF-SCOPE** (native-stdout, deferred — the gate does not score it
  as instrumentable).

## Secret / PII gate (this corpus is COMMITTED — unlike the git-ignored ledger)

Every committed file in this directory passes the secret/PII sweep: **`scanForSecrets` (from
`test/live/cost.ts`) returns zero matches** on each of `triage-corpus.json`,
`manual-cost-to-beat.json`, and this `README.md`.

The findings are **already PII-free** — they are COUNTS + typed message labels + canonical
**source-code WARN strings** (e.g. `"LCD ingest skipped: live/store divergence"`, which is
source-code text from `lcd-ingest.ts`, not operator content), **never raw `daemon.log` bodies**.
So **no field-aware scrub was needed**. For completeness, the standard scrub procedure that
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

Only the baseline RUN ledger under `benchmarks/live/` is
git-ignored; this corpus IS committed.
