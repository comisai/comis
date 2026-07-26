# Changelog

This file records user-visible changes to Comis. Detailed release history is available in [GitHub Releases](https://github.com/comisai/comis/releases).

## [Unreleased]

### Added

- Skills are now vetted before installation. Every file in a skill bundle is scanned, not just `SKILL.md`, and nothing is written to disk unless the result is acceptable for where the skill came from. The gate runs on all four install paths (`create`, `update`, `upload`, and `import`) and cannot be disabled — `skills.contentScanning` continues to govern load-time scanning only.
- Skill installs are now decided by origin as well as content. Skills you author yourself, skills imported from a remote source, and skills an agent writes at runtime are held to different bars: a warning in a remote skill asks for explicit confirmation, and a critical finding in one is refused outright and cannot be forced. The same finding in a skill you wrote asks rather than refuses. See [Security Scanning](https://docs.comis.ai/skills/security-scanning) for the full matrix.
- Comis now records where each installed skill came from — its origin, content hash, trust tier, and vetting result — in `~/.comis/installed-skills.json`. The record is owner-only and carries no skill text.
- Bundle structure is now checked at install: unsafe member paths, symlinks, binaries detected by content rather than by extension, and bundles that exceed size or file-count limits are all refused. New `skills.installVetting` settings tune those limits.
- `skills.update` accepts a `force` parameter, matching the other skill-install methods.

### Changed

- Skills whose frontmatter uses the community kebab-case spelling (`allowed-tools`, `argument-hint`) now install and load. They previously installed but failed validation when the agent tried to use them.
- Importing or uploading a skill can now be refused for content that was previously written to disk unexamined. Two failure shapes are distinct: one asks you to review the named findings and re-run with `force`, the other cannot be overridden.

### Fixed

- A skill with malformed frontmatter is now refused at install with an explanation. It previously installed successfully and then never appeared, leaving no indication of why.
- Skill imports are now checked against the SSRF guard, so an import URL resolving to a private or metadata address is refused rather than fetched.

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
