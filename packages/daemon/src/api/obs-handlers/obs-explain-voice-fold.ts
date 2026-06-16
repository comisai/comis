// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-02 (Phase 196): the seq-aware voice (STT/TTS) cost/outcome fold.
 *
 * Extracted from `obs-explain-signals-fields.ts` (which holds the image/vision/
 * video folds) to keep BOTH that file AND `obs-explain-signals.ts` under the
 * 500-line `obs-handlers/*` subdir cap — the same extraction discipline the
 * image/vision/video folds used to keep the normalizer slim (`applyMediaRecord`).
 * `accumulateVoiceRecord` is the `accumulateVideoRecord` twin (minus the video
 * `delivered`/`jobId`/background-completion — voice is wholly in-turn like image/
 * vision). Pure + content-free: reads only ids/labels/numbers/booleans/closed-enum
 * source via `asString`/`asNumber` — never an audio byte, transcript, or a
 * provider message (T-196-09).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Local content-free readers (kept HERE, not imported from
 *  `obs-explain-signals-fields.ts`, to avoid a fields ↔ voice-fold import cycle —
 *  `applyMediaRecord` in fields imports `accumulateVoiceRecord` from here). */
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** OBS-02 (196): the reconstructed voice (STT/TTS) turn (the non-optional shape
 *  of `IncidentSignals["voice"]`). */
export type IncidentVoiceSignal = NonNullable<IncidentSignals["voice"]>;

/** OBS-02 (196): the seq-aware fold state for the reconstructed voice turn + the
 *  `seq` of the record that last SET `outcome` (the terminal record). Mirrors
 *  `VideoFoldState`/`VisionFoldState`/`ImageFoldState` (IN-04): the fold is driven
 *  by the record stream's `seq`, NOT array order, so only a record with a `seq` ≥
 *  the last outcome-setting record can overwrite `outcome`. */
export interface VoiceFoldState {
  signal: IncidentVoiceSignal | undefined;
  /** The seq at which `outcome` was last set (a terminal completed/failed). */
  outcomeSeq: number;
}

/**
 * OBS-02 (196): fold one `media.stt.*` / `media.tts.*` trajectory record into the
 * reconstructed voice turn (the analog of `accumulateVisionRecord`). Pure: takes
 * the prior fold state + the record's `type`/`data`/`seq` and returns the new
 * state. The voice fold is SIMPLER than video — no `delivered`/`jobId`/background-
 * completion; voice is wholly in-turn like image/vision. The terminal
 * `media.*.completed` / `media.*.failed` record sets `outcome` (+ keyless/model/
 * durationMs/costUsd on success — the cost rides completed, Route a; keyless `0`
 * lands here, OBS-05; errorKind on failure). `media.*.requested` seeds a
 * conservative `outcome:"failed"` block (so a turn aborting before a terminal still
 * surfaces — the `video.requested` seed precedent), carrying `source` if present;
 * it does NOT set `outcomeSeq`. Returns `prev` unchanged for a non-voice type.
 * Content-free reads (asString/asNumber + the boolean reader).
 *
 * SEQ-AWARE (IN-04): a terminal completed/failed only overwrites `outcome` when its
 * `seq` is ≥ the seq of the last outcome-setting record — a stale lower-seq record
 * arriving after a higher-seq terminal no longer flips the outcome. The
 * `media.*.requested` seed does not set `outcomeSeq`, so the first real terminal
 * record always wins.
 */
export function accumulateVoiceRecord(
  prev: VoiceFoldState,
  type: string,
  data: Record<string, unknown>,
  seq: number,
): VoiceFoldState {
  const signal = prev.signal;
  switch (type) {
    case "media.stt.requested":
    case "media.tts.requested": {
      const provider = asString(data.provider);
      const source = asString(data.source);
      const next: IncidentVoiceSignal =
        signal ?? { provider: provider ?? "", keyless: false, outcome: "failed" };
      if (provider !== undefined && next.provider.length === 0) next.provider = provider;
      if (source !== undefined && next.source === undefined) {
        next.source = source as IncidentVoiceSignal["source"];
      }
      return { signal: next, outcomeSeq: prev.outcomeSeq };
    }
    case "media.stt.completed":
    case "media.tts.completed": {
      // Seq-aware terminal: a stale (lower-seq) record never overwrites a newer outcome.
      if (signal !== undefined && seq < prev.outcomeSeq) return prev;
      const model = asString(data.model);
      const durationMs = asNumber(data.durationMs);
      const costUsd = asNumber(data.costUsd);
      // WR-01 (196 review): fall back to the carried (requested-seeded) source when
      // the terminal record omits it — mirrors the provider/keyless fallback so the
      // OBS-03 selection rung survives a partial/reordered terminal record (the fold
      // is the offline oracle for non-live records; the live emitter always passes it).
      const source = (asString(data.source) as IncidentVoiceSignal["source"] | undefined) ?? signal?.source;
      return {
        signal: {
          provider: asString(data.provider) ?? signal?.provider ?? "",
          keyless: typeof data.keyless === "boolean" ? data.keyless : (signal?.keyless ?? false),
          outcome: "ok",
          ...(model !== undefined ? { model } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}), // keyless 0 lands here (OBS-05)
          ...(source !== undefined ? { source } : {}),
        },
        outcomeSeq: seq,
      };
    }
    case "media.stt.failed":
    case "media.tts.failed": {
      if (signal !== undefined && seq < prev.outcomeSeq) return prev;
      const errorKind = asString(data.errorKind);
      // WR-01 (196 review): fall back to the carried (requested-seeded) source when
      // the terminal record omits it — mirrors provider/keyless (see the completed arm).
      const source = (asString(data.source) as IncidentVoiceSignal["source"] | undefined) ?? signal?.source;
      return {
        signal: {
          provider: asString(data.provider) ?? signal?.provider ?? "",
          keyless: typeof data.keyless === "boolean" ? data.keyless : (signal?.keyless ?? false),
          outcome: "failed",
          ...(errorKind !== undefined ? { errorKind } : {}),
          ...(source !== undefined ? { source } : {}),
        },
        outcomeSeq: seq,
      };
    }
    default:
      return prev;
  }
}
