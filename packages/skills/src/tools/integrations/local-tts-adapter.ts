// SPDX-License-Identifier: Apache-2.0
/**
 * In-process keyless local/Piper TTS adapter.
 *
 * The offline keyless rung of TTS `auto` (`edge → local/piper →
 * honest-unavailable`): it synthesizes speech with NO key and NO network at
 * synth time by running a single-speaker `text-to-audio` model in-process via
 * `@huggingface/transformers` (Transformers.js), auto-downloading a small ONNX
 * voice model on first use to a scoped cache under `~/.comis/models/tts/`, then
 * reusing it on every later call (a module-level singleton — the model loads
 * once per process and is NOT evicted by a per-call synth failure, only by a
 * load failure; modulo a concurrent cold start where two simultaneous first
 * calls can each build it before the promise is memoized — a self-healing
 * cold-start-only inefficiency).
 *
 * This is the near-verbatim TTS twin of `local-stt-adapter.ts` — same lazy
 * guarded import, same fail-closed module-singleton, same scoped `safePath`
 * cache, same redaction + kind-carrying honest-degrade discipline — with the
 * data flow INVERTED: STT decodes inbound audio → text; TTS synthesizes text →
 * a raw f32 waveform, then ENCODES that waveform to an audio buffer (the inverse
 * of STT's ffmpeg decode).
 *
 * Design constraints (all enforced by local-tts-adapter.test.ts):
 *  - **Honest-degrade:** the engine is lazy-imported INSIDE a guarded
 *    `await import("@huggingface/transformers")` — NEVER a top-level static
 *    import — so a missing/broken install (or its native ORT addon) yields
 *    `Result.err` rather than crashing the whole `@comis/skills` import graph.
 *    Every failure branch returns `ok(...)` / `err(...)`; this module NEVER
 *    `throw`s (the raw-throw architecture gate).
 *  - **Waveform encode:** the model's raw f32 waveform is encoded to MP3 by
 *    shelling the existing ffmpeg binary (`-f f32le -ar <sr> -ac 1 -i - out.mp3`)
 *    — the INVERSE of STT's PCM decode; no new audio library (mirrors
 *    `audio-converter.ts` / `local-stt-adapter.ts`).
 *  - **Scoped cache:** `env.cacheDir` is set to `safePath(dataDir, "models",
 *    "tts")` (NEVER raw `path.join`) — a SEPARATE subdir from `models/whisper/`
 *    — before the first `pipeline()` call; that path is already inside the
 *    daemon's `--allow-fs-write=${COMIS_DATA_DIR}` scope, so no new permission flag.
 *  - **Fail-closed + integrity:** a short/corrupt model load → `err` (kind
 *    `model_load_failed`) and the singleton is RESET so a transient failure can
 *    retry — never a silent partial-model success. The pinned `MODEL_ID` anchor
 *    (only a hardcoded single-speaker MMS-TTS id is loaded) + the TLS HF-Hub
 *    source are the integrity floor (transformers.js exposes NO caller-visible
 *    content-hash — same honest limit as STT).
 *  - **Redaction (light floor):** every surfaced error string is passed
 *    through `sanitizeApiError`, which strips URLs (`[URL]`) and long tokens
 *    (`[REDACTED]`), so no credential-bearing `baseUrl`/token leaks.
 *
 * The engine loader and the ffmpeg waveform encode are injectable config seams
 * (`loadEngine` / `encodeWaveform`) so unit tests never touch the network or
 * ffmpeg; they default to the real lazy-import + ffmpeg path.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { TTSPort, TTSOptions, TTSResult } from "@comis/core";
import { safePath } from "@comis/core";
import type { SttErrorKind } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { sanitizeApiError } from "./media-adapter-shared.js";

const execFileAsync = promisify(execFile);

/**
 * The result shape of the transformers.js `text-to-audio` pipeline: a raw f32
 * waveform plus its sample rate (the VITS/MMS-TTS native rate).
 */
interface TtaOutput {
  audio: Float32Array;
  sampling_rate: number;
}

/** Text-to-audio pipeline: takes text → `{ audio: Float32Array, sampling_rate }`. */
type TtaPipeline = (text: string) => Promise<TtaOutput>;

/**
 * The subset of `@huggingface/transformers` the adapter consumes. `env` is the
 * library's mutable global config (we set `cacheDir` / `allowRemoteModels` on
 * it); `pipeline` builds the text-to-audio synthesiser.
 */
export interface TtsTransformersModule {
  env: Record<string, unknown>;
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<TtaPipeline>;
}

/** Configuration for the in-process local/Piper TTS adapter. */
export interface LocalTtsConfig {
  /** Reserved for future multi-voice support; the current pin is single-speaker. */
  readonly model?: string;
  /** Data directory; the model cache is `<dataDir>/models/tts/`. */
  readonly dataDir: string;
  /** Default voice (carried opaquely; the current MMS-TTS pin is single-speaker). */
  readonly voice?: string;
  /** Output audio format hint (carried opaquely; ffmpeg encodes to MP3). */
  readonly format?: string;
  /** Maximum text length in characters (default: 5000). */
  readonly maxTextLength?: number;
  /**
   * Engine loader seam. Defaults to a guarded lazy `import("@huggingface/transformers")`.
   * Injected in tests to avoid a real model download.
   */
  readonly loadEngine?: () => Promise<TtsTransformersModule>;
  /**
   * Waveform encode seam: raw f32 waveform + sample rate → an audio Buffer.
   * Defaults to the ffmpeg shell (`-f f32le -ar <sr> -ac 1 -i - out.mp3`).
   * Injected in tests to avoid shelling ffmpeg.
   */
  readonly encodeWaveform?: (
    waveform: Float32Array,
    samplingRate: number,
  ) => Promise<Result<Buffer, Error>>;
}

const DEFAULT_MAX_TEXT_LENGTH = 5000;
const ENCODE_TIMEOUT_MS = 30_000;
const OUTPUT_MIME = "audio/mpeg";

/**
 * The pinned single-speaker `text-to-audio` model id (the integrity anchor:
 * only this hardcoded id is ever loaded — no caller-supplied/arbitrary remote
 * id can be fetched). `Xenova/mms-tts-eng` is a VITS/MMS-TTS English voice that
 * needs NO speaker-embeddings tensor (unlike SpeechT5), so it synthesizes from
 * text alone. The transformers.js `text-to-audio` pipeline builds against it and
 * synthesizes a real f32 waveform. Fetched over TLS from the HF Hub
 * (`allowRemoteModels`).
 *
 * Integrity scope (same honest limit as STT): pinned id + TLS + the
 * fail-closed `model_load_failed` seam — NOT a pinned content-hash
 * (transformers.js etag-caches but exposes no caller-visible content-hash API).
 */
const MODEL_ID = "Xenova/mms-tts-eng";

/**
 * Module-level singleton: memoizes the `pipeline(...)` promise so the model
 * loads once per process. It is reset to `undefined` ONLY on a LOAD error
 * (fail-closed retry — never a memoized partial model). A per-call SYNTH failure
 * does NOT reset it — a bad text input must not thrash the good, already-loaded
 * model.
 */
let pipelinePromise: Promise<TtaPipeline> | undefined;

/**
 * TEST-ONLY: reset the module singleton between tests. Not exported on the
 * package barrel — only imported by `local-tts-adapter.test.ts` (same invariant
 * as `__resetLocalWhisperPipelineForTests`).
 */
export function __resetLocalTtsPipelineForTests(): void {
  pipelinePromise = undefined;
}

/**
 * A surfaced TTS failure that CARRIES its domain `SttErrorKind`. The same error
 * vocabulary serves STT and TTS (the resolver and the obs bridge read
 * `error.kind` directly instead of re-deriving it). Kept
 * adapter-local; the helper RETURNS the error to `Result.err` (no raw throw).
 */
export interface TtsDegradeError extends Error {
  readonly kind: SttErrorKind;
}

/**
 * Attach a domain `SttErrorKind` onto an Error and brand it as a
 * `TtsDegradeError`. Used for the clean-message guard branches (empty text /
 * over-length) where the message needs no third-party sanitization — only the
 * kind. Writable assign; public shape is readonly.
 */
function withKind(error: Error, kind: SttErrorKind): TtsDegradeError {
  (error as unknown as Record<string, unknown>)["kind"] = kind;
  return error as unknown as TtsDegradeError;
}

/**
 * Build a redacted, hint-bearing, kind-carrying Error for a surfaced failure
 * branch that wraps a third-party `cause`. The `kind` is attached so the obs
 * path can read it without re-deriving; the free-text `detail` is run through
 * `sanitizeApiError` (strips URLs → `[URL]`, long tokens → `[REDACTED]`) so no
 * credential-bearing `baseUrl`/token leaks.
 */
function degraded(hint: string, cause: unknown, kind: SttErrorKind): TtsDegradeError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return withKind(new Error(`${hint} — ${sanitizeApiError(0, detail, "Local TTS")}`), kind);
}

/**
 * Default ffmpeg ENCODE seam: writes the model's raw f32le waveform to a temp
 * file and shells ffmpeg to encode it to MP3 (`-f f32le -ar <sr> -ac 1 -i in
 * out.mp3`) — the INVERSE of STT's PCM decode. Mirrors `audio-converter.ts`'s
 * `execFile`+`safePath`+`Result` discipline. Returns a `degraded(...)` `err`
 * carrying kind `dependency` on any ffmpeg failure. Never throws. The temp files
 * are always cleaned up.
 */
async function defaultEncodeWaveform(
  waveform: Float32Array,
  samplingRate: number,
): Promise<Result<Buffer, Error>> {
  const tempDir = os.tmpdir();
  const inputPath = safePath(tempDir, `tts-pcm-${crypto.randomUUID()}.raw`);
  const outputPath = safePath(tempDir, `tts-out-${crypto.randomUUID()}.mp3`);
  try {
    // Write the f32le PCM (copy the typed array's exact byte range).
    const pcm = Buffer.from(waveform.buffer, waveform.byteOffset, waveform.byteLength);
    await fs.writeFile(inputPath, pcm);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "f32le",
        "-ar",
        String(samplingRate),
        "-ac",
        "1",
        "-i",
        inputPath,
        outputPath,
      ],
      { timeout: ENCODE_TIMEOUT_MS },
    );
    const audio = await fs.readFile(outputPath);
    if (audio.byteLength === 0) {
      return err(
        degraded(
          "ffmpeg produced no audio when encoding the local TTS waveform",
          new Error("encoded bytes=0"),
          "dependency",
        ),
      );
    }
    // Copy out of the file-backed buffer so it survives temp cleanup.
    return ok(Buffer.from(audio));
  } catch (e: unknown) {
    return err(
      degraded(
        "ffmpeg failed to encode the local TTS waveform — ensure ffmpeg is installed",
        e,
        "dependency",
      ),
    );
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => undefined);
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

/** Default engine loader: a guarded lazy import (never a top-level static import). */
async function defaultLoadEngine(): Promise<TtsTransformersModule> {
  // The literal module name appears ONLY here, inside the guarded loader, so a
  // missing/broken install degrades to Result.err in synthesize() rather than
  // crashing the @comis/skills import graph.
  const mod = (await import("@huggingface/transformers")) as unknown as TtsTransformersModule;
  return mod;
}

/**
 * Create the in-process keyless local/Piper TTS adapter.
 *
 * No API key, no network at synth time after the first load. The first
 * `synthesize()` lazy-loads the engine, downloads + caches the model once, then
 * synthesizes a raw f32 waveform and encodes it to MP3 via ffmpeg; later calls
 * reuse the cached pipeline. Every failure branch returns `Result.err` — never
 * throws.
 */
export function createLocalTtsAdapter(cfg: LocalTtsConfig): TTSPort {
  const maxTextLength = cfg.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const cacheDir = safePath(cfg.dataDir, "models", "tts");
  const loadEngine = cfg.loadEngine ?? defaultLoadEngine;
  const encodeWaveform = cfg.encodeWaveform ?? defaultEncodeWaveform;

  return {
    // `_options` (voice/format/speed) is intentionally ignored. The pinned
    // Xenova/mms-tts-eng model is single-speaker (so `voice` is meaningless) and
    // this offline rung ALWAYS emits `OUTPUT_MIME` ("audio/mpeg") — the requested
    // `format` is NOT honored here; the voice pipeline re-encodes downstream
    // (needsConversion) to the channel's container, so playback still works. A
    // caller must not assume the returned MIME matches a requested format.
    async synthesize(text: string, _options?: TTSOptions): Promise<Result<TTSResult, Error>> {
      // 1. Empty-text guard — runs before any engine load (mirror edge-tts).
      //    A validation failure, but the closed SttErrorKind vocabulary
      //    (voice-error.ts) has no `validation` member → `dependency` is the
      //    deliberate mapping, NOT a real missing-dependency failure.
      if (text.length === 0) {
        return err(withKind(new Error("Text is empty"), "dependency"));
      }

      // 2. Max-length guard. A validation failure, `dependency` per the
      //    vocabulary constraint above.
      if (text.length > maxTextLength) {
        return err(
          withKind(
            new Error(`Text length ${text.length} exceeds maximum of ${maxTextLength} characters`),
            "dependency",
          ),
        );
      }

      // 3. Lazy engine load — honest-degrade, never a module-load crash.
      let mod: TtsTransformersModule;
      try {
        mod = await loadEngine();
      } catch (e: unknown) {
        return err(
          degraded(
            "Local TTS engine unavailable — install @huggingface/transformers or use the keyless Edge TTS provider",
            e,
            "dependency",
          ),
        );
      }

      // 4. Singleton pipeline build — fail-closed ONLY on a bad load. Memoize the
      //    pipeline() PROMISE synchronously the moment the engine module is in
      //    hand (no `await` between the `undefined` check and the assignment) so
      //    two near-simultaneous first calls serialize on the one shared promise.
      let synth: TtaPipeline;
      try {
        if (pipelinePromise === undefined) {
          mod.env["cacheDir"] = cacheDir; // scoped, inside --allow-fs-write
          mod.env["allowRemoteModels"] = true; // first-run HF-Hub download over TLS
          pipelinePromise = mod.pipeline("text-to-audio", MODEL_ID);
        }
        synth = await pipelinePromise;
      } catch (e: unknown) {
        // Fail-closed: a failed/partial LOAD is NOT memoized — reset so a
        // transient load failure can retry on the next call.
        pipelinePromise = undefined;
        return err(
          degraded(
            "Local TTS model failed to load — the download may be incomplete or the model id is unavailable",
            e,
            "model_load_failed",
          ),
        );
      }

      // 5. Synthesize — a per-call inference failure does NOT evict the good,
      //    already-loaded model. The kind is `dependency` (a runtime synth
      //    failure), NOT `model_load_failed` (the model loaded fine).
      let output: TtaOutput;
      try {
        output = await synth(text);
      } catch (e: unknown) {
        return err(degraded("Local TTS failed to synthesize this text", e, "dependency"));
      }

      // 6. Validate the engine output shape at the boundary — an unexpected
      //    shape ({}, { audio: undefined }) must surface as an honest err, not a
      //    phantom ok fed into ffmpeg (the silent-corrupt failure mode).
      const waveform = output?.audio;
      if (!(waveform instanceof Float32Array)) {
        return err(
          degraded(
            "Local TTS returned no waveform — unexpected engine output shape",
            new Error(`unexpected audio type: ${typeof output?.audio}`),
            "dependency",
          ),
        );
      }
      // Known limitation: a missing/zero/NaN sampling_rate paired with a valid
      // waveform falls back to 16000 rather than surfacing a degraded err. The
      // pinned MMS-TTS model always returns a valid rate in practice, so this is
      // not currently observed; tightening it to an honest err (consistent with
      // the waveform-shape guard above) is a possible follow-up, kept as a
      // fallback here to avoid a behavior regression.
      const samplingRate =
        typeof output.sampling_rate === "number" && output.sampling_rate > 0
          ? output.sampling_rate
          : 16000;

      // 7. Encode the raw f32 waveform to audio (the inverse of STT's decode).
      const encoded = await encodeWaveform(waveform, samplingRate);
      if (!encoded.ok) {
        return encoded;
      }

      return ok({ audio: encoded.value, mimeType: OUTPUT_MIME });
    },
  };
}
