import type { ImageGenerationPort, ImageGenInput, ImageGenOutput } from "@comis/core";
import type { Result } from "@comis/shared";
import { fromPromise } from "@comis/shared";
import { fal } from "@fal-ai/client";

/**
 * Create a fal.ai FLUX image generation adapter.
 *
 * @param opts - Configuration with API key and optional model override
 * @returns ImageGenerationPort implementation for fal.ai
 */
export function createFalAdapter(opts: {
  apiKey: string;
  model?: string;
}): ImageGenerationPort {
  fal.config({ credentials: opts.apiKey });

  const model = opts.model ?? "fal-ai/flux/dev";

  return {
    id: "fal",
    isAvailable: () => true,

    execute(input: ImageGenInput): Promise<Result<ImageGenOutput, Error>> {
      return fromPromise(
        (async () => {
          const result = await fal.subscribe(model, {
            input: {
              prompt: input.prompt,
              image_size: input.size ?? "square_hd",
              num_images: 1,
              enable_safety_checker: input.safetyChecker ?? true,
            },
          });

          const imageUrl = (result.data as { images: Array<{ url: string }> }).images[0]?.url;
          if (!imageUrl) {
            throw new Error("fal.ai returned no image URL");
          }

          const response = await fetch(imageUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch fal.ai image: ${response.status}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          return { buffer, mimeType: "image/png" };
        })(),
      );
    },
  };
}
