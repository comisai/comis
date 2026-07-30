// SPDX-License-Identifier: Apache-2.0
/** Voice-response pipeline construction for channel runtime wiring. */

import type { AppContainer, TTSPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { VoiceResponsePipelineDeps } from "@comis/channels";
import {
  resolveOutputFormat,
  shouldAutoTts,
  type AudioConverter,
  type MediaSemaphore,
  type MediaTempManager,
} from "@comis/skills";

interface VoiceResponseBuildDeps {
  ttsAdapter?: TTSPort;
  audioConverter?: AudioConverter;
  mediaTempManager?: MediaTempManager;
  mediaSemaphore?: MediaSemaphore;
}

export function buildVoiceResponsePipeline(
  config: AppContainer["config"],
  deps: VoiceResponseBuildDeps,
  logger: ComisLogger,
): VoiceResponsePipelineDeps | undefined {
  if (!deps.ttsAdapter) return undefined;

  const ttsConfig = config.integrations.media.tts;
  const providerFormatKey: "openai" | "elevenlabs" | "edge" =
    ttsConfig.provider === "elevenlabs" ? "elevenlabs"
    : ttsConfig.provider === "edge" ? "edge"
    : "openai";
  const mediaTempManager = deps.mediaTempManager;
  const mediaSemaphore = deps.mediaSemaphore;
  const pipeline: VoiceResponsePipelineDeps = {
    ttsAdapter: deps.ttsAdapter,
    audioConverter: deps.audioConverter,
    mediaTempManager: mediaTempManager
      ? { getManagedDir: () => mediaTempManager.getManagedDir() }
      : { getManagedDir: () => undefined },
    mediaSemaphore: mediaSemaphore
      ? { run: <T>(fn: () => Promise<T>) => mediaSemaphore.run(fn) }
      : { run: async <T>(fn: () => Promise<T>) => fn() },
    shouldAutoTts,
    resolveOutputFormat: resolveOutputFormat as VoiceResponsePipelineDeps["resolveOutputFormat"],
    ttsConfig: {
      autoMode: ttsConfig.autoMode,
      tagPattern: ttsConfig.tagPattern,
      voice: ttsConfig.voice,
      maxTextLength: ttsConfig.maxTextLength,
      outputFormats: ttsConfig.outputFormats,
      providerFormatKey,
      provider: ttsConfig.provider,
      keyless: ttsConfig.provider === "edge" || ttsConfig.provider === "local",
      ...(ttsConfig.model !== undefined ? { model: ttsConfig.model } : {}),
    },
    logger,
  };
  logger.debug(
    {
      autoMode: ttsConfig.autoMode,
      providerFormatKey,
      provider: ttsConfig.provider,
    },
    "Voice response pipeline wired",
  );
  return pipeline;
}
