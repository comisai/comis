// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the in-process keyless local/Piper TTS adapter (TTS-02).
 *
 * The near-verbatim TTS twin of `local-stt-adapter.test.ts`: the engine
 * (`@huggingface/transformers` `text-to-audio`) and the ffmpeg waveform ENCODE
 * are BOTH injected via the `loadEngine` / `encodeWaveform` config seams, so
 * these tests NEVER touch the network, never download a model, and never shell
 * ffmpeg.
 *
 * Coverage: empty-text + over-length guards, honest-degrade (engine missing →
 * Result.err, never a throw), model-load fail-closed (singleton reset → retry),
 * the load-once module-singleton, the scoped `models/tts` cache dir (a SEPARATE
 * subdir from whisper), the URL/secret redaction floor, and the success path
 * (raw f32 waveform → injected encode → ok({ audio, mimeType })).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { safePath } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  createLocalTtsAdapter,
  __resetLocalTtsPipelineForTests,
  type TtsTransformersModule,
} from "./local-tts-adapter.js";

const DATA_DIR = "/tmp/test-data";

/**
 * Build a fake `@huggingface/transformers` module whose `pipeline()` behavior
 * is controlled per-test. `env` is a mutable object so the test can assert the
 * adapter sets `env.cacheDir` before the first `pipeline()` call. The
 * text-to-audio pipeline returns `{ audio: Float32Array, sampling_rate }`.
 */
function makeFakeEngine(opts: {
  /** The raw f32 waveform the synthesiser returns. */
  waveform?: Float32Array;
  samplingRate?: number;
  /** Reject at pipeline() build time (a model load failure). */
  pipelineRejects?: boolean;
  /** Throw at call time (AFTER a successful load) — a synth-time failure. */
  synthThrows?: boolean;
  /** Return this shape from the synthesiser instead of `{ audio, sampling_rate }`. */
  synthResult?: unknown;
}): {
  mod: TtsTransformersModule;
  pipelineSpy: ReturnType<typeof vi.fn>;
  synthSpy: ReturnType<typeof vi.fn>;
  env: Record<string, unknown>;
} {
  const env: Record<string, unknown> = {};
  const synthSpy = vi.fn(async () => {
    if (opts.synthThrows) {
      throw new Error("ONNX runtime inference error: tensor shape mismatch");
    }
    if (opts.synthResult !== undefined) {
      return opts.synthResult;
    }
    return {
      audio: opts.waveform ?? new Float32Array([0.1, -0.2, 0.3, -0.4]),
      sampling_rate: opts.samplingRate ?? 16000,
    };
  });
  const pipelineSpy = vi.fn(async () => {
    if (opts.pipelineRejects) {
      throw new Error("ONNX model load failed: short read");
    }
    return synthSpy;
  });
  const mod = { env, pipeline: pipelineSpy } as unknown as TtsTransformersModule;
  return { mod, pipelineSpy, synthSpy, env };
}

/** A successful injected ffmpeg ENCODE seam: returns a fixed audio buffer. */
function encodeOk(): (waveform: Float32Array, sr: number) => Promise<Result<Buffer, Error>> {
  return async () => ok(Buffer.from([0xff, 0xf3, 0x44, 0x00])); // an mp3-ish stub buffer
}

beforeEach(() => {
  __resetLocalTtsPipelineForTests();
});

describe("createLocalTtsAdapter", () => {
  it("returns err with 'Text is empty' before any engine load on empty text", async () => {
    const loadEngine = vi.fn(async () => makeFakeEngine({}).mod);
    const encodeWaveform = vi.fn(encodeOk());
    const adapter = createLocalTtsAdapter({ dataDir: DATA_DIR, loadEngine, encodeWaveform });

    const result = await adapter.synthesize("");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Text is empty");
    }
    // The guard MUST run before any engine load or encode.
    expect(loadEngine).not.toHaveBeenCalled();
    expect(encodeWaveform).not.toHaveBeenCalled();
  });

  it("returns err with 'exceeds maximum' for text just over the max-length cap", async () => {
    const loadEngine = vi.fn(async () => makeFakeEngine({}).mod);
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      maxTextLength: 10,
      loadEngine,
      encodeWaveform: encodeOk(),
    });

    const result = await adapter.synthesize("x".repeat(11));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds maximum");
    }
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it("honest-degrades to Result.err (never throws) when the engine import rejects", async () => {
    const loadEngine = vi.fn(async () => {
      throw new Error("Cannot find module '@huggingface/transformers'");
    });
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      encodeWaveform: encodeOk(),
    });

    // The call resolves a Result — it does NOT throw.
    await expect(adapter.synthesize("hello")).resolves.toMatchObject({ ok: false });
    expect(loadEngine).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a model load error and resets the singleton so a second call retries pipeline()", async () => {
    const fake = makeFakeEngine({ pipelineRejects: true });
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      encodeWaveform: encodeOk(),
    });

    const first = await adapter.synthesize("hello");
    const second = await adapter.synthesize("hello");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok) {
      expect((first.error as { kind?: string }).kind).toBe("model_load_failed");
    }
    // Fail-closed: a partial/failed load is NOT memoized — pipeline() is retried.
    expect(fake.pipelineSpy).toHaveBeenCalledTimes(2);
  });

  it("loads the pipeline exactly once across two successful synthesize() calls (module-singleton)", async () => {
    const fake = makeFakeEngine({ waveform: new Float32Array([0.5, 0.5]) });
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      encodeWaveform: encodeOk(),
    });

    const first = await adapter.synthesize("one");
    const second = await adapter.synthesize("two");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // The load-once proof: pipeline() built the synthesiser exactly once.
    expect(fake.pipelineSpy).toHaveBeenCalledTimes(1);
    // Both synths ran against the SAME cached pipeline.
    expect(fake.synthSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT evict the loaded singleton on a synth-time throw, and labels it 'dependency' not a load failure", async () => {
    // The model LOADS fine (pipeline resolves), but the synthesiser THROWS at
    // call time — a per-call inference failure, not a load failure.
    const fake = makeFakeEngine({ synthThrows: true });
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      encodeWaveform: encodeOk(),
    });

    const first = await adapter.synthesize("hello");
    const second = await adapter.synthesize("hello");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // (a) Singleton preserved: a synth-time failure must NOT rebuild the pipeline.
    expect(fake.pipelineSpy).toHaveBeenCalledTimes(1);
    // (b) The synth seam ran on both calls against the SAME cached pipeline.
    expect(fake.synthSpy).toHaveBeenCalledTimes(2);
    // (c) Not mislabeled as a load failure — a synth failure is 'dependency'.
    if (!first.ok) {
      expect(first.error.message).not.toContain("failed to load");
      expect((first.error as { kind?: string }).kind).toBe("dependency");
    }
  });

  it("returns err (not a phantom ok) when the engine yields an unexpected output shape", async () => {
    const fake = makeFakeEngine({ synthResult: { notAudio: 123 } });
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => fake.mod,
      encodeWaveform: encodeOk(),
    });

    const result = await adapter.synthesize("hello");

    // The contract is `{ audio: Float32Array }` — a missing/non-array audio must
    // NOT surface as a phantom ok (the silent-corrupt failure mode).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unexpected engine output shape");
      expect((result.error as { kind?: string }).kind).toBe("dependency");
    }
  });

  it("returns the encode error when the ffmpeg waveform encode fails", async () => {
    const fake = makeFakeEngine({ waveform: new Float32Array([0.1, 0.2]) });
    const encodeWaveform = vi.fn(async () => err(new Error("ffmpeg missing")));
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => fake.mod,
      encodeWaveform,
    });

    const result = await adapter.synthesize("hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ffmpeg missing");
    }
    expect(encodeWaveform).toHaveBeenCalledTimes(1);
  });

  it("sets env.cacheDir to the scoped safePath under models/tts before the first pipeline() call", async () => {
    const fake = makeFakeEngine({});
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      encodeWaveform: encodeOk(),
    });

    await adapter.synthesize("hello");

    // A SEPARATE subdir from whisper — models/tts, never models/whisper.
    expect(fake.env["cacheDir"]).toBe(safePath(DATA_DIR, "models", "tts"));
    expect(fake.env["cacheDir"]).not.toBe(safePath(DATA_DIR, "models", "whisper"));
  });

  it("redacts a credential-bearing URL/token from the surfaced error message", async () => {
    const loadEngine = vi.fn(async () => {
      throw new Error(
        "failed http://127.0.0.1:9000/v1/audio/speech?token=supersecretlongtokenvalue1234567",
      );
    });
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      encodeWaveform: encodeOk(),
    });

    const result = await adapter.synthesize("hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("http://127.0.0.1:9000/v1/audio/speech");
      expect(result.error.message).not.toContain("supersecretlongtokenvalue1234567");
      expect(result.error.message).toContain("[URL]");
    }
  });

  it("synthesizes successfully: injected engine waveform → injected encode → ok({ audio, mimeType })", async () => {
    const waveform = new Float32Array([0.5, -0.25, 1.0, -1.0]);
    const fake = makeFakeEngine({ waveform, samplingRate: 16000 });
    const audioBuf = Buffer.from([0x49, 0x44, 0x33]); // "ID3"
    const encodeWaveform = vi.fn(
      async (wf: Float32Array, sr: number): Promise<Result<Buffer, Error>> => {
        // The encode seam receives the model's raw waveform + sample rate.
        expect(wf).toBe(waveform);
        expect(sr).toBe(16000);
        return ok(audioBuf);
      },
    );
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => fake.mod,
      encodeWaveform,
    });

    const result = await adapter.synthesize("the quick brown fox");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audio).toBe(audioBuf);
      expect(result.value.mimeType).toBe("audio/mpeg");
    }
    expect(encodeWaveform).toHaveBeenCalledTimes(1);
  });

  it("loads the pinned single-speaker MMS-TTS model id (not an arbitrary remote id)", async () => {
    const fake = makeFakeEngine({});
    const adapter = createLocalTtsAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => fake.mod,
      encodeWaveform: encodeOk(),
    });

    await adapter.synthesize("hello");

    expect(fake.pipelineSpy).toHaveBeenCalledTimes(1);
    const [task, modelId] = fake.pipelineSpy.mock.calls[0]!;
    expect(task).toBe("text-to-audio");
    // The pinned id — a single-speaker MMS-TTS/VITS repo (no speaker embeddings).
    expect(modelId).toBe("Xenova/mms-tts-eng");
  });
});
