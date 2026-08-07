# Changelog

This file records user-visible changes to Comis. Detailed release history is available in [GitHub Releases](https://github.com/comisai/comis/releases).

## [Unreleased]

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

[Unreleased]: https://github.com/comisai/comis/compare/v1.0.55...HEAD
[1.0.55]: https://github.com/comisai/comis/releases/tag/v1.0.55
[1.0.53]: https://github.com/comisai/comis/releases/tag/v1.0.53
