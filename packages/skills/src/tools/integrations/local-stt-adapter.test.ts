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
  type TransformersModule,
} from "./local-stt-adapter.js";

const DATA_DIR = "/tmp/test-data";

/**
 * Build a fake `@huggingface/transformers` module whose `pipeline()` behavior
 * is controlled per-test. `env` is a mutable object so the test can assert the
 * adapter sets `env.cacheDir` before the first `pipeline()` call.
 */
function makeFakeEngine(opts: {
  transcribeText?: string;
  pipelineRejects?: boolean;
}): {
  mod: TransformersModule;
  pipelineSpy: ReturnType<typeof vi.fn>;
  env: Record<string, unknown>;
} {
  const env: Record<string, unknown> = {};
  const transcriber = vi.fn(async () => ({ text: opts.transcribeText ?? "hello" }));
  const pipelineSpy = vi.fn(async () => {
    if (opts.pipelineRejects) {
      throw new Error("ONNX model load failed: short read");
    }
    return transcriber;
  });
  const mod = { env, pipeline: pipelineSpy } as unknown as TransformersModule;
  return { mod, pipelineSpy, env };
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
});
