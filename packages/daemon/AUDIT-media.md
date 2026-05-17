# MediaApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts:367–416`
**Construction site:** `packages/daemon/src/daemon.ts:1863` (`buildRpcDispatchDeps`); call site at `packages/daemon/src/daemon.ts:2066`
**Field count:** 12 (6 required + 6 optional + 0 stale-fallback)
**Location:** Co-located with @comis/daemon package. `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| visionRegistry | optional | media.analyze-image / vision-scope checks find zero providers; image-analysis RPCs return "no vision provider configured" | packages/daemon/src/api/types.ts:370 |
| mediaConfig | required | — | packages/daemon/src/api/types.ts:371 |
| ttsAdapter | optional | media.tts RPC fails with "TTS provider not configured"; TTS auto-mode tag matching is bypassed in outbound message rendering | packages/daemon/src/api/types.ts:387 |
| linkRunner | required | — | packages/daemon/src/api/types.ts:388 |
| resolveAttachment | optional | on-demand media tool handlers cannot fetch attachment payloads by URL; tool calls that depend on attachment bytes fail with "attachment not retrievable" | packages/daemon/src/api/types.ts:390 |
| transcriber | optional | media.transcribe RPC fails with "speech-to-text provider not configured"; voice messages flow through to the agent untranscribed | packages/daemon/src/api/types.ts:392 |
| fileExtractor | optional | media.extract_document RPC fails with "file extraction provider not configured"; document attachments are forwarded as raw bytes | packages/daemon/src/api/types.ts:394 |
| imageHandlerDeps | optional | image.generate RPC is not registered; image-generation features (Proactive v1 / IMGN) are disabled | packages/daemon/src/api/types.ts:400 |
| workspaceDirs | required | — | packages/daemon/src/api/types.ts:411 |
| defaultWorkspaceDir | required | — | packages/daemon/src/api/types.ts:412 |
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:413 |
| logger | required | — | packages/daemon/src/api/types.ts:416 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a media-pipeline subsystem (vision, TTS, STT, file extraction, image generation, attachment resolution) that the operator may leave unconfigured. Each handler short-circuits with a clear "<feature> not configured" error or a no-op pass-through; no field is a phantom code path.

## Summary

- **Pre-audit count:** 12
- **Final count:** 12 (6 required + 6 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `MediaApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
