// SPDX-License-Identifier: Apache-2.0
import type { ImageGenerationPort, ImageGenInput, ImageGenOutput } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";
import OpenAI from "openai";

/**
 * Create an OpenAI gpt-image-1 image generation adapter.
 *
 * @param opts - Configuration with API key and optional model override
 * @returns ImageGenerationPort implementation for OpenAI
 */
export function createOpenAIImageAdapter(opts: {
  apiKey: string;
  model?: string;
}): ImageGenerationPort {
  const openai = new OpenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? "gpt-image-1";

  return {
    id: "openai",
    isAvailable: () => true,

    execute(input: ImageGenInput): Promise<Result<ImageGenOutput, Error>> {
      return fromPromise(
        (async () => {
          const response = await openai.images.generate({
            model,
            prompt: input.prompt,
            n: 1,
            size: (input.size ?? "1024x1024") as "1024x1024",
          });

          const b64 = response.data?.[0]?.b64_json;
          if (!b64) {
            throw new Error("OpenAI returned no base64 image data");
          }

          const buffer = Buffer.from(b64, "base64");
          return { buffer, mimeType: "image/png" };
        })(),
      );
    },
  };
}
