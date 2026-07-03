// SPDX-License-Identifier: Apache-2.0
/**
 * In-process keyless whisper STT adapter.
 *
 * The zero-config default rung of STT `auto`: it transcribes with NO key by
 * running whisper in-process via `@huggingface/transformers` (Transformers.js),
 * auto-downloading a small ONNX model on first use to a scoped cache under
 * `~/.comis/models/whisper/`, then reusing it on every later call (a
 * module-level singleton — the model loads once per process and is NOT evicted
 * by a per-call transcribe failure, only by a load failure; modulo a concurrent
 * cold start where two simultaneous first calls can each build it before the
 * promise is memoized — a self-healing cold-start-only inefficiency).
 *
 * Design constraints (all enforced by local-stt-adapter.test.ts):
 *  - **Honest-degrade:** the engine is lazy-imported INSIDE a guarded
 *    `await import("@huggingface/transformers")` — NEVER a top-level static
 *    import — so a missing/broken install (or its native ORT addon) yields
 *    `Result.err` rather than crashing the whole `@comis/skills` import graph.
 *    Every failure branch returns `ok(...)` / `err(...)`; this module NEVER
 *    `throw`s (the raw-throw architecture gate).
 *  - **Audio decode:** the inbound Buffer is decoded to a 16 kHz mono
 *    `Float32Array` by shelling the existing ffmpeg binary (`-f f32le -ar 16000
 *    -ac 1`) — no new audio library (mirrors `audio-converter.ts`).
 *  - **Scoped cache:** `env.cacheDir` is set to
 *    `safePath(dataDir, "models", "whisper")` (NEVER raw `path.join`) before the
 *    first `pipeline()` call; that path is already inside the daemon's
 *    `--allow-fs-write=${COMIS_DATA_DIR}` scope, so no new permission flag.
 *  - **Fail-closed + integrity:** the LIVE, prod-running integrity
 *    mechanism is the pinned `MODEL_IDS` anchor (only a hardcoded id is loaded;
 *    an unknown key → the pinned default) + the TLS HF-Hub source + the
 *    fail-closed load: a short/corrupt `pipeline()` load → `err` (kind
 *    `model_load_failed`) and the singleton is RESET so a transient failure can
 *    retry — never a silent partial-model success. The post-load `statModelCache`
 *    size-floor (a sub-`MODEL_SIZE_FLOOR_BYTES` cached model → fail-closed) is an
 *    OPTIONAL, **TEST-ONLY** seam: its default (`defaultStatModelCache`) returns
 *    `undefined`, so it enforces NOTHING off a real daemon (the transformers.js
 *    etag cache layout is not a documented contract — guessing a path to stat is
 *    itself a bug). Do NOT read the size-floor as live corrupt-download
 *    protection; the fail-closed LOAD is what catches a truncated download in
 *    prod. HONEST limit: transformers.js exposes NO caller-visible content-hash,
 *    so integrity is pinned-id + TLS + fail-closed load (NOT a content-hash, and NOT
 *    a size-floor in prod). The TTS twin (`local-tts-adapter.ts`) deliberately
 *    carries NO size-floor seam at all — its integrity scope is the same pinned-id +
 *    TLS + fail-closed-load triad, MINUS the inert STT size seam.
 *  - **Redaction (light floor):** every surfaced error string is passed
 *    through `sanitizeApiError`, which strips URLs (`[URL]`) and long tokens
 *    (`[REDACTED]`), so no credential-bearing `baseUrl`/token leaks.
 *
 * The engine loader and the ffmpeg decode are injectable config seams
 * (`loadEngine` / `decodeToPcm16kF32`) so unit tests never touch the network
 * or ffmpeg; they default to the real lazy-import + ffmpeg path.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { TranscriptionPort, TranscriptionOptions, TranscriptionResult } from "@comis/core";
import { safePath } from "@comis/core";
import type { SttErrorKind } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { sanitizeApiError } from "./media-adapter-shared.js";

const execFileAsync = promisify(execFile);

/** Whisper ASR pipeline: takes a 16 kHz mono Float32Array → `{ text }`. */
type AsrPipeline = (audio: Float32Array) => Promise<{ text: string }>;

/**
 * The subset of `@huggingface/transformers` the adapter consumes. `env` is the
 * library's mutable global config (we set `cacheDir` / `allowRemoteModels` on
 * it); `pipeline` builds the ASR transcriber.
 */
export interface TransformersModule {
  env: Record<string, unknown>;
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<AsrPipeline>;
}

/** Configuration for the in-process local whisper adapter. */
export interface LocalWhisperConfig {
  /** Whisper model size — one of MODEL_IDS keys (default: "base"). */
  readonly model?: string;
  /** Data directory; the model cache is `<dataDir>/models/whisper/`. */
  readonly dataDir: string;
  /** Maximum file size in megabytes (default: 25). */
  readonly maxFileSizeMb?: number;
  /**
   * Engine loader seam. Defaults to a guarded lazy `import("@huggingface/transformers")`.
   * Injected in tests to avoid a real model download.
   */
  readonly loadEngine?: () => Promise<TransformersModule>;
  /**
   * Audio decode seam: Buffer → 16 kHz mono Float32Array. Defaults to the ffmpeg
   * shell. Injected in tests to avoid shelling ffmpeg.
   */
  readonly decodeToPcm16kF32?: (
    audio: Buffer,
    mime: string,
  ) => Promise<Result<Float32Array, Error>>;
  /**
   * Size-floor seam (OPTIONAL, **TEST-ONLY** — see below): after the
   * pipeline loads, resolve the on-disk size (bytes) of the cached model under
   * `cacheDir`, or `undefined` if it cannot be reliably determined. A size BELOW
   * {@link MODEL_SIZE_FLOOR_BYTES} is treated as a truncated/partial download →
   * fail-closed `model_load_failed` (the bad load is not memoized).
   *
   * The DEFAULT ({@link defaultStatModelCache}) returns `undefined`, so the
   * size-floor ENFORCES NOTHING in production: the transformers.js etag cache
   * layout is NOT a documented contract, so production does NOT guess a fragile
   * path to `fs.stat` (a hand-built path may not exist) — and an unknown size must never be a
   * false corruption. The LIVE prod integrity floor is therefore the pinned id +
   * the fail-closed LOAD + the TLS HF-Hub source; this seam exists so the
   * fail-closed-on-implausible-size BRANCH is exercisable (tests inject a concrete
   * size). A future caller that adopts a documented cache layout could supply a
   * real implementation to make the floor live.
   */
  readonly statModelCache?: (
    cacheDir: string,
    modelId: string,
  ) => Promise<number | undefined>;
}

const DEFAULT_MODEL = "base";
const DEFAULT_MAX_FILE_SIZE_MB = 25;
const DECODE_TIMEOUT_MS = 30_000;

/**
 * Exact ONNX whisper repo ids per size (the `onnx-community/*` Transformers.js-
 * compatible repos). This is the "pinned model id" anchor: only these
 * hardcoded ids are ever loaded — an unknown/blank model key resolves to the
 * pinned default ({@link DEFAULT_MODEL}) below, so no caller-supplied/arbitrary
 * remote id can be fetched. Fetched over TLS from the HF Hub (`allowRemoteModels`).
 *
 * HONEST integrity scope: this is pinned-id + TLS + the fail-closed
 * `model_load_failed` seam + an OPTIONAL post-load size-floor — NOT a pinned
 * content-hash. Transformers.js etag-caches the download but exposes no
 * caller-visible content-hash API, so no cryptographic-integrity claim is made
 * (documented in voice.mdx).
 */
const MODEL_IDS: Record<string, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
};

/**
 * Size-floor: a cached whisper model below this many bytes is treated as
 * a truncated/partial download (corruption), never a valid model. The smallest
 * pinned model (whisper-tiny, q8) is multiple MB on disk; 1 MB is a conservative
 * floor that no real model undershoots but a near-zero/partial file trips. Only
 * enforced when the `statModelCache` seam returns a concrete size (the default
 * returns `undefined` → no enforcement; see the seam doc-comment).
 */
const MODEL_SIZE_FLOOR_BYTES = 1024 * 1024; // 1 MB

/**
 * Module-level singleton: memoizes the `pipeline(...)` promise so the model
 * loads once per process ("2nd call no re-download"). It is reset to
 * `undefined` ONLY on a LOAD error (fail-closed retry — never a memoized partial
 * model). A per-call TRANSCRIBE failure does NOT reset it — a bad audio
 * input must not thrash the good, already-loaded model.
 */
let pipelinePromise: Promise<AsrPipeline> | undefined;

/**
 * TEST-ONLY: reset the module singleton between tests. Not exported on the
 * package barrel — only imported by `local-stt-adapter.test.ts`.
 */
export function __resetLocalWhisperPipelineForTests(): void {
  pipelinePromise = undefined;
}

/**
 * A surfaced STT failure that CARRIES its domain `SttErrorKind`.
 *
 * The adapter selects a `SttErrorKind` at each failure branch; attaching it to
 * the returned `Error` (rather than discarding it) lets the obs bridge
 * read `error.kind` directly instead of re-deriving it. Mirrors `VideoGenError`
 * (packages/core/src/media/video-error.ts) but kept adapter-local: this is not a
 * cross-package contract, so a lightweight `Error & { kind }` suffices and no
 * raw `throw` is introduced (the helper RETURNS the error to `Result.err`).
 */
export interface SttDegradeError extends Error {
  readonly kind: SttErrorKind;
}

/**
 * Attach a domain `SttErrorKind` onto an Error and brand it as a
 * `SttDegradeError`. Used for the clean-message guard branches
 * (empty buffer / oversize) where the message needs no third-party
 * sanitization — only the kind. Writable assign; public shape is readonly.
 */
function withKind(error: Error, kind: SttErrorKind): SttDegradeError {
  // Assign through an index-signature view (overlaps with Error, so no
  // through-`unknown` cast); the public SttDegradeError shape is readonly.
  (error as unknown as Record<string, unknown>)["kind"] = kind;
  return error as unknown as SttDegradeError;
}

/**
 * Build a redacted, hint-bearing, kind-carrying Error for a surfaced failure
 * branch that wraps a third-party `cause`. The `kind` is attached so the
 * obs path can read it without re-deriving; the free-text `detail` is
 * run through `sanitizeApiError` (strips URLs → `[URL]`, long tokens →
 * `[REDACTED]`) so no credential-bearing `baseUrl`/token leaks.
 */
function degraded(hint: string, cause: unknown, kind: SttErrorKind): SttDegradeError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return withKind(
    new Error(`${hint} — ${sanitizeApiError(0, detail, "Local Whisper")}`),
    kind,
  );
}

/**
 * Convert a raw f32le PCM buffer (as ffmpeg writes it) into a copied
 * `Float32Array`, validating the decode at the boundary.
 *
 * A zero-byte buffer means ffmpeg "succeeded" (exit 0) but produced no PCM —
 * a valid container with no decodable audio stream, or a 0-duration clip. A
 * non-multiple-of-4 length means stray bytes that are NOT a whole f32 sample.
 * Both are decode anomalies: surface a `degraded` `err` (kind `dependency`)
 * instead of feeding an empty / truncated sample array into the engine (which
 * would either throw — mishandled — or yield a phantom-empty transcript). The
 * result is copied out of the file-backed buffer so it survives temp cleanup.
 */
function pcmBufferToSamples(pcmBuffer: Buffer): Result<Float32Array, Error> {
  if (pcmBuffer.byteLength === 0 || pcmBuffer.byteLength % 4 !== 0) {
    return err(
      degraded(
        "ffmpeg produced no decodable PCM for local whisper (no audio stream or zero-length clip)",
        new Error(`pcm bytes=${pcmBuffer.byteLength}`),
        "dependency",
      ),
    );
  }
  const samples = new Float32Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 4,
  );
  // Copy out of the file-backed buffer so the typed array survives cleanup.
  return ok(Float32Array.from(samples));
}

/**
 * TEST-ONLY: exercise the PCM-boundary guard without shelling real ffmpeg.
 * Not exported on the package barrel — only imported by
 * `local-stt-adapter.test.ts` (same invariant as
 * `__resetLocalWhisperPipelineForTests`).
 */
export function __pcmBufferToSamplesForTests(pcmBuffer: Buffer): Result<Float32Array, Error> {
  return pcmBufferToSamples(pcmBuffer);
}

/**
 * Default ffmpeg decode: shells ffmpeg to raw 16 kHz mono f32 PCM, then reads it
 * into a Float32Array. Mirrors `audio-converter.ts:extractWaveform` (s16le/8000
 * → f32le/16000). Returns a `degraded(...)` `err` carrying kind `dependency`
 * (the kind is ATTACHED to the surfaced error, not discarded — see
 * `degraded`) on any ffmpeg failure OR an empty / non-4-byte-multiple decode.
 * Never throws. The temp file is always cleaned up.
 */
async function defaultDecodeToPcm16kF32(
  audio: Buffer,
  _mime: string,
): Promise<Result<Float32Array, Error>> {
  const tempDir = os.tmpdir();
  const inputPath = safePath(tempDir, `stt-in-${crypto.randomUUID()}.bin`);
  const tempPcm = safePath(tempDir, `stt-pcm-${crypto.randomUUID()}.raw`);
  try {
    await fs.writeFile(inputPath, audio);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-f", "f32le", "-ac", "1", "-ar", "16000", tempPcm],
      { timeout: DECODE_TIMEOUT_MS },
    );
    const pcmBuffer = await fs.readFile(tempPcm);
    // Validate the decode (empty / non-4-byte-multiple) at the boundary.
    return pcmBufferToSamples(pcmBuffer);
  } catch (e: unknown) {
    return err(
      degraded(
        "ffmpeg failed to decode audio for local whisper — ensure ffmpeg is installed and the input is valid audio",
        e,
        "dependency",
      ),
    );
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => undefined);
    await fs.rm(tempPcm, { force: true }).catch(() => undefined);
  }
}

/**
 * Default size-floor seam: ALWAYS returns `undefined` (size unknown), so
 * the size-floor enforces NOTHING in production — it is inert by default and the
 * floor branch only ever fires when a test injects a concrete size. The
 * transformers.js etag cache layout is NOT a documented contract, so production
 * does NOT guess a model-file path to `fs.stat` (a
 * hand-built path that may not exist). The LIVE prod integrity floor is the
 * pinned id + the fail-closed LOAD (`model_load_failed`) + the TLS HF-Hub source,
 * NOT this seam. `safePath` would be used (never raw `path.join`) by any future
 * real inspection that adopts a documented layout.
 */
async function defaultStatModelCache(
  _cacheDir: string,
  _modelId: string,
): Promise<number | undefined> {
  return undefined;
}

/** Default engine loader: a guarded lazy import (never a top-level static import). */
async function defaultLoadEngine(): Promise<TransformersModule> {
  // The literal module name appears ONLY here, inside the guarded loader, so a
  // missing/broken install degrades to Result.err in transcribe() rather than
  // crashing the @comis/skills import graph.
  const mod = (await import("@huggingface/transformers")) as unknown as TransformersModule;
  return mod;
}

/**
 * Create the in-process keyless whisper STT adapter.
 *
 * No API key. The first `transcribe()` lazy-loads the engine, decodes the audio
 * via ffmpeg, and downloads + caches the model once; later calls reuse the
 * cached pipeline. Every failure branch returns `Result.err` — never throws.
 */
export function createLocalWhisperAdapter(cfg: LocalWhisperConfig): TranscriptionPort {
  const modelKey = cfg.model ?? DEFAULT_MODEL;
  const maxFileSizeMb = cfg.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;
  const cacheDir = safePath(cfg.dataDir, "models", "whisper");
  const loadEngine = cfg.loadEngine ?? defaultLoadEngine;
  const decode = cfg.decodeToPcm16kF32 ?? defaultDecodeToPcm16kF32;
  const statModelCache = cfg.statModelCache ?? defaultStatModelCache;
  // Pinned-id anchor: only a hardcoded MODEL_IDS value is ever loaded; an
  // unknown/blank key resolves to the pinned default — never the raw caller key.
  const modelId = MODEL_IDS[modelKey] ?? MODEL_IDS[DEFAULT_MODEL]!;

  return {
    async transcribe(
      audio: Buffer,
      options: TranscriptionOptions,
    ): Promise<Result<TranscriptionResult, Error>> {
      // 1. Empty-buffer guard — runs before any engine load or decode.
      if (audio.byteLength === 0) {
        // Carry the kind like every other branch (clean message, no third-party
        // cause to sanitize → withKind, not degraded). This is really a
        // VALIDATION failure (bad input), but the closed SttErrorKind vocabulary
        // (voice-error.ts) has no `validation` member, so `dependency` is the
        // deliberate vocabulary mapping here — NOT a real missing-dependency.
        return err(withKind(new Error("Audio buffer is empty"), "dependency"));
      }

      // 2. Size cap. Also a validation failure; `dependency` is the
      //    deliberate mapping (the SttErrorKind union has no `validation` member).
      const fileSizeMb = audio.byteLength / (1024 * 1024);
      if (fileSizeMb > maxFileSizeMb) {
        return err(
          withKind(
            new Error(
              `Audio file size ${fileSizeMb.toFixed(1)}MB exceeds limit of ${maxFileSizeMb}MB`,
            ),
            "dependency",
          ),
        );
      }

      // 3. Decode to 16 kHz mono f32 PCM FIRST — a cheap ffmpeg check that
      //    short-circuits before paying the (heavy) engine-import cost on a
      //    decode failure (no engine load attempted after a decode fail).
      const pcm = await decode(audio, options.mimeType);
      if (!pcm.ok) {
        return pcm;
      }

      // 4. Lazy engine load — honest-degrade, never a module-load crash.
      let mod: TransformersModule;
      try {
        mod = await loadEngine();
      } catch (e: unknown) {
        return err(
          degraded(
            "Local whisper engine unavailable — install @huggingface/transformers or set transcription.local.baseUrl to a local whisper server",
            e,
            "dependency",
          ),
        );
      }

      // 5. Singleton pipeline build — fail-closed ONLY on a bad load. Memoize
      //    the pipeline() PROMISE synchronously the moment
      //    the engine module is in hand — there is NO `await` between the
      //    `undefined` check and the assignment, so two near-simultaneous first
      //    calls that reach here serialize on the one shared promise rather than
      //    each building the model (modulo a concurrent cold start where both
      //    are still awaiting loadEngine — see the doc-comment caveat).
      let transcriber: AsrPipeline;
      try {
        if (pipelinePromise === undefined) {
          mod.env["cacheDir"] = cacheDir; // scoped, inside --allow-fs-write
          mod.env["allowRemoteModels"] = true; // first-run HF-Hub download over TLS
          pipelinePromise = mod.pipeline("automatic-speech-recognition", modelId, {
            dtype: "q8", // quantized → minimal first-run download
          });
        }
        transcriber = await pipelinePromise;
      } catch (e: unknown) {
        // Fail-closed: a failed/partial LOAD is NOT memoized — reset so a
        // transient load failure can retry on the next call. This reset is
        // correct ONLY for the load branch.
        pipelinePromise = undefined;
        return err(
          degraded(
            "Local whisper model failed to load — the download may be incomplete or the model id is unavailable",
            e,
            "model_load_failed",
          ),
        );
      }

      // Size-floor (OPTIONAL, TEST-ONLY seam — inert in prod): a
      // pipeline() that "loaded" but whose on-disk model is implausibly small is
      // a truncated/partial download masquerading as a working model. When the
      // injected size seam reports a concrete sub-floor size, FAIL CLOSED and
      // reset the singleton (same fail-closed discipline as the load catch) so
      // the bad model is never memoized and a re-download is retried. The
      // DEFAULT seam returns `undefined` (cache layout is not a documented
      // contract → no path guess), so this branch enforces NOTHING off a real
      // daemon — the live protection for a corrupt download is the fail-closed
      // LOAD above, not this.
      let modelBytes: number | undefined;
      try {
        modelBytes = await statModelCache(cacheDir, modelId);
      } catch {
        // A stat failure is NOT corruption — keep the load and rely on the
        // pinned-id + fail-closed triad (an unreadable stat must not block a
        // working model).
        modelBytes = undefined;
      }
      if (modelBytes !== undefined && modelBytes < MODEL_SIZE_FLOOR_BYTES) {
        pipelinePromise = undefined;
        return err(
          degraded(
            "Local whisper model failed integrity check — the cached model is implausibly small (incomplete/truncated download)",
            new Error(`model bytes=${modelBytes} below floor=${MODEL_SIZE_FLOOR_BYTES}`),
            "model_load_failed",
          ),
        );
      }

      // 6. Transcribe — a per-call inference failure does NOT evict the good,
      //    already-loaded model. The singleton stays memoized; a bad
      //    audio input is not a reason to thrash the load-once pipeline. The
      //    kind is `dependency` (a runtime inference failure), NOT
      //    `model_load_failed` (the model loaded fine).
      try {
        const out = await transcriber(pcm.value);
        // out.text is the result of an injected/dynamically-imported
        // third-party fn; the `text: string` type is an assertion, not a
        // runtime guarantee. Validate at the boundary so an unexpected shape
        // ({ text: undefined }, a chunked array, {}) surfaces as an honest err
        // rather than a phantom ok({ text: undefined }).
        const text = typeof out?.text === "string" ? out.text : undefined;
        if (text === undefined) {
          return err(
            degraded(
              "Local whisper returned no transcript text — unexpected engine output shape",
              new Error(`unexpected result: ${typeof out?.text}`),
              "dependency",
            ),
          );
        }
        return ok({ text, language: options.language, durationMs: undefined });
      } catch (e: unknown) {
        return err(
          degraded(
            "Local whisper failed to transcribe this audio",
            e,
            "dependency",
          ),
        );
      }
    },
  };
}
