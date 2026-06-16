// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-02/03 (Phase 196): the voice-turn (STT/TTS) trajectory direct-emit helper
 * + the `wireVoiceObs` handler-wiring closure.
 *
 * The daemon voice RPC handlers (`media.transcribe` / `tts.synthesize` in
 * `media-handlers.ts`) record a voice turn's lifecycle onto the per-session
 * trajectory so `comis explain <sessionKey>` reconstructs it (provider /
 * keyless? / model / durationMs / audioBytes / costUsd / the resolved `source`
 * rung + the `onSkip` reasons / outcome) — the SAME observability image/vision/
 * video got in Phases 186/187/192.
 *
 * Extracted to a SIBLING (NOT inlined into `media-handlers.ts`, which is at its
 * 800-line cap with ZERO allowlist cushion) — routing the emits + the §2.7 log
 * lines through `wireVoiceObs` keeps that file shrink-only and the per-handler
 * wiring delta a few lines (Plan 03 calls `wireVoiceObs(...)` + `.completed` /
 * `.failed`), NOT 20-40 inline lines across two handlers (the file-size gate keys
 * on path).
 *
 * DIVERGENCE FROM `createVisionObsEmitter` (vision-obs-emit.ts): the vision twin
 * FUSES the trajectory record AND the §2.7 log line into one call, because the
 * vision handler had NO prior structured logging. The voice handlers/pipeline
 * ALREADY carry the §2.7 logger floor (Plan 01 / the inbound handler / the
 * voice-out pipeline). So `createVoiceObsEmitter` is trajectory-RECORD-focused —
 * it does NOT re-log (a fused log would DOUBLE-emit the §2.7 line). The §2.7 line
 * lives in the SEPARATE `wireVoiceObs` logger closure, BESIDE the record (the
 * video-handler convention), so the handler call-site stays tiny while the record
 * and the log stay decoupled.
 *
 * CONTENT-FREE (T-196-04/05): every recorded payload carries ids / labels /
 * numbers / booleans / closed-enum reasons ONLY — NEVER the audio bytes, the
 * transcript text, the synthesized audio, or a credential. `costUsd` rides
 * `media.*.completed` presence-conditionally (OBS-05 Route a); the keyless caller
 * passes `0` EXPLICITLY so "free" is visible (FLAG 4), keyed-no-cost omits it. The
 * domain `SttErrorKind` rides `media.*.failed.errorKind` verbatim; the closed log
 * union (via `STT_ERR_TO_LOG`) + the SANITIZED provider message ride the
 * structured Pino LOG (the `wireVoiceObs` WARN closure), never the trajectory.
 * `agentId` is retained on the args for symmetry but NEVER echoed into `data`
 * (the recorder envelope carries it).
 *
 * @module
 */

import type { SessionTrajectoryHandleRegistry, TrajectoryEventType } from "@comis/observability";
import { STT_ERR_TO_LOG, sanitizeLogString } from "@comis/core";
import type { ComisLogger, SttErrorKind } from "@comis/core";

/** The resolved STT/TTS selection rung (OBS-03). Mirrors `SttSelection.source`. */
export type VoiceSource = "explicit" | "keyless-local" | "follow-main-key" | "fallback";

/** Which voice family this emitter records — selects the `media.${kind}.*` event names. */
export type VoiceKind = "stt" | "tts";

/** A bound voice-trajectory emitter. Returned by `createVoiceObsEmitter` (which
 *  fires `media.${kind}.requested` at construction). The handler calls
 *  `completed` / `failed` on the branch it takes. Every emit is a no-op when no
 *  recorder resolved (off-turn / boot safe) — the offline assembler (Plan 03's
 *  reconstruct test) is the binding oracle. */
export interface VoiceObsEmitter {
  /** True when a non-null recorder resolved (a session key + a registry + an open
   *  recorder). False off-turn / boot-without-registry — every method then no-ops. */
  readonly active: boolean;
  /** A transcription/synthesis SUCCEEDED: record `media.${kind}.completed` with the
   *  cost-carry (keyless passes `costUsd:0` → present; keyed-no-cost omits it — FLAG 4). */
  completed(args: {
    provider: string;
    keyless: boolean;
    model?: string;
    durationMs?: number;
    audioBytes?: number;
    costUsd?: number;
    source: VoiceSource;
  }): void;
  /** A transcription/synthesis FAILED: record `media.${kind}.failed` {errorKind (the
   *  domain SttErrorKind), provider, outcome:"failed", source}. NEVER the raw message. */
  failed(args: { errorKind: SttErrorKind; provider: string; source: VoiceSource }): void;
}

/**
 * Resolve the per-session recorder by `sessionKey`, fire the
 * `media.${kind}.requested` entry record (with the OBS-03 `onSkip` reasons when
 * supplied), and return a bound {@link VoiceObsEmitter}. In-turn the handler passes
 * the dispatcher-injected `_callerSessionKey`. When the registry is absent,
 * `getRecorder` returns null/undefined, or there is no session key, the trajectory
 * emits are NO-OPs (never a crash) — the offline assembler is the binding oracle.
 *
 * `agentId` is retained for symmetry with `createVideoObsEmitter` + future
 * envelope use; it is NOT echoed into the content-free trajectory `data`.
 */
export function createVoiceObsEmitter(args: {
  sessionKey: string | undefined;
  trajectoryRegistry: SessionTrajectoryHandleRegistry | undefined;
  agentId: string;
  kind: VoiceKind;
  requested: { provider: string; mainProvider: string; source: VoiceSource; onSkip?: string[] };
}): VoiceObsEmitter {
  const { sessionKey, trajectoryRegistry, kind, requested } = args;
  const recorder =
    sessionKey != null && sessionKey.length > 0 && trajectoryRegistry != null
      ? trajectoryRegistry.getRecorder?.(sessionKey)
      : undefined;

  const emit = (type: TrajectoryEventType, data: Record<string, unknown>): void => {
    if (recorder != null) recorder.recordEvent(type, data);
  };

  // The `media.${kind}.*` template literal narrows to the six closed
  // TRAJECTORY_EVENT_TYPES literals (DOT form — FLAG 3) added in Task 1.
  const REQUESTED = `media.${kind}.requested` as TrajectoryEventType;
  const COMPLETED = `media.${kind}.completed` as TrajectoryEventType;
  const FAILED = `media.${kind}.failed` as TrajectoryEventType;

  emit(REQUESTED, {
    provider: requested.provider,
    mainProvider: requested.mainProvider,
    source: requested.source,
    ...(requested.onSkip !== undefined ? { onSkip: requested.onSkip } : {}),
  });

  return {
    active: recorder != null,
    completed({ provider, keyless, model, durationMs, audioBytes, costUsd, source }) {
      emit(COMPLETED, {
        provider,
        keyless,
        outcome: "ok",
        ...(model !== undefined ? { model } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(audioBytes !== undefined ? { audioBytes } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}), // keyless passes 0 → present (FLAG 4)
        source,
      });
    },
    failed({ errorKind, provider, source }) {
      emit(FAILED, { errorKind, provider, outcome: "failed", source });
    },
  };
}

/** The handler-wiring helper return shape: the emitter + the two §2.7-logging
 *  closures (each does BOTH the trajectory record AND the one log line). */
export interface WiredVoiceObs {
  obs: VoiceObsEmitter;
  completed(a: {
    provider: string;
    keyless: boolean;
    model?: string;
    durationMs?: number;
    audioBytes?: number;
    costUsd?: number;
    source: VoiceSource;
  }): void;
  failed(a: { sttErrorKind: SttErrorKind; provider: string; source: VoiceSource; errMessage: string; hint?: string }): void;
}

/** The default WARN hint per domain kind (the actionable §2.7 remedy). */
const HINT_BY_KIND: Record<SttErrorKind, string> = {
  no_keyless_engine: "enable the local whisper engine or set an audio API key (a Codex OAuth login cannot drive audio)",
  auth_required: "set the provider's audio API key, or switch to a keyless provider (local/edge)",
  model_load_failed: "check the local whisper model cache + disk; confirm the local engine probe",
  model_download_failed: "check network + disk for the whisper model download; confirm the model cache path",
  timeout: "the provider/engine timed out; check load + the operation timeout knob",
  network: "check network reachability to the provider host",
  dependency: "a voice dependency failed; check the provider/engine status",
};

/**
 * SEC-01 host-only redaction: strip credentials from a free-text provider error
 * BEFORE it reaches a log line, and reduce any URL to its HOST (drop path +
 * query, where a token may hide). `sanitizeLogString` (the @comis/core
 * defense-in-depth scrubber) removes Bearer markers / sk- keys / URL-embedded
 * passwords; the URL→host reduction here removes the path/query a token can ride
 * in. Never log a raw credential-bearing URL or `Bearer` (the §2.7 floor); Pino's
 * depth-3 censor is the layer-1 backstop.
 */
function redactVoiceLogMessage(message: string): string {
  const hostOnly = message.replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      return new URL(url).host;
    } catch {
      // Not a parseable URL — drop everything after the authority defensively.
      return url.replace(/^(https?:\/\/[^/?#\s]+).*$/i, "$1");
    }
  });
  // Drop the bare `Authorization:` / `Bearer` credential-scheme markers (the
  // 196-01 redactErrorMessage precedent) so the line carries no credential
  // CONTEXT at all — `sanitizeLogString` then redacts any surviving token tail.
  const noScheme = hostOnly.replace(/\bAuthorization:/gi, "").replace(/\bBearer\b/gi, "");
  return sanitizeLogString(noScheme);
}

/**
 * wireVoiceObs — the PRIMARY handler-wiring path (the WARNING-2 lever for the
 * `media-handlers.ts` 799/800 cap). Bundles {@link createVoiceObsEmitter} with a
 * typed §2.7 logger closure so Plan 03's per-handler delta is a `wireVoiceObs(...)`
 * call + the `.completed` / `.failed` calls — not 20-40 inline lines.
 *
 * - Construction fires the `media.${kind}.requested` record (with `onSkip`).
 * - `completed(a)` → `obs.completed(a)` AND ONE `logger.info` (the §2.7 completion
 *   line carrying provider/keyless/model/durationMs/audioBytes/costUsd/source).
 * - `failed(a)` → `obs.failed({ errorKind: a.sttErrorKind, ... })` AND ONE
 *   `logger.warn` carrying `err:` (the SANITIZED host-only message — no Bearer/
 *   token/full-URL), `hint`, `errorKind: STT_ERR_TO_LOG[a.sttErrorKind]` (the
 *   closed log union the Pino serializer expects), and `sttErrorKind` (the domain).
 *
 * The log lines ALWAYS fire (recorder or not — off-turn-safe like the emitter).
 * The completion/failure MESSAGE keys off `kind` (transcription vs synthesis).
 */
export function wireVoiceObs(args: {
  sessionKey: string | undefined;
  trajectoryRegistry: SessionTrajectoryHandleRegistry | undefined;
  logger: ComisLogger;
  agentId: string;
  kind: VoiceKind;
  requested: { provider: string; mainProvider: string; source: VoiceSource; onSkip?: string[] };
  logContext?: { traceId?: string; channelType?: string };
}): WiredVoiceObs {
  const { logger, agentId, kind, logContext } = args;
  const obs = createVoiceObsEmitter(args);
  const okMsg = kind === "stt" ? "Transcription completed" : "Speech synthesis completed";
  const failMsg = kind === "stt" ? "Transcription failed" : "Speech synthesis failed";

  return {
    obs,
    completed(a) {
      obs.completed(a);
      logger.info(
        {
          agentId,
          provider: a.provider,
          keyless: a.keyless,
          ...(a.model !== undefined ? { model: a.model } : {}),
          ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
          ...(a.audioBytes !== undefined ? { audioBytes: a.audioBytes } : {}),
          ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}),
          source: a.source,
          step: kind === "stt" ? "transcribe" : "synthesize",
          ...(logContext ?? {}),
        },
        okMsg,
      );
    },
    failed(a) {
      obs.failed({ errorKind: a.sttErrorKind, provider: a.provider, source: a.source });
      logger.warn(
        {
          agentId,
          err: redactVoiceLogMessage(a.errMessage),
          hint: a.hint ?? HINT_BY_KIND[a.sttErrorKind],
          errorKind: STT_ERR_TO_LOG[a.sttErrorKind],
          sttErrorKind: a.sttErrorKind,
          provider: a.provider,
          source: a.source,
          step: kind === "stt" ? "transcribe" : "synthesize",
          ...(logContext ?? {}),
        },
        failMsg,
      );
    },
  };
}
