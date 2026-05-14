// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `gateway/src/openai/index.ts` public barrel.
 *
 * Asserts the public export surface matches the source-of-truth — catches
 * silent export deletion / shadowing. Phase 40 / Phase C §6.3.4 / COV-08.
 *
 * NOTE: Cohort 1 plan PATTERNS.md inventory listed 3 route factories, but the
 * live source-of-truth exports 6 values: 3 utilities/schemas from
 * `openai-types.ts` (`ChatCompletionRequestSchema`, `ChatMessageSchema`,
 * `StreamOptionsSchema`, `createOpenAIError`, `mapFinishReason`) plus the
 * 3 route factories (`createOpenaiCompletionsRoute`, `createOpenaiModelsRoute`,
 * `createOpenaiEmbeddingsRoute`) and `EmbeddingsRequestSchema`. Schemas are
 * Zod objects (`typeof === "object"`); factories and helpers are functions.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import * as openai from "./index.js";

describe("gateway/src/openai/index — barrel exports smoke contract", () => {
  it("exports createOpenaiCompletionsRoute as a function", () => {
    expect(typeof openai.createOpenaiCompletionsRoute).toBe("function");
  });

  it("exports createOpenaiModelsRoute as a function", () => {
    expect(typeof openai.createOpenaiModelsRoute).toBe("function");
  });

  it("exports createOpenaiEmbeddingsRoute as a function", () => {
    expect(typeof openai.createOpenaiEmbeddingsRoute).toBe("function");
  });

  it("exports createOpenAIError as a function", () => {
    expect(typeof openai.createOpenAIError).toBe("function");
  });

  it("exports mapFinishReason as a function", () => {
    expect(typeof openai.mapFinishReason).toBe("function");
  });

  it("exports ChatCompletionRequestSchema as a Zod object", () => {
    expect(typeof openai.ChatCompletionRequestSchema).toBe("object");
    expect(openai.ChatCompletionRequestSchema).not.toBeNull();
  });

  it("exports ChatMessageSchema as a Zod object", () => {
    expect(typeof openai.ChatMessageSchema).toBe("object");
    expect(openai.ChatMessageSchema).not.toBeNull();
  });

  it("exports StreamOptionsSchema as a Zod object", () => {
    expect(typeof openai.StreamOptionsSchema).toBe("object");
    expect(openai.StreamOptionsSchema).not.toBeNull();
  });

  it("exports EmbeddingsRequestSchema as a Zod object", () => {
    expect(typeof openai.EmbeddingsRequestSchema).toBe("object");
    expect(openai.EmbeddingsRequestSchema).not.toBeNull();
  });

  it("exports at least 9 named value exports (silent-deletion guard)", () => {
    expect(Object.keys(openai).length).toBeGreaterThanOrEqual(9);
  });
});
