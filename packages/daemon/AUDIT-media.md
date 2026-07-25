# MediaApiDeps Audit

**Generated:** 2026-05-12
**Status:** FINAL
**Interface source:** `packages/daemon/src/api/types.ts` (`MediaApiDeps`)
**Construction site:** `packages/daemon/src/daemon.ts` (`buildRpcDispatchDeps`)
**Field count:** 18 (6 required + 12 optional + 0 stale-fallback)
**Location:** Co-located with @comis/daemon package. `files: ["dist", "bundled-skills"]` in `packages/daemon/package.json` excludes from npm tarball.

## Field Classification

The table below uses a tight Markdown shape — `| <fieldName> | <required|optional> | <when-absent> | <evidence-link> |` — so the CI architecture test's line-split parser can read it with a simple regex.

| **Field** | **Classification** | **When-absent** | **Evidence-link** |
|-----------|--------------------|-----------------|-------------------|
| visionRegistry | optional | media.analyze-image / vision-scope checks find zero providers; image-analysis RPCs return "no vision provider configured" | packages/daemon/src/api/types.ts:370 |
| mediaConfig | required | — | packages/daemon/src/api/types.ts:371 |
| ttsAdapter | optional | media.tts RPC fails with "TTS provider not configured"; TTS auto-mode tag matching is bypassed in outbound message rendering | packages/daemon/src/api/types.ts:387 |
| getChannelAdapter | optional | tts.synthesize cannot auto-deliver synthesized audio to the caller's channel; it returns only the file path and the agent must send it via the message tool (the ISSUE-4 false-success regression risk) | packages/daemon/src/api/types.ts:389 |
| linkRunner | required | — | packages/daemon/src/api/types.ts:388 |
| resolveAttachment | optional | on-demand media tool handlers cannot fetch attachment payloads by URL; tool calls that depend on attachment bytes fail with "attachment not retrievable" | packages/daemon/src/api/types.ts:390 |
| transcriber | optional | media.transcribe RPC fails with "speech-to-text provider not configured"; voice messages flow through to the agent untranscribed | packages/daemon/src/api/types.ts:392 |
| fileExtractor | optional | media.extract_document RPC fails with "file extraction provider not configured"; document attachments are forwarded as raw bytes | packages/daemon/src/api/types.ts:394 |
| imageHandlerDeps | optional | image.generate RPC is not registered; image-generation features are disabled | packages/daemon/src/api/types.ts:400 |
| videoHandlerDeps | optional | video.generate RPC is not registered; video-generation (submit → async background poller → announce-on-complete) is disabled | packages/daemon/src/api/types.ts:618 |
| videoStatusHandlerDeps | optional | video.status RPC is not registered; the agent cannot poll an async video job's state (the read side of the video-generation lifecycle is disabled — video generation is off) | packages/daemon/src/api/types.ts:624 |
| workspaceDirs | required | — | packages/daemon/src/api/types.ts:411 |
| defaultWorkspaceDir | required | — | packages/daemon/src/api/types.ts:412 |
| defaultAgentId | required | — | packages/daemon/src/api/types.ts:413 |
| logger | required | — | packages/daemon/src/api/types.ts:416 |
| resolveAgentMainProvider | optional | image.analyze cannot resolve the agent's main provider for the vision ladder; the main-vision tier is skipped and `image_analyze` falls back to the vision registry | packages/daemon/src/api/types.ts:618 |
| mainModelIdFor | optional | the daemon-side vision-capability gate cannot resolve the main model id; `image_analyze` treats the main as non-vision-capable and uses the registry tier | packages/daemon/src/api/types.ts:625 |
| mainProviderVision | optional | the main-provider vision bridge is unwired; `image_analyze` skips main-vision and uses the registry tier / honest-unavailable | packages/daemon/src/api/types.ts:632 |
| trajectoryRegistry | optional | the vision handlers cannot resolve a per-session recorder; the `media.vision.*` trajectory direct-emits no-op (the INFO/WARN log lines still fire) so `comis explain` lacks the vision turn | packages/daemon/src/api/types.ts:642 |
| voiceSelection | optional | the daemon voice handlers cannot read the boot-resolved STT/TTS `source`/`onSkip` reasons; the `media.stt.*`/`media.tts.*` trajectory records fall back to the config-derived provider + keyless (source defaults to "explicit") so `comis explain` shows the provider but not WHY `auto` picked the rung | packages/daemon/src/api/types.ts:683 |
| obsStore | optional | the daemon voice handlers cannot insert the `voice_degraded` health_signal diagnostic row on an STT/TTS failure, so `comis system-health` surfaces no `voice_health` finding (the log line + the per-session `media.stt.*`/`media.tts.*` trajectory record still fire — only the cross-session system rollup of voice degradation is absent) | packages/daemon/src/api/types.ts:687 |

## Removed Fields (stale-fallback — deleted)

**None.** Every optional field corresponds to a media-pipeline subsystem (vision, TTS, STT, file extraction, image generation, attachment resolution) or a provider-following / observability accessor (main-provider resolution, main-model-id gate, the main-vision bridge, the per-session trajectory recorder) that the operator/boot may leave unconfigured. Each handler short-circuits with a clear "<feature> not configured" error, a registry/honest-unavailable fallback, or a no-op pass-through; no field is a phantom code path.

## Summary

- **Pre-audit count:** 12
- **Final count:** 17 (6 required + 11 optional)
- **Removed (stale-fallback):** 0
- **`stale-fallback` classification rows:** 0 (architecture test enforces; no row may carry this terminal value at any commit)

## Notes

- This is the FINAL audit. Every `when-absent` cell has a real description; no deferred placeholder cells remain.
- The CI architecture test in `packages/daemon/src/__tests__/architecture.test.ts` parses this file row-by-row and asserts (1) bidirectional set equality between audit fields and `MediaApiDeps` fields, (2) every classification cell is `required` or `optional` (never the third "stale-fallback" value), (3) classification matches the interface's optional/required marker, (4) every row has a non-empty `evidence-link`. The parser depends on the table format above — DO NOT introduce nested tables, multi-line cells, or column reordering.
