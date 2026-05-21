---
phase: 49-skills-critical-fixes
plan: 02
subsystem: skills/daemon
tags: [security, prompt-injection, media-handlers, wrap-external-content, daemon-plumbing, tdd]

# Dependency graph
requires: [49-01]
provides:
  - "media-handler-image.ts wraps analyzer-fallback path with wrapExternalContent({ source: 'vision' })"
  - "media-handler-audio.ts wraps preflight + live STT paths with wrapExternalContent({ source: 'voice_transcription' })"
  - "media-handler-video.ts wraps describer success path with wrapExternalContent({ source: 'video_description' })"
  - "ImageHandlerDeps, AudioHandlerDeps, VideoHandlerDeps declare onSuspiciousContent? optional field"
  - "media-preprocessor.ts forwards onSuspiciousContent into audio/image/video inline deps objects"
  - "Daemon plumbing chain wired: AgentsHandle → buildChannelManagerDeps → ChannelsDeps → buildMediaPipeline → MediaPipelineDeps → destructure → preprocessMessage deps literal"
affects:
  - 49-03 (MCP bridge — uses same chain pattern + the 'mcp_tool' source value from 49-01)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "wrap-on-success-only: textPrefix returned from each handler success branch wraps; degraded/failure hint strings stay unwrapped (daemon-authored, not external content)"
    - "vision-direct bypass: when visionAvailable=true and image ships as native multimodal block, NO wrap (would be a category error to wrap an ImageContent block)"
    - "truncate-then-wrap order: video description is sliced to maxVideoDescriptionChars BEFORE wrapExternalContent so the cap measures content, not wrapping markers"
    - "shorthand destructure forwarding: 5 daemon-side hops use { onSuspiciousContent } shorthand to thread the single field through 5 interface boundaries — no rename, no transformation"

key-files:
  created:
    - ".planning/phases/49-skills-critical-fixes/49-02-SUMMARY.md"
  modified:
    - "packages/skills/src/tools/integrations/media-handler-image.ts"
    - "packages/skills/src/tools/integrations/media-handler-image.test.ts"
    - "packages/skills/src/tools/integrations/media-handler-audio.ts"
    - "packages/skills/src/tools/integrations/media-handler-audio.test.ts"
    - "packages/skills/src/tools/integrations/media-handler-video.ts"
    - "packages/skills/src/tools/integrations/media-handler-video.test.ts"
    - "packages/skills/src/tools/integrations/media-preprocessor.ts"
    - "packages/skills/src/tools/integrations/media-preprocessor.test.ts"
    - "packages/daemon/src/wiring/setup-channels-media.ts"
    - "packages/daemon/src/wiring/setup-channels-media.test.ts"
    - "packages/daemon/src/wiring/setup-channels/setup-channels-registry.ts"
    - "packages/daemon/src/stages/channels-helpers.ts"

key-decisions:
  - "Did NOT wrap the vision-direct path in media-handler-image.ts — it ships ImageContent multimodal blocks (not prompt text), and wrapping there would be a category error. Vision-direct is a model-level boundary problem, separate from prompt-injection-via-text."
  - "Did NOT wrap the degraded-fallback string in media-handler-audio.ts L92 ('[Voice message received but transcription failed — ask the user to send a text message instead]') — that's a fixed daemon-authored hint, not external content."
  - "Updated 4 pre-existing tests that used exact-string assertions (.toBe('[Image analysis]: ...')) to use .toContain(...) — the wrap injects UNTRUSTED_<hex> markers + SECURITY NOTICE footer around the text, so exact-match no longer applies. Treated as Rule-1 auto-fix (test breakage directly caused by the wrap addition); the new behavior is the contract."
  - "Document branch in media-preprocessor.ts L241 was ALREADY correctly forwarding onSuspiciousContent (from earlier work). Task 3 only adds the 3 missing audio/image/video forwarding hops; document branch is touched only by a regression-guard test."

patterns-established:
  - "wrap-on-success: every handler's textPrefix-emitting success branch wraps; failure/degraded branches return un-wrapped hints (text emitted by us, not by the provider)"
  - "5-hop daemon plumbing for callback wiring: AgentsHandle.X → buildChannelManagerDeps destructure → ChannelsDeps.X field → buildMediaPipeline arg → MediaPipelineDeps.X field+destructure → preprocessMessage deps literal. Each hop adds 1 destructure + 1 shorthand field-or-return."

requirements-completed: [CRIT-01]

# Metrics
duration: ~10 min (4 commits)
completed: 2026-05-21
---

# Phase 49 Plan 02: Media-Handler Wrap + Daemon Plumbing Summary

**Closed 4 of 5 CRIT-01 wrap bypass sites in the media handlers (vision/STT/video) AND completed the 5-hop daemon-side `onSuspiciousContent` plumbing chain — adversarial OCR text, spoken injection instructions, and forged video-frame instructions now land in agent prompts WRAPPED with `<<<UNTRUSTED_xxx>>>...<<<END_UNTRUSTED_xxx>>>` boundary markers, and the `onSuspiciousContent` callback fires end-to-end in production.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-21T21:25:38Z
- **Completed:** 2026-05-21T21:40:00Z (approximate)
- **Tasks:** 5 (RED + GREEN handlers + GREEN preprocessor + GREEN daemon + VALIDATE)
- **Commits:** 4 atomic (test → feat → feat → feat)
- **Files modified:** 12

## Accomplishments

### Skills package — handler-level wraps (3 source + 3 test files)

- **`media-handler-image.ts:99-108`** — analyzer-fallback success branch wraps the `[Image analysis]: ${result.value}` line with `wrapExternalContent({ source: "vision", onSuspiciousContent: deps.onSuspiciousContent })`. Vision-direct path at L46-82 (visionAvailable=true) is INTENTIONALLY UNWRAPPED — it ships native multimodal `ImageContent` blocks, not prompt text.
- **`media-handler-audio.ts:46-55, 64-82`** — BOTH the preflight reuse branch (att.transcription already set) AND the live STT success branch wrap `[Voice message transcription]: <text>` with `wrapExternalContent({ source: "voice_transcription", onSuspiciousContent: deps.onSuspiciousContent })`. The degraded-fallback string at L92 is NOT wrapped (daemon-authored).
- **`media-handler-video.ts:60-75`** — describer-success branch wraps the truncated `[Video description]: <description>` with `wrapExternalContent({ source: "video_description", onSuspiciousContent: deps.onSuspiciousContent })`. Truncation happens BEFORE the wrap so `maxVideoDescriptionChars` measures content, not wrapping markers.
- **3 Deps-interface field additions:** `ImageHandlerDeps`, `AudioHandlerDeps`, `VideoHandlerDeps` each declare `readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"]`. Mirrors the canonical `DocumentHandlerDeps` analog at `media-handler-document.ts:29`.

### Skills package — media-preprocessor forwarding (1 source + 1 test file)

- **`media-preprocessor.ts:226, 230, 235`** — added `onSuspiciousContent: deps.onSuspiciousContent` to the audio/image/video inline deps objects. The document branch at L240 was ALREADY correctly forwarding the field (touched only by a new regression-guard test).
- Net result inside skills: `MediaProcessorDeps.onSuspiciousContent` (declared L82) is now forwarded identically across all 4 attachment kinds: audio, image, video, document.

### Daemon package — 5 plumbing hops (4 files)

The 5 missing hops between `AgentsHandle.onSuspiciousContent` (declared at `daemon-types.ts:362`, built in `agents-helpers.ts:buildAuditBundle`) and the inline `preprocessMessage(...)` deps literal:

1. **`channels-helpers.ts:65, 80`** — `buildChannelManagerDeps` destructures `onSuspiciousContent` from `agents: AgentsHandle` (L65) and includes it (shorthand) in the returned `ChannelsDeps`-shaped object (L80).
2. **`setup-channels-registry.ts:16, 132-134`** — `ChannelsDeps` interface declares the new optional field with `WrapExternalContentOptions["onSuspiciousContent"]` typing. `WrapExternalContentOptions` added to the `@comis/core` type import (L16).
3. **`setup-channels-registry.ts:242`** — `buildMediaPipeline(...)` call site passes `onSuspiciousContent: deps.onSuspiciousContent` (last argument in the deps literal).
4. **`setup-channels-media.ts:12, 80-83, 107`** — `MediaPipelineDeps` interface declares the field (L80-83); `WrapExternalContentOptions` added to the import (L12); destructure block extracts `onSuspiciousContent` (L107).
5. **`setup-channels-media.ts:365`** — inline `preprocessMessage(...)` deps literal forwards `onSuspiciousContent` as a shorthand field (variable in scope from the destructure).

Plus 2 new daemon tests in `setup-channels-media.test.ts` that mock `preprocessMessage` and assert (a) the callback is forwarded when provided, and (b) `undefined` is forwarded when not provided.

### Wrap source-kind attribution

Per CRIT-01 the `onSuspiciousContent` callback now fires with the correct per-handler `source` value:

| Handler | source value | Threat covered |
| --- | --- | --- |
| `media-handler-audio.ts` (preflight + live STT) | `"voice_transcription"` | T-49-02-01 — spoken adversarial instructions |
| `media-handler-image.ts` (analyzer-fallback) | `"vision"` | T-49-02-02 — adversarial OCR text in image |
| `media-handler-video.ts` (describer-success) | `"video_description"` | T-49-02-03 — forged instructions in video frames |
| `media-handler-document.ts` (pre-existing) | `"document"` | (regression-guarded by new preprocessor test) |

## Task Commits

Each task atomically committed. TDD gate sequence: `test(49-02) → feat(49-02) → feat(49-02) → feat(49-02)` (Task 5 is no-commit validation).

1. **Task 1 (RED): Add wrap-marker + onSuspiciousContent-fires assertions** — `b703add5` (test)
   - 9 new it() cases across 3 handler test files (4 audio + 3 image + 2 video).
   - 8 tests fail RED on the pre-fix tree; 1 image test ("does NOT wrap visionAvailable=true") passes RED because vision-direct already returns undefined textPrefix — that's the contract under test.
   - 3 files changed, 166 insertions.

2. **Task 2 (GREEN): Wrap 4 call sites + 3 Deps-interface fields** — `808d8d9f` (feat)
   - Atomic 3-file source edit + 3-file test fix (`.toBe()` → `.toContain()` for the 4 exact-match pre-existing assertions invalidated by the wrap markers).
   - 9 RED tests all GREEN; 33/33 handler tests pass.
   - 6 files changed, 37 insertions, 9 deletions.

3. **Task 3 (RED→GREEN): media-preprocessor forwarding** — `c58ef977` (feat)
   - 4 new it() cases in `describe("onSuspiciousContent forwarding (CRIT-01)")` block (audio + image + video + document regression guard).
   - 3 tests fail RED, document test passes RED; all 4 GREEN after the L226/230/235 `onSuspiciousContent: deps.onSuspiciousContent` additions.
   - 73/73 preprocessor tests pass.
   - 2 files changed, 117 insertions, 3 deletions.

4. **Task 4: Daemon plumbing (5 hops)** — `d5fc458f` (feat)
   - 4 daemon-source files: `setup-channels-media.ts`, `setup-channels-media.test.ts`, `setup-channels-registry.ts`, `channels-helpers.ts`.
   - 2 new daemon tests assert `preprocessMessage` is called with the forwarded `onSuspiciousContent` (or undefined).
   - 10/10 setup-channels-media tests pass; 616/616 daemon-wiring tests pass; 2597/2597 full daemon suite pass.
   - 4 files changed, 68 insertions, 2 deletions.

5. **Task 5 (VALIDATE)** — no commit (validation-only).
   - `pnpm --filter @comis/skills build` ✓
   - `pnpm --filter @comis/skills vitest run` ✓ (4095 pass, 5 skipped)
   - `pnpm --filter @comis/daemon build` ✓
   - `pnpm --filter @comis/daemon vitest run` ✓ (2597 pass)
   - `pnpm lint:security` exit 0 (1663 pre-existing warnings, 0 errors — same baseline as 49-01).
   - `pnpm cycles` exit 0 (no circular dependencies; processed 1194 files).

## Files Created/Modified

- `packages/skills/src/tools/integrations/media-handler-image.ts` — added `wrapExternalContent` + `WrapExternalContentOptions` import; extended `ImageHandlerDeps` with optional `onSuspiciousContent`; wrapped the analyzer-fallback success branch.
- `packages/skills/src/tools/integrations/media-handler-image.test.ts` — added 3 new it() cases (UNTRUSTED_ marker, vision-direct NOT wrap, onSuspiciousContent fires with source=vision); updated 1 pre-existing exact-match assertion to `.toContain`.
- `packages/skills/src/tools/integrations/media-handler-audio.ts` — consolidated `@comis/core` imports (added `wrapExternalContent` + `WrapExternalContentOptions` alongside existing `systemNowMs`); extended `AudioHandlerDeps`; wrapped both the preflight reuse branch AND the live STT success branch.
- `packages/skills/src/tools/integrations/media-handler-audio.test.ts` — added 4 new it() cases (UNTRUSTED_ on preflight + live STT, callback fires with source=voice_transcription on both); updated 2 pre-existing exact-match assertions.
- `packages/skills/src/tools/integrations/media-handler-video.ts` — added `wrapExternalContent` + `WrapExternalContentOptions` import; extended `VideoHandlerDeps`; wrapped the describer-success branch (truncate BEFORE wrap).
- `packages/skills/src/tools/integrations/media-handler-video.test.ts` — added 2 new it() cases (UNTRUSTED_ on success, callback fires with source=video_description); updated 1 pre-existing exact-match assertion.
- `packages/skills/src/tools/integrations/media-preprocessor.ts` — added `onSuspiciousContent: deps.onSuspiciousContent` to the audio/image/video inline deps objects at L226-237 (3 hops added; document branch at L240 was already correct).
- `packages/skills/src/tools/integrations/media-preprocessor.test.ts` — added `describe("onSuspiciousContent forwarding (CRIT-01)")` block with 4 it() cases (audio + image + video + document regression guard).
- `packages/daemon/src/wiring/setup-channels-media.ts` — added `WrapExternalContentOptions` to `@comis/core` type import; added optional `onSuspiciousContent` field to `MediaPipelineDeps`; extended the destructure block; forwarded the field into the inline `preprocessMessage(...)` deps literal at L365.
- `packages/daemon/src/wiring/setup-channels-media.test.ts` — added 2 new it() cases at the end of `describe("buildMediaPipeline")` asserting `preprocessMessage` is called with the forwarded `onSuspiciousContent` (or undefined when absent).
- `packages/daemon/src/wiring/setup-channels/setup-channels-registry.ts` — added `WrapExternalContentOptions` to the `@comis/core` type import; added optional `onSuspiciousContent` field to `ChannelsDeps`; forwarded the field into the `buildMediaPipeline(...)` call argument at L242.
- `packages/daemon/src/stages/channels-helpers.ts` — extended the `agents` destructure block in `buildChannelManagerDeps` to extract `onSuspiciousContent`; added it (shorthand) into the returned `ChannelsDeps`-shaped object.

## Decisions Made

- **Vision-direct path NOT wrapped (T-49-02-02 design boundary).** When `visionAvailable=true`, the image is shipped as a native `ImageContent` multimodal block (base64 in metadata, not prompt text). Wrapping there would be a category error — there's no text to wrap, and the model sees the image as a vision input, not as a string. This is the model's own boundary problem (OCR-via-vision-LLM ≠ prompt injection via text). Reflected in test "does NOT wrap when visionAvailable=true".
- **Degraded-fallback hint at media-handler-audio.ts:92 NOT wrapped.** The string "[Voice message received but transcription failed — ask the user to send a text message instead]" is daemon-authored static text, not external content from a provider. Wrapping it would mislead the LLM into treating our own UX hint as untrusted. Per Plan 02's PATTERNS.md guidance.
- **Truncate BEFORE wrap in video handler.** Order: `result.value.text` → slice to `maxVideoDescriptionChars` → wrap. This means the cap measures DESCRIPTION CONTENT only; wrap markers + SECURITY NOTICE footer are uncapped (they are constant-overhead per-wrap, ~200 chars regardless of input). Matches the document handler's extract → format → wrap order.
- **Updated 4 pre-existing `.toBe()` exact-match assertions to `.toContain()`.** The wrap injects `<<<UNTRUSTED_<hex>>>>\n<security notice>\n` before the bracketed text and `\n<<<END_UNTRUSTED_<hex>>>>` after, so exact-equality no longer holds. Treated as Rule-1 auto-fix because the breakage is directly caused by this commit's wrap-call addition. The new tests fully cover the wrap-marker contract; the 4 updated tests now cover content-preserved-inside-wrap, which is the orthogonal contract.
- **Document branch in media-preprocessor.ts:240 already correct.** Task 3 only adds the 3 missing audio/image/video hops. The document branch is touched only by a new regression-guard test (asserting callback fires with `source: "document"` for injection-pattern extracted text). Future refactors that remove the already-correct forwarding will fail this guard.
- **`WrapExternalContentOptions` imported in 2 daemon files** (setup-channels-media.ts + setup-channels-registry.ts) to type the new optional `onSuspiciousContent` field with the canonical `WrapExternalContentOptions["onSuspiciousContent"]` indexed-access pattern (mirrors `MediaProcessorDeps.onSuspiciousContent` in skills + `AgentsHandle.onSuspiciousContent` at daemon-types.ts:362). This keeps the type-source single (Plan 01 didn't add a separate `SuspiciousContentCallback` type alias — indexed access from the existing options type is the chosen idiom).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Pre-existing test contract break] Updated 4 pre-existing exact-match textPrefix assertions to use `.toContain()`**

- **Found during:** Task 2 (GREEN handler wrap). 4 pre-existing tests (`media-handler-audio.test.ts` "reuses att.transcription when preflight transcription exists" + "returns transcription on successful STT"; `media-handler-image.test.ts` "returns analysis on successful analyze"; `media-handler-video.test.ts` "returns description on successful describe") asserted `expect(result.textPrefix).toBe("[Image analysis]: ...")` etc.
- **Issue:** The wrap injects `<<<UNTRUSTED_xxx>>>` and `<<<END_UNTRUSTED_xxx>>>` markers around the text, so exact-equality fails after Task 2's source change.
- **Fix:** Changed `.toBe(...)` → `.toContain(...)` with explanatory comment. The new 9 RED-tests-turned-GREEN already lock the wrap-marker contract; the 4 updated tests now lock the content-preserved-inside-wrap contract (orthogonal coverage).
- **Files modified:** `media-handler-audio.test.ts`, `media-handler-image.test.ts`, `media-handler-video.test.ts`.
- **Commit:** `808d8d9f` (folded into Task 2 GREEN — same diff that introduced the wrap).
- **Rationale:** Pure test-contract update directly caused by this commit's wrap addition; not a deviation from plan intent (the plan implicitly required this — exact assertions are incompatible with the wrap markers).

**Total auto-fixed: 1 (4 assertions in 3 files, all folded into the Task 2 commit).**

**No other deviations.** Plan executed exactly as written: 9 RED tests → 9 GREEN tests + wrap landings → 3 preprocessor forwarding hops + 4 forwarding tests → 5 daemon plumbing hops + 2 daemon tests → targeted validation green.

## Issues Encountered

- **Worktree had no `node_modules/`** — first run required `pnpm install --frozen-lockfile`. Resolved in ~14 seconds.
- **Dependency packages required pre-build** before `@comis/daemon` could compile. Built in dependency order: `@comis/shared` → `@comis/core` → `@comis/observability` → `@comis/infra` → `@comis/memory` → `@comis/gateway` → `@comis/scheduler` → `@comis/agent` → `@comis/channels` → `@comis/orchestrator` → `@comis/skills` → `@comis/daemon`. Normal worktree-setup cost, not a plan deviation.
- **Vitest worker termination timeout in `config-handlers.test.ts`** — observed once during the full daemon test run (not on re-runs). Pre-existing infrastructure issue (the test file passes; it's the worker shutdown that times out). Not introduced by this plan.

## User Setup Required

None — pure source-tree change. No external service configuration, environment variables, or secrets needed.

## Threat Surface Scan

No new threat surface beyond what the plan's `<threat_model>` already covers. All threats T-49-02-01 through T-49-02-05 are mitigated by this commit set; T-49-02-06 (future 4th audio branch) remains "accept" out of scope; T-49-02-07 (callback never fires due to missing daemon plumbing) is now mitigated by Task 4.

## Next Phase Readiness

- **Plan 49-03 ready to land (Wave 2 — runs in parallel with 49-02 per the wave plan).** Its MCP-bridge wrap site uses the `"mcp_tool"` source value from 49-01's union extension, and its daemon-plumbing chain follows the same 5-hop pattern this plan established for media. The handler-side wrap + preprocessor-side forwarding patterns in this plan are reusable templates.
- **Phase 49 gate (`pnpm validate`)** deferred until Plans 03 + 04 also land per the phase plan. Plan 02's targeted validation (skills + daemon) is green.
- **No blockers** for downstream plans.

## Self-Check: PASSED

- File `packages/skills/src/tools/integrations/media-handler-image.ts` exists; `wrapExternalContent` import + 1 wrap call site + `source: "vision"` confirmed.
- File `packages/skills/src/tools/integrations/media-handler-audio.ts` exists; `wrapExternalContent` import + 2 wrap call sites + 2 `source: "voice_transcription"` confirmed.
- File `packages/skills/src/tools/integrations/media-handler-video.ts` exists; `wrapExternalContent` import + 1 wrap call site + `source: "video_description"` confirmed.
- File `packages/skills/src/tools/integrations/media-preprocessor.ts` shows `onSuspiciousContent: deps.onSuspiciousContent` appearing 4 times (audio + image + video + document).
- File `packages/daemon/src/wiring/setup-channels-media.ts` shows `onSuspiciousContent` at 3 sites (interface field, destructure, preprocessMessage call) + `WrapExternalContentOptions` import = 4 plumbing touch points.
- File `packages/daemon/src/wiring/setup-channels/setup-channels-registry.ts` shows `onSuspiciousContent` at 3 sites (import, interface field, buildMediaPipeline call argument).
- File `packages/daemon/src/stages/channels-helpers.ts` shows `onSuspiciousContent` at 2 sites (destructure, return-object shorthand).
- File `packages/daemon/src/wiring/setup-channels-media.test.ts` shows 2 new it() cases with `onSuspiciousContent` assertions.
- Commits `b703add5` (test), `808d8d9f` (feat), `c58ef977` (feat), `d5fc458f` (feat) all reachable from HEAD.
- `pnpm --filter @comis/skills vitest run` exits 0: 4095 pass, 5 skipped.
- `pnpm --filter @comis/daemon vitest run` exits 0: 2597 pass.
- `pnpm --filter @comis/skills build` and `pnpm --filter @comis/daemon build` both exit 0.
- `pnpm lint:security` exit 0 (1663 warnings, 0 errors — baseline).
- `pnpm cycles` exit 0 (no circular dependencies).

---
*Phase: 49-skills-critical-fixes*
*Plan: 02*
*Completed: 2026-05-21*
