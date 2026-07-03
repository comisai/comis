// SPDX-License-Identifier: Apache-2.0
/**
 * Google (Gemini) Images transport.
 *
 * A pi-ai `ImagesApiFunction` over the `@google/genai` SDK. It is registered
 * into pi-ai's module-level IMAGES registry under the `google-images` api
 * (via `registerComisImageProviders()`) and dispatched through the ONE
 * `generateImages()` call site.
 *
 * Call shape (VERIFIED against `@google/genai@1.52.0`):
 *   `ai.models.generateContent({ model, contents, config: { responseModalities:
 *   [Modality.IMAGE] } })` where `contents` is a `Part[]` built from the
 *   `ImagesContext.input` (a `{text}` part per text input + a
 *   `{inlineData:{data,mimeType}}` part per IMAGE reference). The image
 *   returns in `candidates[0].content.parts[].inlineData.{data(base64),mimeType}`.
 *
 * `gemini-2.5-flash-image` is a Gemini MULTIMODAL model -> `generateContent`,
 * NOT `models.generateImages` (that is the Imagen `imagen-*` path and would 404
 * the gemini id). The image part is found by scanning ALL parts for the first
 * `inlineData.data` (it is not guaranteed to be at index 0).
 *
 * Never-throw discipline (mirrors `codex-images-transport.ts`): EVERY miss (no
 * key, SDK throw, blocked, no image) returns `AssistantImages{
 * stopReason:"error", errorMessage }` so the SHIPPED `classifyImageError`
 * (`pi-image-adapter.ts`) maps it. So this file needs NO `@allow-throw` header.
 *
 * SEC: the api key rides `options.apiKey` -> the SDK client only; it
 * is never interpolated or logged. This transport logs NOTHING (logging happens
 * in the reused `toImageGenOutput`). The catch surfaces the raw SDK message
 * ONLY on the result's `errorMessage` for classification — never to a logger.
 *
 * @module
 */
import { GoogleGenAI, Modality } from "@google/genai";
import { type AssistantImages, type ImagesApiFunction, type ImagesModel } from "@earendil-works/pi-ai";
// systemNowMs is the globals-gate-sanctioned wall-clock read — NOT Date.now().
import { systemNowMs } from "@comis/core";

/**
 * Hand-built `ImagesModel` for the Gemini image path (pi-ai's image
 * catalog is openrouter-only, so no catalog entry exists for it). The 8 fields
 * tsc requires for `ImagesModel<TApi>`
 * are `id,name,api,provider,baseUrl,input,output,cost`. The id defaults to
 * `gemini-2.5-flash-image` (the stable id; VERIFIED in the `@google/genai@1.52.0`
 * `Model_2` union) and is overridable by config/tool. `cost: 0` is a
 * placeholder until a real cost mapping exists.
 */
export const GOOGLE_IMAGE_MODEL: ImagesModel<"google-images"> = {
  id: "gemini-2.5-flash-image",
  name: "Google Gemini Image (gemini-2.5-flash-image)",
  api: "google-images",
  provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com",
  input: ["text", "image"],
  output: ["image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // placeholder — no real cost mapping yet
};

/** A Gemini `Part` carrying either text or an inline (base64) image. */
type GeminiPart = { text: string } | { inlineData: { data: string; mimeType: string } };

/**
 * The `google-images` transport.
 *
 * Reads the api key from `options.apiKey`, constructs a `GoogleGenAI` client per
 * call, and calls `models.generateContent` with `responseModalities:[IMAGE]`.
 * NEVER throws out — every failure -> an `AssistantImages{ stopReason:"error" }`
 * the shipped classifier maps.
 */
export const generateImagesGoogle: ImagesApiFunction = async (model, context, options) => {
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
    out.errorMessage = "No API key for provider: google";
    return out;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: options.apiKey });
    // Build the contents Part[] from the input: a text part per text input, an
    // inlineData part per IMAGE reference, preserving order.
    const parts: GeminiPart[] = [];
    for (const c of context.input) {
      if (c.type === "text") parts.push({ text: c.text });
      else if (c.type === "image") parts.push({ inlineData: { data: c.data, mimeType: c.mimeType } });
    }
    const r = await ai.models.generateContent({
      model: model.id,
      contents: parts,
      config: { responseModalities: [Modality.IMAGE] },
    });
    // Scan ALL parts for the first inline image (not guaranteed at index 0).
    const img = (r.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    const b64 = img?.inlineData?.data;
    if (!b64) {
      out.stopReason = "error";
      // A blocked prompt populates promptFeedback with no candidates; otherwise
      // the model replied without an image. Both -> a classifiable errorMessage.
      out.errorMessage = r.promptFeedback ? "content blocked" : "Gemini returned no image";
      return out;
    }
    out.output.push({ type: "image", data: b64, mimeType: img?.inlineData?.mimeType ?? "image/png" });
    return out;
  } catch (e) {
    // NEVER throw out — the shipped classifyImageError maps the errorMessage
    // substring. The raw SDK message is surfaced for classification only.
    out.stopReason = "error";
    out.errorMessage = e instanceof Error ? e.message : String(e);
    return out;
  }
};
