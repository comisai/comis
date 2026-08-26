# Changelog

This file records user-visible changes to Comis. Detailed release history is available in [GitHub Releases](https://github.com/comisai/comis/releases).

## [Unreleased]

## [1.0.64] - 2026-08-26

### Added

- Capability services: an operator can install a separate process that contributes agent tools and owns durable external work, connected over an authenticated Unix socket with per-scope authority. Configured under `capabilityServices`, a runtime-immutable section. `comis capability-services list` and `get` show the host half of that relationship — whether authority bound, which records the host holds, and whether the service is still reporting.
- Managed runs: external work bound to the daemon survives restarts as durable, content-free records, with atomic admission, approvals, verified evidence, attention, continuations, and workspace leases. `comis managed-runs` lists, explains, and cancels them; `comis managed-attention` covers the runs waiting on a human.
- Every release carries the capability-service protocol bundle and its manifest sidecar, so a companion service can pin the exact contract bytes by digest.
- `comis explain` gains a `managedRuns` block linking a session to the runs it prepared, and `comis system-health` gains a `capabilityServices` block with a managed-run degradation finding — counts, closed reason codes, and one run id only, never a report body, workspace path, objective, or credential.

### Security

- Operator approval rules are enforced. `approvals.rules` and `approvals.defaultMode` were parsed and documented as evaluated in order, first match wins, but nothing read them — an operator could write a `deny` rule, get a clean config load, and be silently unprotected. A first-match evaluator now runs inside the approval gate, ahead of the approval and denial caches: a `deny` resolves without prompting and outranks a cached approval, an `auto` rule below its trust floor asks a human instead, and an action no rule matches falls to `approvals.defaultMode`.
- `approvals.defaultMode` defaults to `require` rather than `auto`, so enabling approvals no longer auto-approves every unmatched destructive action.
- A rule's `minTrustLevel` uses the runtime trust levels — `guest`, `user`, `admin` — replacing a vocabulary that matched none of them and so never gated anything.
- Boot warns, naming the exact setting, when rules exist while the gate is off, or when `approvals.defaultMode: auto` turns the rule list into a denylist.

### Fixed

- A tool result carrying only an image no longer collapses to "Tool returned no text content": a server returning a screenshot over MCP reaches the model as a sanitized, bounded image block, and a mixed result keeps its text first.
- Sub-agent and background completion delivery keeps its guarantees under failure — governed reservations, idempotent receipts, bounded dead-letter retry with quarantine, and restart-safe recovery of both chunks and attachments.
- A terminal attachment relay survives replacement of the worker behind it instead of stranding the session.

### Changed

- The web Security view's Rules tab renders the live approval policy read-only — gate state, the mode for unmatched actions, and each rule's pattern, mode, and trust floor — replacing an editor that wrote a settings key no runtime code read.

## [1.0.63] - 2026-08-17

### Fixed

- A delegated run's output and its recovery handoff keep their ownership across the sub-agent boundary, so a partial delegation is reported as partial instead of as a clean completion, and a verified background result is no longer discarded on the way back to the conversation.
- A delegation that has already been accepted no longer starts a second continuation, and handing work to the background ends the foreground turn instead of running the same work twice.
- Internal spawn handles no longer leak into a reply.
- A parent's remaining work survives a delegation rather than being abandoned once the child returns.
- Runs that outlive a restart are resumed, a wait on a child is event-driven instead of polled, and steering a step that has already finished is treated as a no-op rather than an error.
- Announcement delivery keeps its evidence through a recovery, and an attachment that failed to deliver is surfaced instead of passing silently.
- A narrowed delivery identity stays narrow through orchestration instead of being widened at the handoff.
- `comis explain` stays within its size cap on large sessions, reports the most recent execution of a child that was resumed, and describes a prompt-skill routing stall and a generic tool-invocation stall instead of falling back to a repeated-action account.
- Web source exclusions are honored — a single listed exclusion, a compound exclusion, and exclusions named in a live report.
- A skill route offered as advice stays advisory instead of binding the turn, and the wording of a delegated child's task no longer captures the parent's routing.
- Model-status matching is scoped to the model actually serving the request instead of matching scattered tokens, and a corrected model status is recorded.
- A spawn rejected by profile validation can be retried instead of ending the attempt.

## [1.0.62] - 2026-08-14

### Fixed

- A receipt-grounded recovery answer now survives to delivery, so a prompt-skill answer is no longer lost after a recovery.
- A report assembled from several tool calls keeps the grounding it did collect instead of being dropped wholesale when part of the set fails, and fleet evidence and diagnostics are preserved through the analysis path.
- Waiting behind a busy MCP queue is no longer counted as a server failure, so queue contention cannot trip the circuit breaker, and configured concurrency bounds survive reconciliation instead of being reset.
- Queue contention is named in the incident report with complete diagnostics rather than being ranked behind an unrelated cause.
- A specialized prompt-skill route is preserved instead of collapsing to the general route, and an excluded source is no longer reached through the coordinated web path.
- A grounded route-stall verdict is no longer overwritten by a weaker one, and it names the recovery route that was taken.

### Changed

- `comis explain` can now tell tools that were merely offered apart from tools that were actually activated, from a counts-only reconciliation receipt — a mismatch that was previously invisible.

## [1.0.61] - 2026-08-13

### Fixed

- A delegated sub-agent turn resolves who owns its approval callback, so the approval reaches the sub-agent instead of deadlocking the run.
- One session's failing tool no longer degrades an unrelated session.
- Children orphaned by a parent that ended are cancelled, and a run is torn down deepest-first so the cascade cannot take the blame from the node that actually failed.
- A run legitimately waiting on live children is exempt from the stuck sweep instead of being reaped.
- The step-limit message names the setting that actually bound the run.
- A delivered sub-agent answer is announced as delivered rather than as a failure.
- A reply that comes back in the wrong script is delivered as degraded instead of ending the turn.
- A soft degradation no longer downgrades a hard failure in the session rollup.
- A turn that died before it finalized is no longer attributed to a recall miss.
- Spawn rejection suggests the narrowest privilege ceiling that actually reaches the required tools instead of escalating to full privilege, and unreachable tools produce one coherent re-spawn instruction rather than contradictory per-tool advice.
- The circuit-breaker block message no longer nests inside itself.
- Quarantined announcements are loaded from disk before being listed, so one parked by an earlier daemon process is visible, and a resolved quarantine leaves a legible trail instead of disappearing.
- Evidence from a delegated research run, and completion handling for scheduled runs, are corrected.

### Changed

- The default sub-agent step ceiling is raised to 300 so a research delegation can finish within it.
- A successful dead-letter queue delivery is logged at the default level, so a drain is visible without turning on debug logging.

### Added

- `comis quarantine` lists and releases parked announcements, and the dead-letter queue gains list and release operations — a quarantined announcement previously had no operator lever at all.

## [1.0.60] - 2026-08-12

### Security

- The secret-entropy backstop judges a candidate by its structure instead of by the presence of a delimiter, so source expressions are no longer flagged while password punctuation stays covered.
- Live-test provider probes shaped like cyber-abuse scenarios are suspended by default and can only be unlocked by an explicit operator acknowledgement for that run, through a single fail-closed gate that is never written to configuration (`COMIS_LIVE_TEST_RISK=cyber-abuse` plus `COMIS_LIVE_CYBER_ABUSE_TESTS=operator-authorized`).

### Fixed

- Replies that claim an audio or image was produced, or that a delivery succeeded, must carry an authoritative receipt from the tool that would have produced it; a backgrounded spawn or an internal voice route is no longer accepted as proof of synthesis. Cost, provider-invoice, and cross-run duration answers are refused when the runtime cannot support them, instead of being accepted merely because an observability query was made.
- Prompt-skill routing no longer arms on the wrong evidence — recalled history, backgrounded completions, extracted content, and generic stopwords stop triggering the request-a-tool nudge, and citation evidence is taken from the current turn's receipts.
- Recall keeps prose without spaces searchable while refusing to inherit opaque payloads.
- Degraded replies and input-guard refusals are translated like every other reply.
- Long-retention cache markers are anchored explicitly, lookback cache-tail markers are protected from being starved out, and message retention is capped to the life of the run it belongs to; auxiliary and utility calls no longer disturb shared cache state.
- A stalled prompt pauses for operator approval instead of timing out, and the auto-background timer is held while an approval is pending.
- A large result whose offload failed stays inline instead of being silently lost, and offload artifacts are labeled by payload type.
- Billing for a timed-out request is attributed to the trace that issued it rather than left orphaned.
- Graph and sub-agent delegation carries an explicit completion contract end-to-end: notification is promised only where both an announcement route and durable delivery exist, and the incident report states which of the two actually happened, along with the session it happened in.
- A terminal execution failure now outranks an incidental recall miss when the incident report names the likely cause.
- Bare links with IPv6 hosts are parsed with the host intact.
- `web_search` names the exact missing provider credential or setting instead of reporting a generic unavailability.
- The live conversation audit fails closed when it finds no session evidence, instead of discarding evidence it could have read.

### Changed

- The system health view reports when the skill execution sandbox is turned off (`skills.execSandbox.enabled: "never"`).
- `comis explain` records when a turn asked the user for clarification, what recall did with its results, and when a route was rejected as invalid; its completion-evidence and tool-invocation verdicts were reworked.

### Added

- Every successful attachment send is published to after-delivery hooks with the delivering channel recorded, and a hook failure is reported as a dependency warning rather than as a failed delivery.
- Skill manifests can require a minimum number of distinct web fetches or distinct search queries (`comis.min-distinct-web-fetch-urls`, `comis.min-distinct-web-search-queries`); a malformed value is ignored instead of hiding the skill.
- Two self-driving simulator workloads for the live test kit: daily-assistant journeys, and artifact-to-action journeys covering healthy, degraded, provenance, exact-revision authorization, and single commit-and-read-back cases.

## [1.0.59] - 2026-08-07

### Security

- Replies are bound to the endpoint the request was observed on, so a granted send cannot be redirected to another conversation, and a shared chat's owner is resolved from the authenticated principal rather than from the chat.
- Administrative memory search, dialectic tools, and session history enforce the operator profile gate and derive their search scope from the authenticated caller instead of trusting the request.
- Secrets encoded inside a completion are scrubbed before the reply leaves the runtime, and credential results are no longer carried into background tasks.
- `pdfjs-dist` moves to 6.2.108, clearing a high-severity advisory that covered the previously pinned range.

### Fixed

- A conversation of short turns no longer re-buys its whole cached prefix after every pause. Cache-retention progress now carries across the turns of a conversation instead of resetting each turn, so an idle gap writes at the configured retention rather than expiring at five minutes.
- A turn whose output allowance was consumed by the thinking budget is told apart from one genuinely cut off mid-answer, and the reported cause names the setting that actually bound it.
- The conversation history horizon no longer shifts every turn, which had been rewriting the cached prefix even when nothing about the conversation changed.
- An answer that carries no script of its own — a table of numbers, a code block — is no longer discarded by the language gate as off-locale.
- Invalidated provider OAuth tokens are recognized as such, refreshed, and the interrupted request replayed once, instead of surfacing as an opaque failure; a refresh that stalls is cancelled rather than left running.
- Tool calls no longer fail before being issued when the configured call deadline is at or below the internal viability floor, and the refusal states the budget the call fell under.
- The agent no longer reports work as done, schedules as active, or sources as cited without evidence from the tool that would have produced it. Cron listings, schedule confirmations, and completion claims are grounded the same way.
- Background and sub-agent lifecycle: a killed sub-agent is recorded before teardown, an unresolved child process is no longer reported as success, duplicate child-failure disclosures are collapsed, and a hop-cap fallback explains itself.
- Missing speech-to-text and text-to-speech credentials are named by the exact setting that supplies them, a globally disabled vision path stays disabled, and vision requires an explicitly selected provider instead of falling back to one.
- Text extraction from PDFs no longer throws while releasing the document.
- A terminal drive's notifications are delivered to the conversation that started it rather than to the most recent one.
- A stuck dead-letter queue is reported once with its cause instead of on every sweep.

### Changed

- The pi SDK moves to 0.84.0.
- Provider registration carries sampling parameters through to the model call, and the Baseten credential is wired into both provider maps.
- Cache spend is reported split by retention tier, provider breaker trips are surfaced, and providers that bill uncached input separately no longer report it as zero.

## [1.0.58] - 2026-08-04

### Fixed

- Prompt-cache reuse on the Anthropic path is restored: the conversation prefix stays byte-stable across a turn instead of being rewritten on every tool cycle, so cached tokens are reused rather than re-sent.
- Sub-agent and MCP calls no longer collide over a shared deadline, and a hard runtime limit now reports the configuration key that set it, the value that expired, and the tool that was running, instead of a bare timeout message.
- A background task that exceeds its limit reports the failure as its own cause rather than as a dependency error, and states that partial work was not returned so an empty result is not read as an empty answer.
- Replies that arrived out of order, halted sub-agent accounts, and activity cards rendered in the wrong language are corrected; breaker and deadline events now reach the incident report instead of appearing only in logs.

### Changed

- Recall now resolves its tenant and agent partition from an explicit scope rather than inferring one from the session, so a caller that supplies no agent is rejected instead of silently searching an empty partition.

## [1.0.57] - 2026-08-01

### Fixed

- `comis init --config-dir` now isolates configuration detection, credential storage, generated files, and daemon startup instead of writing setup artifacts to the default home directory.

### Changed

- Fresh configurations use the private multilingual `bge-m3` embedder so semantic memory recall works across scripts without an external embedding service. The smaller English-centric nomic model remains an explicit setup choice.
- Bounded, sanitized recall-ranking diagnostics are enabled from first boot so recall incidents can be explained without reproducing them after a configuration change.
- Guided setup enables supported human-approval paths when it creates an administrator sender mapping, while configurations without an authorized responder keep the approval gate disabled.

## [1.0.56] - 2026-07-26

### Fixed

- `npm install -g comisai` works again. A global install nests every dependency where npm treats it as part of the umbrella package's bundle, so it skipped unpacking those packages while still scheduling their lifecycle scripts, and the install failed with an opaque `spawn sh ENOENT`. Bundled copies now ship inert.

### Changed

- Dependency updates across the tree, including the pi SDK.

## [1.0.55] - 2026-07-25

Aggregates the user-visible changes since 1.0.53, including those first published in the [v1.0.54 release](https://github.com/comisai/comis/releases/tag/v1.0.54).

### Added

- A focused public website, contributor onboarding, issue templates, and security reporting guidance.
- Clearer operator documentation for installation, configuration, providers, channels, and the supported API surfaces.

### Changed

- The Linux installer now supports a review-first workflow: download, inspect, run `--dry-run`, and then execute.
- The dashboard setup and configuration screens now expose only operations backed by the daemon.
- Public package documentation and metadata now describe the current source and package boundaries.

### Fixed

- Web search now derives its fallback chain from configured provider authority,
  skips missing-key providers, and tries each eligible provider sequentially.
  Only chain-wide exhaustion routes an enabled browser through Google Search.
- MCP schema and JSON-RPC invalid-parameter rejections are now reported as caller-correctable validation failures with a healthy transport, and their external-content envelope no longer causes the retry breaker to mark the server unavailable.
- New and recreated workspaces now enter first-run onboarding, and the active bootstrap state reaches prompt assembly instead of being omitted as an unchanged operator placeholder.
- Background tasks listed for an originating conversation can now be retrieved and cancelled only from that conversation; lookup and terminal task failures are reported as tool errors, and one blocking `read_output` call acknowledges a promoted call's terminal output only after the successful tool result is journaled, without repeating the original operation or entering a polling loop.
- Sub-agent spawns now return a run ID immediately; owner-scoped waits gather terminal results without polling, and durable exact-origin delivery retains completion, timeout, and failure reasons without contradictory notices.
- Cron jobs and heartbeats now execute through activated proactive runtimes with strict authoring and status contracts, configured timeouts, durable run evidence, and session-level diagnostics.
- Verified files declared in a sub-agent's `expected_outputs` are delivered as governed channel attachments when the task completes, including when the parent rewrite produces no text or fails before delivery; synthetic parent turns accept their workspace-policy hash without failing completion delivery.
- JSONL-backed conversations now retain ownership of promoted tool completions even when the SQLite session index has no row: completions re-enter the originating conversation, pending turns cannot finalize unrelated recalled text, failed tasks are labeled accurately, and MCP results above 8 KB are offloaded for file-based analysis.
- Promoted tool completions now retain the originating response-locale policy and deliver the finalized continuation through the exact captured channel instance and conversation authority.
- Incomplete tool-use history is repaired without inventing a daemon-restart cause.
- Session explanations prioritize an unfinished background continuation over incidental recall misses and point operators to its promotion, completion, re-entry, and delivery evidence.
- Provider status, CLI setup guidance, token-limit labels, and degraded-response instructions now reflect the runtime behavior.
- Dashboard controls have clearer accessible names and reduce accidental secret exposure.
- Gateway RPC failures no longer return internal exception details to clients.
- The installer now fails closed on incomplete prerequisites and validates the installed CLI before reporting success.

### Security

- Installation guidance avoids executing remote scripts without an inspection and dry-run step.
- Labelled password, token, secret, credential, and API-key assignments are blocked from learned memory and redacted again during recall, including ordinary credential values without a provider-specific token prefix.
- Error responses and dashboard secret handling expose less sensitive operational detail.

### Operator action required

- Session JSON-RPC clients must identify storage partitions with
  `tenant_id`, `agent_id`, and `conversation_ref` instead of a display
  `session_key`; see the [JSON-RPC reference](https://docs.comis.ai/reference/json-rpc).

## [1.0.53] - 2026-07-13

See the [v1.0.53 release](https://github.com/comisai/comis/releases/tag/v1.0.53) for its generated notes and artifacts.

[Unreleased]: https://github.com/comisai/comis/compare/v1.0.64...HEAD
[1.0.64]: https://github.com/comisai/comis/releases/tag/v1.0.64
[1.0.63]: https://github.com/comisai/comis/releases/tag/v1.0.63
[1.0.62]: https://github.com/comisai/comis/releases/tag/v1.0.62
[1.0.61]: https://github.com/comisai/comis/releases/tag/v1.0.61
[1.0.60]: https://github.com/comisai/comis/releases/tag/v1.0.60
[1.0.55]: https://github.com/comisai/comis/releases/tag/v1.0.55
[1.0.53]: https://github.com/comisai/comis/releases/tag/v1.0.53
