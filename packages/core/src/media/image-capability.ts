// SPDX-License-Identifier: Apache-2.0
/**
 * IMAGE_CAPABILITY — the single source of truth for "which resolved main
 * provider can generate images, via which pi-ai images API, and with what
 * default image model".
 *
 * TWO VOCABULARIES (do not conflate):
 *   - The config selection enum (`integrations.media.imageGeneration.provider`)
 *     is what an OPERATOR may configure: "auto" | "fal" | "openai" |
 *     "openai-codex" | "google" | "openrouter". `auto` is a selection MODE (it
 *     triggers the follow-main lookup), and `fal` is an explicit-only
 *     backend routed through its own dedicated adapter (it has no main-provider
 *     equivalent and is NOT a follow-main capability).
 *   - The keys of THIS map are RESOLVED main-provider ids only — the concrete
 *     provider the completion path resolves an agent to. A provider absent from
 *     this map is image-incapable: the lookup returns `undefined`, which the
 *     resolver turns into an honest "unsupported_provider" (never a silent
 *     fall-through to a different paid provider). So `auto` and `fal` MUST NOT
 *     appear as keys here.
 *
 * Mirrors the const-map shape of `PROVIDER_OVERRIDES`
 * (packages/agent/src/provider/capabilities.ts) — keyed by canonical provider
 * id, providers not in the map fall through to `undefined`.
 *
 * Model-id provenance: the `openrouter` / `black-forest-labs/flux.2-pro` entry
 * is verified in the installed pi-ai 0.79.3 catalog and is exercised
 * end-to-end. The `gpt-image-1` (openai / openai-codex) and
 * `gemini-2.5-flash-image` (google / google-vertex) default ids are verified
 * too: `gpt-image-1` is a member of the installed `openai@6.39.1` `ImageModel`
 * union (images.d.ts:310) and `gemini-2.5-flash-image` is a member of the
 * installed `@google/genai@1.52.0` `Model_2` union (genai.d.ts:8082). Both
 * remain overridable by config/tool model.
 *
 * @module
 */

export const IMAGE_CAPABILITY: Record<
  string,
  { imagesApi: string; defaultModel: string } | undefined
> = {
  "openai-codex": { imagesApi: "openai-codex-images", defaultModel: "gpt-image-1" },
  "openai": { imagesApi: "openai-images", defaultModel: "gpt-image-1" },
  "google": { imagesApi: "google-images", defaultModel: "gemini-2.5-flash-image" },
  "google-vertex": { imagesApi: "google-images", defaultModel: "gemini-2.5-flash-image" },
  "openrouter": { imagesApi: "openrouter-images", defaultModel: "black-forest-labs/flux.2-pro" },
  // anthropic / amazon-bedrock / groq / mistral / deepseek / default → undefined (image-incapable).
};
