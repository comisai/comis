// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI Images transport (PRV-01).
 *
 * A pi-ai `ImagesApiFunction` over the `openai` SDK. It is registered into
 * pi-ai's module-level IMAGES registry under the `openai-images` api
 * (`registerComisImageProviders()` — Plan 04's PI-02 seam, extended in this
 * phase) and dispatched through the ONE `generateImages()` call site.
 *
 * Call shape (RESEARCH CRITICAL #3, VERIFIED against `openai@6.39.1`):
 *   - text->image: `images.generate({ model, prompt, n, size })`
 *   - reference->image (IN-01): `images.edit({ image, prompt, model, n, size })`,
 *     where `image` is the reference wrapped via `toFile(buffer, name, {type})`.
 * GPT image models ALWAYS return base64 in `data[].b64_json` — `response_format`
 * is dall-e-only and is NEVER set here (it errors gpt-image-1).
 *
 * The transport decides generate-vs-edit by whether `context.input` carries an
 * `ImageContent` element (the reference image). Today the handler only ever
 * supplies a text-only context (the IN-01 reference plumbing lands in a later
 * plan), but the edit branch is written and tested here because it is part of
 * the transport's SDK contract.
 *
 * Never-throw discipline (mirrors `codex-images-transport.ts`): EVERY miss (no
 * key, SDK throw, empty data) returns `AssistantImages{ stopReason:"error",
 * errorMessage }` so the SHIPPED `classifyImageError` (`pi-image-adapter.ts`)
 * maps the `errorMessage` substring (`401|403|auth` -> auth_required,
 * content/quota -> content_blocked/quota_exceeded, else -> empty_response). So
 * this file needs NO `@allow-throw` header.
 *
 * SEC (T-185-01): the api key rides `options.apiKey` -> the SDK client only; it
 * is never interpolated or logged. This transport logs NOTHING (logging happens
 * in the reused `toImageGenOutput`, which carries only {errorKind, imageErrorKind,
 * hint}). The catch surfaces the raw SDK message ONLY on the result's
 * `errorMessage` for classification — never to a logger here.
 *
 * @module
 */
import OpenAI, { toFile } from "openai";
import { type AssistantImages, type ImagesApiFunction, type ImagesModel } from "@earendil-works/pi-ai";
// systemNowMs is the globals-gate-sanctioned wall-clock read — NOT Date.now(),
// which the production globals gate forbids (mirror codex-images-transport.ts).
import { systemNowMs } from "@comis/core";

/**
 * Hand-built `ImagesModel` for the OpenAI Images path (Pitfall 4 — pi-ai's image
 * catalog is openrouter-only, so `getImageModel("openai", …)` has no entry). The
 * 8 fields tsc requires for `ImagesModel<TApi>` are
 * `id,name,api,provider,baseUrl,input,output,cost` (it Omits
 * reasoning/contextWindow/maxTokens/compat). The id defaults to `gpt-image-1`
 * (the folded skills adapter's default; VERIFIED in the `openai@6.39.1`
 * `ImageModel` union) and is overridable by config/tool. `cost: 0` is the
 * Phase-186 placeholder.
 */
export const OPENAI_IMAGE_MODEL: ImagesModel<"openai-images"> = {
  id: "gpt-image-1",
  name: "OpenAI Image (gpt-image-1)",
  api: "openai-images",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  input: ["text", "image"],
  output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // 186: real cost mapping (OBS-03)
};

/**
 * The `openai-images` transport (PRV-01).
 *
 * Reads the api key from `options.apiKey`, constructs an `openai` client per
 * call, and calls `images.generate` (text-only) or `images.edit` (when an
 * `ImageContent` reference is present). NEVER throws out — every failure -> an
 * `AssistantImages{ stopReason:"error" }` the shipped classifier maps.
 */
export const generateImagesOpenAI: ImagesApiFunction = async (model, context, options) => {
  const out: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: systemNowMs(),
  };

  if (!options?.apiKey) {
    // No SDK call issued. The message lets the shipped classifier map it
    // (-> auth_required). Never log the (absent) key.
    out.stopReason = "error";
    out.errorMessage = "No API key for provider: openai";
    return out;
  }

  try {
    const client = new OpenAI({ apiKey: options.apiKey });
    const prompt = context.input
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const ref = context.input.find(
      (c): c is { type: "image"; data: string; mimeType: string } => c.type === "image",
    );
    // generate vs edit (IN-01) keyed on the presence of a reference image.
    // DO NOT set response_format — GPT image models always return base64.
    const resp = ref
      ? await client.images.edit({
          image: await toFile(Buffer.from(ref.data, "base64"), "ref.png", { type: ref.mimeType }),
          prompt,
          model: model.id,
          n: 1,
          size: "1024x1024",
        })
      : await client.images.generate({
          model: model.id,
          prompt,
          n: 1,
          size: "1024x1024",
        });
    const b64 = resp.data?.[0]?.b64_json;
    if (!b64) {
      out.stopReason = "error";
      out.errorMessage = "OpenAI returned no image data";
      return out;
    }
    out.output.push({ type: "image", data: b64, mimeType: "image/png" });
    return out;
  } catch (e) {
    // NEVER throw out — the shipped classifyImageError maps the errorMessage
    // substring. The raw SDK message is surfaced for classification only (never
    // logged here).
    out.stopReason = "error";
    out.errorMessage = e instanceof Error ? e.message : String(e);
    return out;
  }
};
