// SPDX-License-Identifier: Apache-2.0
/**
 * The voice-turn (STT/TTS) trajectory direct-emit helper
 * + the `wireVoiceObs` handler-wiring closure.
 *
 * The daemon voice RPC handlers (`media.transcribe` / `tts.synthesize` in
 * `media-handlers.ts`) record a voice turn's lifecycle onto the per-session
 * trajectory so `comis explain <sessionKey>` reconstructs it (provider /
 * keyless? / model / durationMs / audioBytes / costUsd / the resolved `source`
 * rung + the `onSkip` reasons / outcome) — the SAME observability the image/
 * vision/video paths get.
 *
 * Extracted to a SIBLING (NOT inlined into `media-handlers.ts`, which is at its
 * 800-line cap with ZERO allowlist cushion) — routing the emits + the structured
 * log lines through `wireVoiceObs` keeps that file shrink-only and the per-handler
 * wiring delta a few lines (each handler calls `wireVoiceObs(...)` + `.completed` /
 * `.failed`), NOT 20-40 inline lines across two handlers (the file-size gate keys
 * on path).
 *
 * DIVERGENCE FROM `createVisionObsEmitter` (vision-obs-emit.ts): the vision twin
 * FUSES the trajectory record AND the structured log line into one call, because
 * the vision handler had NO prior structured logging. The voice handlers/pipeline
 * ALREADY carry the standard logger floor (the inbound handler / the
 * voice-out pipeline). So `createVoiceObsEmitter` is trajectory-RECORD-focused —
 * it does NOT re-log (a fused log would DOUBLE-emit the line). The log line
 * lives in the SEPARATE `wireVoiceObs` logger closure, BESIDE the record (the
 * video-handler convention), so the handler call-site stays tiny while the record
 * and the log stay decoupled.
 *
 * CONTENT-FREE: every recorded payload carries ids / labels /
 * numbers / booleans / closed-enum reasons ONLY — NEVER the audio bytes, the
 * transcript text, the synthesized audio, or a credential. `costUsd` rides
 * `media.*.completed` presence-conditionally; the keyless caller
 * passes `0` EXPLICITLY so "free" is visible, keyed-no-cost omits it. The
 * domain `SttErrorKind` rides `media.*.failed.errorKind` verbatim; the closed log
 * union (via `STT_ERR_TO_LOG`) + the SANITIZED provider message ride the
 * structured Pino LOG (the `wireVoiceObs` WARN closure), never the trajectory.
 * `agentId` is retained on the args for symmetry but NEVER echoed into `data`
 * (the recorder envelope carries it).
 *
 * @module
 */

import type { SessionTrajectoryHandleRegistry, TrajectoryEventType } from "@comis/observability";
import { STT_ERR_TO_LOG, sanitizeLogString, systemNowMs } from "@comis/core";
import type { ComisLogger, SttErrorKind } from "@comis/core";
import type { ObservabilityStore } from "@comis/memory";

/** The resolved STT/TTS selection rung. Mirrors `SttSelection.source`. */
export type VoiceSource = "explicit" | "keyless-local" | "follow-main-key" | "fallback";

/** Which voice family this emitter records — selects the `media.${kind}.*` event names. */
export type VoiceKind = "stt" | "tts";

/**
 * The SINGLE source of truth for the keyless-cost rule
 * — `keyless ⇒ costUsd:0 explicit` (so "free" is VISIBLE), `keyed-no-cost
 * ⇒ omit`. Duplicating this ternary inline at the `media-handlers.ts`
 * voice call sites would let a third voice handler silently omit it and regress
 * the keyless `$0` visibility with no test catching it. Centralized here so every
 * `completed` path (the trajectory record AND the log line) derives it once.
 * An explicit caller `costUsd` always wins (keyed providers that DO know their cost).
 */
function effectiveCostUsd(costUsd: number | undefined, keyless: boolean): number | undefined {
  if (costUsd !== undefined) return costUsd;
  return keyless ? 0 : undefined;
}

/** A bound voice-trajectory emitter. Returned by `createVoiceObsEmitter` (which
 *  fires `media.${kind}.requested` at construction). The handler calls
 *  `completed` / `failed` on the branch it takes. Every emit is a no-op when no
 *  recorder resolved (off-turn / boot safe) — the offline assembler (the
 *  reconstruct test) is the binding oracle. */
export interface VoiceObsEmitter {
  /** True when a non-null recorder resolved (a session key + a registry + an open
   *  recorder). False off-turn / boot-without-registry — every method then no-ops. */
  readonly active: boolean;
  /** A transcription/synthesis SUCCEEDED: record `media.${kind}.completed` with the
   *  cost-carry. The keyless `costUsd:0` is derived centrally — the caller
   *  need NOT pass `0`; an explicit `costUsd` wins, keyless-without-cost ⇒ `0`
   *  (present, so "free" is visible), keyed-without-cost ⇒ omitted. */
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
 * `media.${kind}.requested` entry record (with the `onSkip` reasons when
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
  // TRAJECTORY_EVENT_TYPES literals (the DOT-separated form).
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
      // Derive the keyless `costUsd:0` centrally (the single source of truth).
      const cost = effectiveCostUsd(costUsd, keyless);
      emit(COMPLETED, {
        provider,
        keyless,
        outcome: "ok",
        ...(model !== undefined ? { model } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(audioBytes !== undefined ? { audioBytes } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}), // keyless ⇒ 0 (present — "free" stays visible)
        source,
      });
    },
    failed({ errorKind, provider, source }) {
      emit(FAILED, { errorKind, provider, outcome: "failed", source });
    },
  };
}

/** The handler-wiring helper return shape: the emitter + the two logging
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

/** The default WARN hint per domain kind (the actionable remedy the operator reads). */
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
 * Host-only redaction: strip credentials from a free-text provider error
 * BEFORE it reaches a log line, and reduce any URL to its HOST (drop path +
 * query, where a token may hide). `sanitizeLogString` (the @comis/core
 * defense-in-depth scrubber) removes Bearer tokens / sk- keys / URL-embedded
 * passwords; the URL→host reduction here removes the path/query a token can ride
 * in. Never log a raw credential-bearing URL or `Bearer`; Pino's
 * depth-3 censor is the layer-1 backstop.
 *
 * ORDER MATTERS: `sanitizeLogString` must run FIRST, while the
 * literal `Bearer <token>` is still intact — its `BEARER_TOKEN_LOG`
 * (`/Bearer\s+.../`) rule is the ONLY one that catches a GENERIC opaque bearer
 * (a Deepgram/ElevenLabs/custom token that is not `sk-`/hex-40+/a known prefix),
 * and it is ANCHORED on that keyword. Stripping `Bearer` before sanitizing would
 * destroy the anchor and leak the opaque token verbatim. So: sanitize first (the
 * token becomes `Bearer [REDACTED]`), THEN drop the now-residual scheme markers
 * and the keyless sentinel.
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
  // Redact FIRST — while `Bearer <token>` is intact so BEARER_TOKEN_LOG fires
  // (it is anchored on the literal `Bearer ` and is the only rule that catches a
  // generic opaque, non-`sk-`/non-hex token). After this, any bearer token is
  // already `[REDACTED]`. `Bearer ollama-no-auth` is also caught here (the
  // sentinel is ≥10 chars after the keyword).
  const sanitized = sanitizeLogString(hostOnly);
  // THEN drop the now-residual `Authorization:` / `Bearer` scheme markers so the
  // line carries no credential CONTEXT at all (the token is already redacted by
  // this point) — the same discipline as @comis/core's `redactErrorMessage`.
  const noScheme = sanitized.replace(/\bAuthorization:/gi, "").replace(/\bBearer\b/gi, "");
  // Strip any BARE keyless-Ollama sentinel value (`ollama-no-auth`) not preceded
  // by `Bearer` (those were caught above): it is a platform-wide credential-
  // position sentinel (the keyless-LLM bearer), so it must never appear in a
  // voice log line at any level. It is too short for
  // `sanitizeLogString`'s long-token rule, so strip it by exact name.
  return noScheme.replace(/\bollama-no-auth\b/gi, "");
}

/**
 * Emit a CONTENT-FREE `voice_degraded` health_signal
 * diagnostic row on a voice failure, so the cross-session `comis system-health`
 * `voice_health` finding (system-findings.ts `voiceDegradedFromRow`/`buildFindings`)
 * has a source. The system assembler reads `obs_diagnostics` (`health_signal` /
 * `model_health` / `config_posture`) — voice failures emit NO row otherwise (the
 * per-session trajectory record is daemon-context-only; the executor session_summary
 * rollup that feeds the system carries only the closed LOG ErrorKinds, which conflate
 * voice with non-voice). This is the ONLY voice emit site into the store, and it
 * lives in THIS obs-layer module (not media-handlers.ts), reading the obsStore
 * already on MediaApiDeps — so no new dependency is introduced.
 *
 * Details carry the signal label + the closed domain `SttErrorKind` + the voice
 * family ONLY — NEVER the raw provider message, a URL, or a secret (no message
 * bodies; the system finding is safe to paste). Best-effort: an absent store no-ops
 * and a throwing store is swallowed (observability is non-fatal — the log lines +
 * the trajectory record are the primary obligations; the store DEGRADES SILENTLY).
 */
function emitVoiceDegradedSignal(
  obsStore: ObservabilityStore | undefined,
  args: { kind: VoiceKind; errorKind: SttErrorKind; agentId: string },
): void {
  if (obsStore === undefined) return;
  try {
    obsStore.insertDiagnostic({
      timestamp: systemNowMs(),
      category: "health_signal",
      severity: "warning",
      agentId: args.agentId,
      message: "voice_degraded",
      // CONTENT-FREE: closed labels only (signal + the domain errorKind + the voice
      // family). No provider message / URL / secret ever enters the details JSON.
      details: JSON.stringify({ signal: "voice_degraded", errorKind: args.errorKind, kind: args.kind }),
    });
  } catch {
    // Observability is non-fatal — a broken store must never break the voice handler.
  }
}

/**
 * wireVoiceObs — the PRIMARY handler-wiring path (what keeps
 * `media-handlers.ts` under its 800-line cap). Bundles {@link createVoiceObsEmitter}
 * with a typed logger closure so each handler's delta is a `wireVoiceObs(...)`
 * call + the `.completed` / `.failed` calls — not 20-40 inline lines.
 *
 * - Construction fires the `media.${kind}.requested` record (with `onSkip`).
 * - `completed(a)` → `obs.completed(a)` AND ONE `logger.info` (the completion
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
  /** The observability store. When present, `failed()` ALSO inserts a
   *  content-free `voice_degraded` health_signal row for the `comis system-health`
   *  voice_health finding. Optional — absent off-turn / on a boot mode without it
   *  (the row insert then no-ops; the log line + the trajectory record still fire). */
  obsStore?: ObservabilityStore;
  agentId: string;
  kind: VoiceKind;
  requested: { provider: string; mainProvider: string; source: VoiceSource; onSkip?: string[] };
  logContext?: { traceId?: string; channelType?: string };
}): WiredVoiceObs {
  const { logger, obsStore, agentId, kind, logContext } = args;
  const obs = createVoiceObsEmitter(args);
  const okMsg = kind === "stt" ? "Transcription completed" : "Speech synthesis completed";
  const failMsg = kind === "stt" ? "Transcription failed" : "Speech synthesis failed";

  return {
    obs,
    completed(a) {
      obs.completed(a);
      // The log line carries the SAME centrally-derived keyless cost as the
      // trajectory record (keyless ⇒ 0 visible; an explicit cost wins; keyed ⇒ omit).
      const cost = effectiveCostUsd(a.costUsd, a.keyless);
      logger.info(
        {
          agentId,
          provider: a.provider,
          keyless: a.keyless,
          ...(a.model !== undefined ? { model: a.model } : {}),
          ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
          ...(a.audioBytes !== undefined ? { audioBytes: a.audioBytes } : {}),
          ...(cost !== undefined ? { costUsd: cost } : {}),
          source: a.source,
          step: kind === "stt" ? "transcribe" : "synthesize",
          ...(logContext ?? {}),
        },
        okMsg,
      );
    },
    failed(a) {
      obs.failed({ errorKind: a.sttErrorKind, provider: a.provider, source: a.source });
      // Feed the cross-session system voice_health finding (content-free,
      // best-effort — never breaks the handler).
      emitVoiceDegradedSignal(obsStore, { kind, errorKind: a.sttErrorKind, agentId });
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
