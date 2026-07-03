# Diagnosis-fixture corpus (the LLM-diagnosis baseline)

This directory is a frozen, committed corpus of degraded Comis
sessions used by the diagnosis baseline RUN and the RE-PROVE. Each fixture is a
directory with three files read by `loadFixture` (`test/live/support/diagnosis-harness.ts`):

| File | Shape |
|------|-------|
| `trajectory.jsonl` | NDJSON — one JSON object per line (the session's events as they survive). |
| `session-metadata.json` | `{ sessionId, endReason, ... }` — the degraded signal + non-secret telemetry. |
| `answer-key.json` | The `AnswerKey` contract: `rootCause` at causal-**mechanism** granularity, `expectedDegraded`, `visibleSymptoms`, `hiddenMechanism`, `surfaceCeiling`, `mechanismTokens`. |

Every committed file passes the secret/PII sweep (`scanForSecrets` from `test/live/cost.ts`
returns zero matches). Answer-keys encode the **hidden mechanism the logs do not show**, not
just the visible symptom — that is the lever that makes the baseline correctly FAIL on
today's observability surface.

## `session-678314278` — historical (pre-`c53ab0f`), replayed from disk

- **Failure class:** `historical-c53ab0f` (web_fetch 200-misclassification → retry-breaker cascade).
- **Source:** `~/.comis/logs/daemon.1.log`, the contiguous block lines **95–628** (534 NDJSON
  lines) carrying sessionKey `default:678314278:678314278:peer:678314278`, extracted **2026-06-07**.
  Two traceIds live in the block — `f942d38c…` (first turn) and `058db0fe…` (the main chart turn,
  fully contained in lines 156–584) — both belonging to the one session.
- **Why frozen, not live-reproduced:** the bugs that caused it are fixed (`c53ab0f` detector fix,
  `e9d2711f` breaker render-peel fix), so it can no longer be triggered. `daemon.1.log` is
  machine-local and **rotates** — this fixture is the only durable record.
- **Scrub procedure applied, field-aware per line then a string sweep:**
  - `hostname` `Moshes-MacBook-Pro-2.local` → `test-host`
  - `pid` `1129` → `0`; `instanceId` `451ad8fb` → `test`
  - `profileId` OAuth email `…:anconina@gmail.com` → `…:test-user@example.com`
  - free-text `preview` body → `[scrubbed-user-content]` (the integer `previewLen` is preserved)
  - home-directory PII in path fields `/Users/mosheanconina/.comis/…` → `/Users/test-user/.comis/…`
  - The numeric chat id `678314278` is **retained** as the non-sensitive fixture label (a Telegram
    chat id with no standalone sensitivity).
  - **Verified:** `scanForSecrets(trajectory.jsonl) === []`; zero residual `Moshes-MacBook` /
    `/Users/mosheanconina` / `anconina` / `moshe` / original `pid:1129` / `451ad8fb` occurrences.
- **Real telemetry (non-secret, pulled from the extracted lines):** `durationMs` 247740,
  `totalTokens` 735800 (max `tokensTotal`), `sessionCostUsd` 1.320669 (final cumulative). The raw
  log carries `finishReason:"stop"` (no literal `endReason`); `completed_with_tool_errors` is the
  derived classification.
- **Load-bearing symptoms preserved:** the 14× "Tool execution failed", the `success:true`
  web_fetch entries (the misclassified 200s), the breaker "DO NOT retry", the accumulating
  `costUsd` — these keep the fixture faithful.

## `live-503-breaker` — the still-live class (re-prove target)

- **Failure class:** `503-breaker`. The **most important** live fixture — the re-prove runs
  `obs.explain` over a genuine repeated-503 → breaker and asserts
  `likelyRootCause.code:'breaker_opened_repeated_failure'` + the offending `toolName`.
- **Generation:** an HTTP **503** fault driven through the real product classifier
  `classifyError` (`@comis/agent`) → confirmed **`category: "overloaded"`, `retryable: true`**.
  The trajectory carries 5 repeated `web_fetch` 503 failures + the retry-breaker "DO NOT retry"
  block (the breaker open transition itself is dark — there is no `tool:breaker_opened` event,
  which is the observability gap the answer-key encodes).
  - _Note on the fault kind:_ `makeFaultInjector({kind:"5xx"})` throws **HTTP 500**, which
    `classifyError` maps to `unknown`. The still-live class we target is a repeated **503**,
    which maps to `overloaded` — so this fixture uses 503 (the faithful still-live class), not the
    bare 500 the injector emits. `classifyError(new Error("HTTP 503 …")).category === "overloaded"`
    is the verified product path (also asserted in `failure-injection.test.ts:113`).
- **`mechanismTokens`:** `["503","breaker","web_fetch","repeated"]`.

## `live-exec-modulenotfound`

- **Failure class:** `exec-modulenotfound`. It may already be
  1-call diagnosable via `obs.diagnostics` (the gating table tests this).
- **Generation:** hand-authored faithful exec failure — an `exec` tool ran `python3 script.py`
  importing an uninstalled `pandas`; the runtime raised `ModuleNotFoundError`, surfaced via
  `exitCode:1` + a `stderr` traceback. A dependency/environment failure (classified by
  exit_code/stderr), **not** a misclassification — so unlike the historical session, the cause is
  plainly visible in the stderr, which is itself the finding.
- **`mechanismTokens`:** `["ModuleNotFoundError","dependency","exec"]`.

## `live-budget-exhaustion`

- **Failure class:** `budget-exhaustion`.
- **Generation:** hand-authored — 4 `token_usage` records with rising cumulative cost
  (`0.55 → 1.10 → 1.65 → 2.20`) crossing the configured **$2.00** ceiling, ending in a
  `budget_exhausted` stop. A resource limit, not a tool failure.
- **Hidden mechanism:** the per-session cost rollup must be summed by hand across `token_usage`
  records today (the flight-recorder gap).
- **`mechanismTokens`:** `["budget","exhausted","costUsd"]`.

## `live-provider-timeout`

- **Failure class:** `provider-timeout`.
- **Generation:** a 30000ms deadline breach driven through `classifyPromptTimeout(30000)`
  (`@comis/agent`) → confirmed **`category: "prompt_timeout"`, `retryable: true`**. The trajectory
  carries a stalled `web_fetch` call, a retry, and a second timeout.
  - _Note:_ `classifyError` on the bare timeout fault returns `unknown`; the faithful timeout
    category comes from `classifyPromptTimeout(30000)` → `prompt_timeout`.
- **Hidden mechanism:** the timeout classification provenance (`classifiedFailureBy`) is not
  recorded today.
- **`mechanismTokens`:** `["timeout","30000","prompt_timeout"]`.

## Reproducing the freeze

The historical fixture was extracted from `daemon.1.log` lines 95–628 and scrubbed by a field-aware
transform (hostname/pid/instanceId/profileId/preview rewrite + a `/Users/<name>/` and email string
sweep), then verified with `scanForSecrets`. The 4 live fixtures are synthesized from the
`makeFaultInjector` + `classifyError` product path (see each section above) and frozen once — the
cassette pattern (`test/live/cassette.ts`): faithful via the real classify path, deterministic on
replay. Only the baseline RUN ledger under `benchmarks/live/` is git-ignored; this corpus IS committed.
