// SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible API types and route handlers

export {
  ChatCompletionRequestSchema,
  ChatMessageSchema,
  StreamOptionsSchema,
  createOpenAIError,
  mapFinishReason,
} from "./openai-types.js";

export type {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionChunk,
  OpenAIErrorResponse,
} from "./openai-types.js";

export { createOpenaiCompletionsRoute } from "./openai-completions.js";
export type { OpenaiCompletionsDeps } from "./openai-completions.js";

export { createOpenaiModelsRoute } from "./openai-models.js";
export type { OpenaiModelsDeps, ModelsCatalogEntry } from "./openai-models.js";

export {
  createOpenaiEmbeddingsRoute,
  EmbeddingsRequestSchema,
} from "./openai-embeddings.js";
export type {
  OpenaiEmbeddingsDeps,
  EmbeddingsPort,
  EmbeddingsRequest,
} from "./openai-embeddings.js";
