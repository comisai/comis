// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the in-process keyless whisper STT adapter.
 *
 * The engine (`@huggingface/transformers`) and the ffmpeg PCM decode are BOTH
 * injected via the `loadEngine` / `decodeToPcm16kF32` config seams, so these
 * tests NEVER touch the network, never download a model, and never shell ffmpeg.
 *
 * Coverage: empty-buffer + oversize guards, honest-degrade (engine missing →
 * Result.err, never a throw), decode failure, model-load fail-closed (singleton
 * reset → retry), the load-once module-singleton, the scoped cache dir, and the
 * URL/secret redaction floor.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { safePath } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import {
  createLocalWhisperAdapter,
  __resetLocalWhisperPipelineForTests,
  __pcmBufferToSamplesForTests,
  type TransformersModule,
} from "./local-stt-adapter.js";

/**
 * Hoisted, mutable controls for the DEFAULT-seam mocks. The "default seams" block
 * exercises defaultLoadEngine (the guarded lazy `import`) + defaultDecodeToPcm16kF32
 * (the ffmpeg `execFile` shell + PCM read) by NOT injecting those seams — so we
 * mock the external module + the node built-ins, no real network/ffmpeg. The 17
 * tests above inject both seams, so these mocks are inert for them.
 */
const seam = vi.hoisted(() => ({
  ffmpeg: "ok" as "ok" | "fail",
  pcmBytes: 16, // a 4-byte-multiple → 4 f32 samples
}));

vi.mock("@huggingface/transformers", () => {
  const transcribe = vi.fn(async () => ({ text: "default-engine transcript" }));
  return { env: {}, pipeline: vi.fn(async () => transcribe) };
});

vi.mock("node:child_process", () => ({
  // promisify(execFile) calls this as (file, args, options, callback).
  execFile: (
    _file: string,
    _args: readonly string[],
    _opts: unknown,
    cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void,
  ) => {
    if (seam.ffmpeg === "fail") {
      cb(new Error("ffmpeg: command not found"));
      return;
    }
    cb(null, { stdout: "", stderr: "" });
  },
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.alloc(seam.pcmBytes, 1)),
  rm: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 1024 })),
}));

const DATA_DIR = "/tmp/test-data";

/**
 * Build a fake `@huggingface/transformers` module whose `pipeline()` behavior
 * is controlled per-test. `env` is a mutable object so the test can assert the
 * adapter sets `env.cacheDir` before the first `pipeline()` call.
 */
function makeFakeEngine(opts: {
  transcribeText?: string;
  pipelineRejects?: boolean;
  /** Throw at call time (AFTER a successful load) to exercise the transcribe seam. */
  transcribeThrows?: boolean;
  /** Return this shape from the transcriber instead of `{ text }` (WR-03). */
  transcribeResult?: unknown;
}): {
  mod: TransformersModule;
  pipelineSpy: ReturnType<typeof vi.fn>;
  transcribeSpy: ReturnType<typeof vi.fn>;
  env: Record<string, unknown>;
} {
  const env: Record<string, unknown> = {};
  const transcribeSpy = vi.fn(async () => {
    if (opts.transcribeThrows) {
      throw new Error("ONNX runtime inference error: tensor shape mismatch");
    }
    if (opts.transcribeResult !== undefined) {
      return opts.transcribeResult;
    }
    return { text: opts.transcribeText ?? "hello" };
  });
  const pipelineSpy = vi.fn(async () => {
    if (opts.pipelineRejects) {
      throw new Error("ONNX model load failed: short read");
    }
    return transcribeSpy;
  });
  const mod = { env, pipeline: pipelineSpy } as unknown as TransformersModule;
  return { mod, pipelineSpy, transcribeSpy, env };
}

function pcmOk(): Result<Float32Array, Error> {
  return ok(new Float32Array([0.1, 0.2, 0.3]));
}

beforeEach(() => {
  __resetLocalWhisperPipelineForTests();
});

describe("createLocalWhisperAdapter", () => {
  it("returns err with 'Audio buffer is empty' before any engine load on a zero-length buffer", async () => {
    const loadEngine = vi.fn(async () => makeFakeEngine({}).mod);
    const decodeToPcm16kF32 = vi.fn(async () => pcmOk());
    const adapter = createLocalWhisperAdapter({ dataDir: DATA_DIR, loadEngine, decodeToPcm16kF32 });

    const result = await adapter.transcribe(Buffer.alloc(0), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Audio buffer is empty");
    }
    // The guard MUST run before any engine load or decode.
    expect(loadEngine).not.toHaveBeenCalled();
    expect(decodeToPcm16kF32).not.toHaveBeenCalled();
  });

  it("returns err with 'exceeds limit' for a buffer just over the maxFileSizeMb cap", async () => {
    const loadEngine = vi.fn(async () => makeFakeEngine({}).mod);
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      maxFileSizeMb: 1,
      loadEngine,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    const oversize = Buffer.alloc(1024 * 1024 + 1); // 1 byte over 1 MB

    const result = await adapter.transcribe(oversize, { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds limit");
    }
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it("honest-degrades to Result.err (never throws) when the engine import rejects", async () => {
    const loadEngine = vi.fn(async () => {
      throw new Error("Cannot find module '@huggingface/transformers'");
    });
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    // The call resolves a Result — it does NOT throw.
    const result = await expect(
      adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" }),
    ).resolves.toMatchObject({ ok: false });
    void result;

    // Confirm the lazy loader was actually awaited (the degrade path ran).
    expect(loadEngine).toHaveBeenCalledTimes(1);
  });

  it("returns the decode error without attempting an engine load when decode fails", async () => {
    const loadEngine = vi.fn(async () => makeFakeEngine({}).mod);
    const decodeToPcm16kF32 = vi.fn(async () => err(new Error("ffmpeg missing")));
    const adapter = createLocalWhisperAdapter({ dataDir: DATA_DIR, loadEngine, decodeToPcm16kF32 });

    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ffmpeg missing");
    }
    expect(decodeToPcm16kF32).toHaveBeenCalledTimes(1);
    // Decode failure short-circuits — no engine load after a decode fail.
    expect(loadEngine).not.toHaveBeenCalled();
  });

  it("fails closed on a model load error and resets the singleton so a second call retries pipeline()", async () => {
    const fake = makeFakeEngine({ pipelineRejects: true });
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    const first = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });
    const second = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // Fail-closed: a partial/failed load is NOT memoized — pipeline() is retried.
    expect(fake.pipelineSpy).toHaveBeenCalledTimes(2);
  });

  it("loads the pipeline exactly once across two successful transcribe() calls (module-singleton)", async () => {
    const fake = makeFakeEngine({ transcribeText: "hello" });
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    const first = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });
    const second = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.value.text).toBe("hello");
    if (second.ok) expect(second.value.text).toBe("hello");
    // The load-once proof: pipeline() built the transcriber exactly once.
    expect(fake.pipelineSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT evict the loaded singleton on a transcribe-time throw, and labels it 'dependency' not a load failure (WR-01)", async () => {
    // The model LOADS fine (pipeline resolves), but the transcriber THROWS at
    // call time — a per-call inference failure, not a load failure.
    const fake = makeFakeEngine({ transcribeThrows: true });
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    const first = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });
    const second = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    // (a) Singleton preserved: a transcribe-time failure must NOT rebuild the
    //     pipeline — pipeline() is called exactly ONCE across both calls.
    expect(fake.pipelineSpy).toHaveBeenCalledTimes(1);
    // (b) The transcribe seam ran on both calls against the SAME cached pipeline.
    expect(fake.transcribeSpy).toHaveBeenCalledTimes(2);
    // (c) Not mislabeled as a load failure — a transcribe failure is 'dependency'.
    if (!first.ok) {
      expect(first.error.message).not.toContain("failed to load");
      expect((first.error as { kind?: string }).kind).toBe("dependency");
    }
  });

  it("attaches the SttErrorKind to every surfaced failure branch (WR-02)", async () => {
    // Empty-buffer branch → 'dependency'.
    const emptyAdapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => makeFakeEngine({}).mod,
      decodeToPcm16kF32: async () => pcmOk(),
    });
    const emptyResult = await emptyAdapter.transcribe(Buffer.alloc(0), { mimeType: "audio/ogg" });
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) {
      expect((emptyResult.error as { kind?: string }).kind).toBe("dependency");
    }

    // Oversize branch → 'dependency'.
    const oversizeAdapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      maxFileSizeMb: 1,
      loadEngine: async () => makeFakeEngine({}).mod,
      decodeToPcm16kF32: async () => pcmOk(),
    });
    const oversizeResult = await oversizeAdapter.transcribe(Buffer.alloc(1024 * 1024 + 1), {
      mimeType: "audio/ogg",
    });
    expect(oversizeResult.ok).toBe(false);
    if (!oversizeResult.ok) {
      expect((oversizeResult.error as { kind?: string }).kind).toBe("dependency");
    }

    // Model-load branch → 'model_load_failed'.
    const loadFailAdapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => makeFakeEngine({ pipelineRejects: true }).mod,
      decodeToPcm16kF32: async () => pcmOk(),
    });
    const loadFailResult = await loadFailAdapter.transcribe(Buffer.from("audio"), {
      mimeType: "audio/ogg",
    });
    expect(loadFailResult.ok).toBe(false);
    if (!loadFailResult.ok) {
      expect((loadFailResult.error as { kind?: string }).kind).toBe("model_load_failed");
    }
  });

  it("returns err (not a phantom ok with undefined text) when the engine yields an unexpected output shape (WR-03)", async () => {
    const fake = makeFakeEngine({ transcribeResult: { notText: 123 } });
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => fake.mod,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    // The contract is `text: string` — a missing/non-string text must NOT
    // surface as ok({ text: undefined }) (the phantom-success failure mode).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unexpected engine output shape");
      expect((result.error as { kind?: string }).kind).toBe("dependency");
    }
  });

  it("sets env.cacheDir to the scoped safePath under the data dir before the first pipeline() call", async () => {
    const fake = makeFakeEngine({});
    const loadEngine = vi.fn(async () => fake.mod);
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(fake.env["cacheDir"]).toBe(safePath(DATA_DIR, "models", "whisper"));
  });

  it("redacts a credential-bearing URL/token from the surfaced error message", async () => {
    const loadEngine = vi.fn(async () => {
      throw new Error(
        "failed http://127.0.0.1:9000/v1/audio/transcriptions?token=supersecretlongtokenvalue1234567",
      );
    });
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(
        "http://127.0.0.1:9000/v1/audio/transcriptions",
      );
      expect(result.error.message).not.toContain("supersecretlongtokenvalue1234567");
      expect(result.error.message).toContain("[URL]");
    }
  });

  it("treats a zero-byte decoded PCM as a decode failure, not an empty Float32Array (WR-04)", () => {
    // ffmpeg "succeeded" (exit 0) but wrote no PCM — a valid container with no
    // decodable audio stream, or a 0-duration clip. The old code produced an
    // empty Float32Array fed into the engine; now it must be a decode error.
    const result = __pcmBufferToSamplesForTests(Buffer.alloc(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no decodable PCM");
      expect((result.error as { kind?: string }).kind).toBe("dependency");
    }
  });

  it("treats a non-multiple-of-4 decoded PCM length as a decode failure (WR-04)", () => {
    // f32le PCM must be a whole number of 4-byte float samples; 1-3 stray bytes
    // are a decode anomaly, not a sample to silently truncate.
    const result = __pcmBufferToSamplesForTests(Buffer.alloc(6)); // 6 % 4 !== 0
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no decodable PCM");
    }
  });

  it("decodes a valid 4-byte-multiple PCM buffer into the right number of samples (WR-04)", () => {
    const buf = Buffer.alloc(12); // 3 float32 samples
    buf.writeFloatLE(0.5, 0);
    buf.writeFloatLE(-0.25, 4);
    buf.writeFloatLE(1.0, 8);
    const result = __pcmBufferToSamplesForTests(buf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(Array.from(result.value)).toEqual([0.5, -0.25, 1.0]);
    }
  });

  it("transcribes successfully through the injected decode + engine seams without touching the network", async () => {
    const fake = makeFakeEngine({ transcribeText: "the quick brown fox" });
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      loadEngine: async () => fake.mod,
      decodeToPcm16kF32: async () => pcmOk(),
    });

    const result = await adapter.transcribe(Buffer.from("audio"), {
      mimeType: "audio/ogg",
      language: "en",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("the quick brown fox");
      expect(result.value.language).toBe("en");
    }
  });

  // ===========================================================================
  // SEC-03: model-download integrity hardening (pinned id + size-floor +
  // confirm fail-closed). HONEST scope: pinned id + TLS + the existing
  // fail-closed model_load_failed seam + an OPTIONAL size-floor. There is NO
  // caller-visible content-hash (transformers.js exposes none) — so NO test
  // mocks a "hash mismatch" the production code never computes (Pitfall 4).
  // ===========================================================================
  describe("SEC-03 model-download integrity", () => {
    it("loads the model id from the pinned MODEL_IDS map (onnx-community/whisper-*) for a known key", async () => {
      const fake = makeFakeEngine({});
      const adapter = createLocalWhisperAdapter({
        dataDir: DATA_DIR,
        model: "small",
        loadEngine: async () => fake.mod,
        decodeToPcm16kF32: async () => pcmOk(),
      });

      await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

      // The pinned id — NOT an arbitrary/remote id — is what pipeline() receives.
      expect(fake.pipelineSpy).toHaveBeenCalledTimes(1);
      const [task, modelId] = fake.pipelineSpy.mock.calls[0]!;
      expect(task).toBe("automatic-speech-recognition");
      expect(modelId).toBe("onnx-community/whisper-small");
    });

    it("falls back to the pinned default 'base' id for an unknown/blank model key (no arbitrary remote id)", async () => {
      const fake = makeFakeEngine({});
      const adapter = createLocalWhisperAdapter({
        dataDir: DATA_DIR,
        model: "nonexistent-model-key",
        loadEngine: async () => fake.mod,
        decodeToPcm16kF32: async () => pcmOk(),
      });

      await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

      const [, modelId] = fake.pipelineSpy.mock.calls[0]!;
      // An unknown key resolves to the pinned default id, never the raw key.
      expect(modelId).toBe("onnx-community/whisper-base");
    });

    it("fails closed with model_load_failed and resets the singleton when the post-load size-floor reports a near-zero cached model (SEC-03)", async () => {
      const fake = makeFakeEngine({ transcribeText: "should-never-be-reached" });
      // The injected size seam reports an implausibly small on-disk model — a
      // truncated/partial download masquerading as a loaded pipeline.
      const statModelCache = vi.fn(async () => 128);
      const adapter = createLocalWhisperAdapter({
        dataDir: DATA_DIR,
        loadEngine: async () => fake.mod,
        decodeToPcm16kF32: async () => pcmOk(),
        statModelCache,
      });

      const first = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });
      const second = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect((first.error as { kind?: string }).kind).toBe("model_load_failed");
        expect(first.error.message).toMatch(/incomplete|truncated|too small|size/i);
      }
      // Fail-closed: the bad load is NOT memoized — pipeline() is retried.
      expect(second.ok).toBe(false);
      expect(fake.pipelineSpy).toHaveBeenCalledTimes(2);
      expect(statModelCache).toHaveBeenCalled();
    });

    it("proceeds normally when the size-floor reports a plausible model size", async () => {
      const fake = makeFakeEngine({ transcribeText: "ok" });
      const statModelCache = vi.fn(async () => 50 * 1024 * 1024); // 50 MB — plausible
      const adapter = createLocalWhisperAdapter({
        dataDir: DATA_DIR,
        loadEngine: async () => fake.mod,
        decodeToPcm16kF32: async () => pcmOk(),
        statModelCache,
      });

      const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.text).toBe("ok");
    });

    it("proceeds (no false corruption) when the size-floor seam reports unknown size — the default production behavior", async () => {
      // The default statModelCache returns undefined (the transformers.js etag
      // cache layout is NOT a documented contract, so production does not guess a
      // path) → the size-floor is a no-op and the load proceeds on the pinned-id
      // + fail-closed + TLS triad. An undefined size must NEVER be a corruption.
      const fake = makeFakeEngine({ transcribeText: "ok" });
      const statModelCache = vi.fn(async () => undefined);
      const adapter = createLocalWhisperAdapter({
        dataDir: DATA_DIR,
        loadEngine: async () => fake.mod,
        decodeToPcm16kF32: async () => pcmOk(),
        statModelCache,
      });

      const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

      expect(result.ok).toBe(true);
    });
  });
});

describe("createLocalWhisperAdapter — default seams (real lazy-import + ffmpeg decode)", () => {
  beforeEach(() => {
    __resetLocalWhisperPipelineForTests();
    seam.ffmpeg = "ok";
    seam.pcmBytes = 16;
  });

  it("uses the default lazy-import loadEngine when none is injected, transcribing via the mocked engine", async () => {
    // No `loadEngine` seam → exercises defaultLoadEngine (the guarded lazy
    // `import("@huggingface/transformers")`, mocked above). Decode is injected.
    const adapter = createLocalWhisperAdapter({
      dataDir: DATA_DIR,
      decodeToPcm16kF32: async () => ok(new Float32Array([0.1, 0.2, 0.3])),
    });

    const result = await adapter.transcribe(Buffer.from("audio"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("default-engine transcript");
    }
  });

  it("uses the default ffmpeg decodeToPcm16kF32 when none is injected, decoding to f32 PCM samples", async () => {
    // No `decodeToPcm16kF32` seam → exercises defaultDecodeToPcm16kF32 (the
    // ffmpeg `execFile` shell + PCM read, mocked above to succeed). Engine injected.
    const fake = makeFakeEngine({ transcribeText: "decoded ok" });
    const adapter = createLocalWhisperAdapter({ dataDir: DATA_DIR, loadEngine: async () => fake.mod });

    const result = await adapter.transcribe(Buffer.from("audio-bytes"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("decoded ok");
    }
  });

  it("default ffmpeg decode returns err (never throws) when the ffmpeg shell fails", async () => {
    seam.ffmpeg = "fail";
    const fake = makeFakeEngine({ transcribeText: "unused" });
    const adapter = createLocalWhisperAdapter({ dataDir: DATA_DIR, loadEngine: async () => fake.mod });

    const result = await adapter.transcribe(Buffer.from("audio-bytes"), { mimeType: "audio/ogg" });

    expect(result.ok).toBe(false);
  });
});
