// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the voice-response pipeline wiring.
 *
 * `buildVoiceResponsePipeline` is the seam that turns TTS config plus optional
 * media adapters into the shape `@comis/channels` consumes. Everything it does
 * is a mapping decision — provider to format key, keyless classification,
 * absent adapter to a working no-op — so a silent mistake here surfaces only as
 * voice output that never plays, or a keyed provider treated as keyless.
 */

import { describe, it, expect, vi } from "vitest";
import type { AppContainer, TTSPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

// Only the two helpers the SUT reads at module load. Mocked so the assertions
// pin the wiring rather than the real format-resolution tables.
const mockShouldAutoTts = vi.fn();
const mockResolveOutputFormat = vi.fn();
vi.mock("@comis/skills", () => ({
  shouldAutoTts: mockShouldAutoTts,
  resolveOutputFormat: mockResolveOutputFormat,
}));

const { buildVoiceResponsePipeline } = await import("./setup-channels-voice-response.js");

type TtsConfig = AppContainer["config"]["integrations"]["media"]["tts"];

function makeConfig(tts: Partial<TtsConfig> = {}): AppContainer["config"] {
  return {
    integrations: {
      media: {
        tts: {
          provider: "openai",
          autoMode: "tagged",
          tagPattern: "\\[voice\\]",
          voice: "alloy",
          maxTextLength: 4096,
          outputFormats: { openai: "opus", elevenlabs: "mp3", edge: "mp3" },
          ...tts,
        },
      },
    },
  } as unknown as AppContainer["config"];
}

function makeLogger(): ComisLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ComisLogger;
}

const ttsAdapter = { synthesize: vi.fn() } as unknown as TTSPort;

describe("buildVoiceResponsePipeline", () => {
  it("returns undefined when no TTS adapter is wired so callers skip voice entirely", () => {
    expect(buildVoiceResponsePipeline(makeConfig(), {}, makeLogger())).toBeUndefined();
  });

  it("maps each supported provider onto its own output-format key", () => {
    const keyFor = (provider: string): string | undefined =>
      buildVoiceResponsePipeline(makeConfig({ provider } as Partial<TtsConfig>), { ttsAdapter }, makeLogger())
        ?.ttsConfig.providerFormatKey;

    expect(keyFor("elevenlabs")).toBe("elevenlabs");
    expect(keyFor("edge")).toBe("edge");
    expect(keyFor("openai")).toBe("openai");
  });

  it("routes an unrecognized provider to the openai format key rather than leaving it unset", () => {
    // The format key indexes `outputFormats`; an undefined key would resolve no
    // format at all, so the fallback must be a real key.
    const pipeline = buildVoiceResponsePipeline(
      makeConfig({ provider: "local" } as Partial<TtsConfig>),
      { ttsAdapter },
      makeLogger(),
    );
    expect(pipeline?.ttsConfig.providerFormatKey).toBe("openai");
  });

  it("classifies only the credential-free providers as keyless", () => {
    const keylessFor = (provider: string): boolean | undefined =>
      buildVoiceResponsePipeline(makeConfig({ provider } as Partial<TtsConfig>), { ttsAdapter }, makeLogger())
        ?.ttsConfig.keyless;

    expect(keylessFor("edge")).toBe(true);
    expect(keylessFor("local")).toBe(true);
    expect(keylessFor("openai")).toBe(false);
    expect(keylessFor("elevenlabs")).toBe(false);
  });

  it("omits the model key entirely when no model is configured", () => {
    const pipeline = buildVoiceResponsePipeline(makeConfig(), { ttsAdapter }, makeLogger());
    expect("model" in pipeline!.ttsConfig).toBe(false);

    const withModel = buildVoiceResponsePipeline(
      makeConfig({ model: "tts-1-hd" } as Partial<TtsConfig>),
      { ttsAdapter },
      makeLogger(),
    );
    expect(withModel?.ttsConfig.model).toBe("tts-1-hd");
  });

  it("substitutes a no-op managed dir when no media temp manager is provided", () => {
    const pipeline = buildVoiceResponsePipeline(makeConfig(), { ttsAdapter }, makeLogger());
    expect(pipeline?.mediaTempManager.getManagedDir()).toBeUndefined();
  });

  it("delegates the managed dir to the media temp manager when one is provided", () => {
    const mediaTempManager = { getManagedDir: vi.fn(() => "/tmp/managed") };
    const pipeline = buildVoiceResponsePipeline(
      makeConfig(),
      { ttsAdapter, mediaTempManager: mediaTempManager as never },
      makeLogger(),
    );
    expect(pipeline?.mediaTempManager.getManagedDir()).toBe("/tmp/managed");
    expect(mediaTempManager.getManagedDir).toHaveBeenCalledTimes(1);
  });

  it("still runs the work when no media semaphore is provided", async () => {
    const pipeline = buildVoiceResponsePipeline(makeConfig(), { ttsAdapter }, makeLogger());
    // A dropped fn here would silently produce no audio, so the fallback must
    // invoke it rather than resolve empty.
    await expect(pipeline!.mediaSemaphore.run(async () => "synthesized")).resolves.toBe("synthesized");
  });

  it("routes the work through the media semaphore when one is provided", async () => {
    const mediaSemaphore = { run: vi.fn(async <T>(fn: () => Promise<T>) => fn()) };
    const pipeline = buildVoiceResponsePipeline(
      makeConfig(),
      { ttsAdapter, mediaSemaphore: mediaSemaphore as never },
      makeLogger(),
    );
    await expect(pipeline!.mediaSemaphore.run(async () => "gated")).resolves.toBe("gated");
    expect(mediaSemaphore.run).toHaveBeenCalledTimes(1);
  });

  it("carries the configured TTS values and the adapter onto the pipeline", () => {
    const pipeline = buildVoiceResponsePipeline(
      makeConfig({ voice: "nova", maxTextLength: 1234 } as Partial<TtsConfig>),
      { ttsAdapter },
      makeLogger(),
    );
    expect(pipeline?.ttsAdapter).toBe(ttsAdapter);
    expect(pipeline?.ttsConfig.voice).toBe("nova");
    expect(pipeline?.ttsConfig.maxTextLength).toBe(1234);
    expect(pipeline?.shouldAutoTts).toBe(mockShouldAutoTts);
  });
});
