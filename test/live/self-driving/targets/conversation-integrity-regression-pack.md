# Target — conversation integrity regression pack

Use this pack whenever a campaign exercises setup, approvals, background work, localization,
credentialed integrations, aggregate reports, or observability. It is deliberately domain-neutral:
the entity sets may be vehicles, tickets, devices, invoices, or any other stable identifiers.

The pack closes a common testing blind spot: a turn can produce a plausible final answer while the
interactive controls, deterministic notices, cost, or aggregate evidence are wrong. Run it against
the exact conversation, not a clean synthetic session assembled after the fact.

## One-command conversation verdict

After driving the conversation, run:

```sh
node scripts/conversation-audit.mjs "$CHATID" runs/<run>/conversation-contract.json
```

The command resolves the real nested session through its provenance ledger and trajectory pointer,
loads the exact wire transcript from the Telegram emulator, assembles the session's offline incident
report, and emits a content-free verdict. It exits non-zero for:

- approval controls left actionable in their final wire state;
- background promotion while a correlated human approval is open;
- configured fallback-language strings visible under another locale;
- a neutral canary persisted in session, trajectory, or wire evidence;
- a row-level set, coverage, or partition assertion contradicted by the source entities;
- model-call, input-token, or cost budgets exceeded;
- unmatched approval, tool, or background lifecycle records;
- a failed tool result omitted by the incident report;
- missing wire, trajectory, incident, or parseable JSONL evidence.

`conversation-audit.mjs` never prints message bodies, callback capabilities, tool payloads, or canary
values. Do not place real credentials in a contract. For live credentials, use the encrypted-store
name with `node scripts/secret-residency.mjs SECRET_NAME`; its zero-match exit is the residency
oracle.

## Contract shape

Contracts belong in the run directory and contain only neutral or redacted identifiers. Build the
entity sets from the row-level tool result the model actually saw in the raw session JSONL. Never
infer entity identity from equal aggregate counts.

```json
{
  "expectedLocale": "he",
  "forbiddenSurfaceTexts": [
    "This callback is no longer valid",
    "Background work is still running"
  ],
  "budgets": {
    "maxModelCalls": 8,
    "maxInputTokens": 120000,
    "maxCostUsd": 1.5
  },
  "grounding": {
    "entitySets": {
      "fleet": ["entity_a", "entity_b", "entity_c", "entity_d"],
      "fresh": ["entity_a", "entity_b", "entity_c"],
      "recent": ["entity_a"],
      "aged": ["entity_b", "entity_c"],
      "stale": ["entity_d"],
      "no_transmissions": ["entity_a"]
    },
    "assertions": [
      {
        "id": "reported_fresh_coverage",
        "kind": "set_covers",
        "claimed": true,
        "set": "fresh",
        "universe": "fleet"
      },
      {
        "id": "reported_same_entities",
        "kind": "sets_equal",
        "claimed": true,
        "left": "stale",
        "right": "no_transmissions"
      },
      {
        "id": "freshness_buckets",
        "kind": "partition",
        "whole": "fleet",
        "parts": ["recent", "aged", "stale"]
      }
    ]
  }
}
```

The contract above must fail the coverage and equality assertions: one entity is stale, and the
stale set is different from the equally sized no-transmissions set. The partition still passes.
This separation prevents three misleading shortcuts: complete rows do not imply fresh telemetry;
equal counts do not imply the same entities; and an exclusive middle-age bucket must not be labelled
as the inclusive total for the day.

## Mandatory rows

| Behavior | Drive | Ground-truth predicate | Oracle |
|---|---|---|---|
| First setup and capability claims | Start from an empty workspace, install/connect a neutral fixture, then ask what is available | every claimed file count, revision pin, capability count, mode, and read/write limit matches durable state and live discovery | workspace + registry + tool discovery vs wire claim |
| Approval control lifecycle | Trigger approve and deny paths with `approve-pending.mjs` | the callback succeeds once; the first post-tap mutation explicitly removes controls or deletes the prompt within the configured retirement budget; replay is rejected without a second visible button | approval driver latency verdict + wire + approval trajectory |
| Approval-aware background timing | Hold a request at approval longer than the auto-background threshold | no correlated `background_task.promoted` occurs before `approval.resolved`; unrelated work remains independent | conversation audit + trajectory timestamps |
| Deterministic locale fidelity | Choose a non-English operator locale and trigger approval, invalid callback, pending, background, recovery, and completion notices | every deterministic surface uses the resolved locale pack; no default-language fallback is visible | contract fallback list + exact wire transcript |
| Secret reference integrity | Configure a neutral credential through the secret store and exercise doctor, connect, restart, and use | values have zero plaintext residency; reference identifiers remain accepted as references and are never diagnosed as leaked values | `secret-residency.mjs` + doctor + config projection |
| Equal-count collision | Seed two disjoint entity sets with the same count and request both a summary and the names | the response never joins them as the same entities without row-level identity evidence | raw tool-result entities + `sets_equal` assertion |
| Completeness versus freshness | Return complete rows with at least one stale timestamp | coverage and freshness are reported as separate dimensions; fetch age and source-report age stay distinct | `set_covers` assertion + source timestamps |
| Exclusive time buckets | Create recent, middle-age, and stale rows | bucket labels state their exact interval; sets are disjoint and their union equals the universe | `partition` assertion + quoted labels |
| Recovery remains visible | Make the first tool call fail validation and the corrected retry succeed | final work may succeed, but the failed attempt remains in trajectory and incident-report failures | trajectory call/result pairs vs incident report |
| Cost multiplier | Replay a fixed representative conversation from a clean state | model calls, input tokens, and cost stay within an explicit baseline; background continuations cannot multiply calls silently | conversation audit budgets + previous run |
| Lens reconciliation | Close the conversation, then inspect reply, wire, session, trajectory, incident report, and system health | counts and outcomes reconcile; any unsupported lens states reduced coverage rather than a clean pass | conversation audit, then daemon-wide health |

For every row, neutralize the behavior under test once and prove the oracle turns red. An empty wire,
missing incident report, unreadable line, or unsupported ground-truth set is a failed row—not a skip
and never a pass.
