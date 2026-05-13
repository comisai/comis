// SPDX-License-Identifier: Apache-2.0
/**
 * Provider interface retrofit compatibility tests.
 *
 * Verifies that existing provider ports (TTSPort, TranscriptionPort,
 * EmbeddingPort, ImageAnalysisPort) can be wrapped to satisfy the
 * unified Provider<TInput, TOutput> interface from @comis/core.
 *
 * These wrappers are test-only for now -- production use deferred
 * until a consumer needs them.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { Result } from "@comis/shared";
import type {
  Provider,
  TTSPort,
  TTSResult,
  TranscriptionPort,
  TranscriptionResult,
  EmbeddingPort,
  ImageAnalysisPort,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Wrapper functions -- adapt existing ports to Provider<TInput, TOutput>
// ---------------------------------------------------------------------------

function wrapTTSAsProvider(
  tts: TTSPort,
): Provider<{ text: string; voice?: string }, TTSResult> {
  return {
    id: "tts",
    isAvailable: () => true,
    async execute(input): Promise<Result<TTSResult, Error>> {
      return tts.synthesize(input.text, { voice: input.voice });
    },
  };
}

function wrapSTTAsProvider(
  stt: TranscriptionPort,
): Provider<{ audio: Buffer; mimeType: string; language?: string }, TranscriptionResult> {
  return {
    id: "stt",
    isAvailable: () => true,
    async execute(input): Promise<Result<TranscriptionResult, Error>> {
      return stt.transcribe(input.audio, {
        mimeType: input.mimeType,
        language: input.language,
      });
    },
  };
}

function wrapEmbeddingAsProvider(
  emb: EmbeddingPort,
): Provider<{ text: string }, number[]> {
  return {
    id: "embedding",
    isAvailable: () => true,
    async execute(input): Promise<Result<number[], Error>> {
      return emb.embed(input.text);
    },
  };
}

function wrapVisionAsProvider(
  vision: ImageAnalysisPort,
): Provider<{ imageBuffer: Buffer; prompt: string; mimeType: string }, string> {
  return {
    id: "vision",
    isAvailable: () => true,
    async execute(input): Promise<Result<string, Error>> {
      return vision.analyze(input.imageBuffer, input.prompt, {
        mimeType: input.mimeType,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Provider interface retrofit", () => {
  describe("TTSPort wrapper", () => {
    it("satisfies Provider interface and delegates to synthesize()", async () => {
      const mockTTS: TTSPort = {
        synthesize: vi.fn().mockResolvedValue(
          ok({ audio: Buffer.from("audio-data"), mimeType: "audio/mpeg" }),
        ),
      };

      const provider = wrapTTSAsProvider(mockTTS);

      expect(provider.id).toBe("tts");
      expect(provider.isAvailable()).toBe(true);

      const result = await provider.execute({ text: "Hello world", voice: "alloy" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.audio).toEqual(Buffer.from("audio-data"));
        expect(result.value.mimeType).toBe("audio/mpeg");
      }

      expect(mockTTS.synthesize).toHaveBeenCalledWith("Hello world", { voice: "alloy" });
    });
  });

  describe("TranscriptionPort wrapper", () => {
    it("satisfies Provider interface and delegates to transcribe()", async () => {
      const mockSTT: TranscriptionPort = {
        transcribe: vi.fn().mockResolvedValue(
          ok({ text: "transcribed text", language: "en" }),
        ),
      };

      const provider = wrapSTTAsProvider(mockSTT);

      expect(provider.id).toBe("stt");
      expect(provider.isAvailable()).toBe(true);

      const audioBuf = Buffer.from("audio-bytes");
      const result = await provider.execute({
        audio: audioBuf,
        mimeType: "audio/ogg",
        language: "en",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.text).toBe("transcribed text");
      }

      expect(mockSTT.transcribe).toHaveBeenCalledWith(audioBuf, {
        mimeType: "audio/ogg",
        language: "en",
      });
    });
  });

  describe("EmbeddingPort wrapper", () => {
    it("satisfies Provider interface and delegates to embed()", async () => {
      const mockEmbedding: Pick<EmbeddingPort, "embed"> = {
        embed: vi.fn().mockResolvedValue(ok([0.1, 0.2, 0.3])),
      };

      const provider = wrapEmbeddingAsProvider(mockEmbedding as EmbeddingPort);

      expect(provider.id).toBe("embedding");
      expect(provider.isAvailable()).toBe(true);

      const result = await provider.execute({ text: "test embedding" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([0.1, 0.2, 0.3]);
      }

      expect(mockEmbedding.embed).toHaveBeenCalledWith("test embedding");
    });
  });

  describe("ImageAnalysisPort wrapper", () => {
    it("satisfies Provider interface and delegates to analyze()", async () => {
      const mockVision: ImageAnalysisPort = {
        analyze: vi.fn().mockResolvedValue(ok("A cat sitting on a mat")),
      };

      const provider = wrapVisionAsProvider(mockVision);

      expect(provider.id).toBe("vision");
      expect(provider.isAvailable()).toBe(true);

      const imageBuf = Buffer.from("image-bytes");
      const result = await provider.execute({
        imageBuffer: imageBuf,
        prompt: "Describe this image",
        mimeType: "image/png",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("A cat sitting on a mat");
      }

      expect(mockVision.analyze).toHaveBeenCalledWith(
        imageBuf,
        "Describe this image",
        { mimeType: "image/png" },
      );
    });
  });
});
