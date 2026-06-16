// SPDX-License-Identifier: Apache-2.0
/**
 * In-process keyless whisper STT adapter (LOCAL-01 / LOCAL-02 / LOCAL-04).
 *
 * The zero-config default rung of STT `auto`: it transcribes with NO key by
 * running whisper in-process via `@huggingface/transformers` (Transformers.js),
 * auto-downloading a small ONNX model on first use to a scoped cache under
 * `~/.comis/models/whisper/`, then reusing it on every later call (a
 * module-level singleton — the model loads once per process and is NOT evicted
 * by a per-call transcribe failure, only by a load failure; modulo a concurrent
 * cold start where two simultaneous first calls can each build it before the
 * promise is memoized — IN-01, a self-healing cold-start-only inefficiency).
 *
 * Design constraints (all enforced by local-stt-adapter.test.ts):
 *  - **Honest-degrade (LOCAL-02):** the engine is lazy-imported INSIDE a guarded
 *    `await import("@huggingface/transformers")` — NEVER a top-level static
 *    import — so a missing/broken install (or its native ORT addon) yields
 *    `Result.err` rather than crashing the whole `@comis/skills` import graph.
 *    Every failure branch returns `ok(...)` / `err(...)`; this module NEVER
 *    `throw`s (the raw-throw architecture gate).
 *  - **Audio decode:** the inbound Buffer is decoded to a 16 kHz mono
 *    `Float32Array` by shelling the existing ffmpeg binary (`-f f32le -ar 16000
 *    -ac 1`) — no new audio library (mirrors `audio-converter.ts`).
 *  - **Scoped cache (LOCAL-04):** `env.cacheDir` is set to
 *    `safePath(dataDir, "models", "whisper")` (NEVER raw `path.join`) before the
 *    first `pipeline()` call; that path is already inside the daemon's
 *    `--allow-fs-write=${COMIS_DATA_DIR}` scope, so no new permission flag.
 *  - **Fail-closed + integrity (the SEC-03 seam):** a short/corrupt model load
 *    → `err` (kind `model_load_failed`) and the singleton is RESET so a
 *    transient failure can retry — never a silent partial-model success.
 *    Phase 197 hardens this with the pinned `MODEL_IDS` anchor (only a hardcoded
 *    id is loaded; an unknown key → the pinned default), the TLS HF-Hub source,
 *    and an OPTIONAL post-load size-floor (a sub-`MODEL_SIZE_FLOOR_BYTES` cached
 *    model → fail-closed `model_load_failed`). HONEST limit: transformers.js
 *    exposes NO caller-visible content-hash, so SEC-03 is pinned-id + TLS +
 *    fail-closed + size-floor, NOT a cryptographic content-hash check.
 *  - **Redaction (SEC-01 light floor):** every surfaced error string is passed
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
   * SEC-03 size-floor seam: after the pipeline loads, resolve the on-disk size
   * (bytes) of the cached model under `cacheDir`, or `undefined` if it cannot be
   * reliably determined. A size BELOW {@link MODEL_SIZE_FLOOR_BYTES} is treated
   * as a truncated/partial download → fail-closed `model_load_failed` (the bad
   * load is not memoized). The DEFAULT returns `undefined`: the transformers.js
   * etag cache layout is NOT a documented contract, so production does NOT guess
   * a fragile path (the §2.10 bug class) — an unknown size is never a false
   * corruption, and the integrity floor rests on the pinned id + the fail-closed
   * seam + the TLS HF-Hub source. Injected in tests to drive the size-floor.
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
 * compatible repos). This is the SEC-03 "pinned model id" anchor: only these
 * hardcoded ids are ever loaded — an unknown/blank model key resolves to the
 * pinned default ({@link DEFAULT_MODEL}) below, so no caller-supplied/arbitrary
 * remote id can be fetched. Fetched over TLS from the HF Hub (`allowRemoteModels`).
 *
 * SEC-03 HONEST scope: this is pinned-id + TLS + the fail-closed
 * `model_load_failed` seam + an OPTIONAL post-load size-floor — NOT a pinned
 * content-hash. Transformers.js etag-caches the download but exposes no
 * caller-visible content-hash API, so no cryptographic-integrity claim is made
 * (documented in voice.mdx by Plan 04).
 */
const MODEL_IDS: Record<string, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
};

/**
 * SEC-03 size-floor: a cached whisper model below this many bytes is treated as
 * a truncated/partial download (corruption), never a valid model. The smallest
 * pinned model (whisper-tiny, q8) is multiple MB on disk; 1 MB is a conservative
 * floor that no real model undershoots but a near-zero/partial file trips. Only
 * enforced when the `statModelCache` seam returns a concrete size (the default
 * returns `undefined` → no enforcement; see the seam doc-comment).
 */
const MODEL_SIZE_FLOOR_BYTES = 1024 * 1024; // 1 MB

/**
 * Module-level singleton: memoizes the `pipeline(...)` promise so the model
 * loads once per process (LOCAL-01 "2nd call no re-download"). It is reset to
 * `undefined` ONLY on a LOAD error (fail-closed retry — never a memoized partial
 * model). A per-call TRANSCRIBE failure does NOT reset it (WR-01) — a bad audio
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
 * A surfaced STT failure that CARRIES its domain `SttErrorKind` (WR-02).
 *
 * The adapter selects a `SttErrorKind` at each failure branch; attaching it to
 * the returned `Error` (rather than discarding it) lets the Phase-196 obs bridge
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
 * `SttDegradeError` (WR-02). Used for the clean-message guard branches
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
 * branch that wraps a third-party `cause` (WR-02). The `kind` is attached so the
 * Phase-196 obs path can read it without re-deriving; the free-text `detail` is
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
 * `Float32Array`, validating the decode at the boundary (WR-04).
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
 * TEST-ONLY: exercise the WR-04 PCM-boundary guard without shelling real ffmpeg.
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
 * (IN-02: the kind is now ATTACHED to the surfaced error, not discarded — see
 * `degraded`) on any ffmpeg failure OR an empty / non-4-byte-multiple decode
 * (WR-04). Never throws. The temp file is always cleaned up.
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
    // WR-04: validate the decode (empty / non-4-byte-multiple) at the boundary.
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
 * Default SEC-03 size-floor seam: returns `undefined` (size unknown). The
 * transformers.js etag cache layout is NOT a documented contract, so production
 * does NOT guess a model-file path to `fs.stat` (the §2.10 bug class — a
 * hand-built path that may not exist). The size-floor therefore enforces nothing
 * by default; the integrity floor rests on the pinned id + the fail-closed
 * `model_load_failed` seam + the TLS HF-Hub source. Tests inject a concrete size
 * to exercise the floor. `safePath` is used (never raw `path.join`) for any
 * future real inspection that adopts a documented layout.
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
  // SEC-03 pinned-id anchor: only a hardcoded MODEL_IDS value is ever loaded; an
  // unknown/blank key resolves to the pinned default — never the raw caller key.
  const modelId = MODEL_IDS[modelKey] ?? MODEL_IDS[DEFAULT_MODEL]!;

  return {
    async transcribe(
      audio: Buffer,
      options: TranscriptionOptions,
    ): Promise<Result<TranscriptionResult, Error>> {
      // 1. Empty-buffer guard — runs before any engine load or decode.
      if (audio.byteLength === 0) {
        // WR-02: carry the kind like every other branch (clean message, no
        // third-party cause to sanitize → withKind, not degraded).
        return err(withKind(new Error("Audio buffer is empty"), "dependency"));
      }

      // 2. Size cap.
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

      // 4. Lazy engine load — honest-degrade (LOCAL-02), never a module-load crash.
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

      // 5. Singleton pipeline build — fail-closed ONLY on a bad load (SEC-03
      //    seam). IN-01: memoize the pipeline() PROMISE synchronously the moment
      //    the engine module is in hand — there is NO `await` between the
      //    `undefined` check and the assignment, so two near-simultaneous first
      //    calls that reach here serialize on the one shared promise rather than
      //    each building the model (modulo a concurrent cold start where both
      //    are still awaiting loadEngine — see the doc-comment caveat).
      let transcriber: AsrPipeline;
      try {
        if (pipelinePromise === undefined) {
          mod.env["cacheDir"] = cacheDir; // scoped, inside --allow-fs-write (LOCAL-04)
          mod.env["allowRemoteModels"] = true; // first-run HF-Hub download over TLS
          pipelinePromise = mod.pipeline("automatic-speech-recognition", modelId, {
            dtype: "q8", // quantized → minimal first-run download
          });
        }
        transcriber = await pipelinePromise;
      } catch (e: unknown) {
        // Fail-closed: a failed/partial LOAD is NOT memoized — reset so a
        // transient load failure can retry on the next call. This reset is
        // correct ONLY for the load branch (WR-01).
        pipelinePromise = undefined;
        return err(
          degraded(
            "Local whisper model failed to load — the download may be incomplete or the model id is unavailable",
            e,
            "model_load_failed",
          ),
        );
      }

      // SEC-03 size-floor: a pipeline() that "loaded" but whose on-disk model is
      // implausibly small is a truncated/partial download masquerading as a
      // working model (the v2.24/188 silent-corrupt-download lesson). When the
      // size seam reports a concrete sub-floor size, FAIL CLOSED and reset the
      // singleton (same fail-closed discipline as the load catch) so the bad
      // model is never memoized and a re-download is retried. An `undefined`
      // size (the default — cache layout is not a documented contract) enforces
      // nothing.
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
      //    already-loaded model (WR-01). The singleton stays memoized; a bad
      //    audio input is not a reason to thrash the load-once pipeline. The
      //    kind is `dependency` (a runtime inference failure), NOT
      //    `model_load_failed` (the model loaded fine).
      try {
        const out = await transcriber(pcm.value);
        // WR-03: out.text is the result of an injected/dynamically-imported
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
