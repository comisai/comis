// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for store-flag.ts predicates.
 *
 * `usesResponsesInputApi` gates the recall-defer prefix stabilizer across ALL
 * OpenAI Responses-family providers — native openai (`openai-responses`), Azure
 * (`azure-openai-responses`), and codex (`openai-codex-responses`/`provider:"openai-codex"`).
 * The bug it prevents: gating the defer on `provider === "openai-codex"` alone leaves the
 * native `openai` provider (gpt-5.5 → api `openai-responses`) with the defer OFF, so the
 * per-turn inline-recall poisons the auto-cached prefix (5 floor-collapses observed live).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { isResponsesApiProvider, usesResponsesInputApi } from "./store-flag.js";

describe("isResponsesApiProvider (service_tier/store injection scope)", () => {
  it("is true for native openai-responses and azure-openai-responses only", () => {
    expect(isResponsesApiProvider({ api: "openai-responses" })).toBe(true);
    expect(isResponsesApiProvider({ api: "azure-openai-responses" })).toBe(true);
    // codex + completions are intentionally NOT in this (narrower) scope
    expect(isResponsesApiProvider({ api: "openai-codex-responses" })).toBe(false);
    expect(isResponsesApiProvider({ api: "openai-completions" })).toBe(false);
    expect(isResponsesApiProvider({})).toBe(false);
  });
});

describe("usesResponsesInputApi (recall-defer stabilizer scope)", () => {
  it("is true for native openai Responses API (the regression: gpt-5.5 -> openai-responses)", () => {
    expect(usesResponsesInputApi({ api: "openai-responses", provider: "openai" })).toBe(true);
  });

  it("is true for Azure Responses API", () => {
    expect(usesResponsesInputApi({ api: "azure-openai-responses", provider: "azure-openai-responses" })).toBe(true);
  });

  it("is true for codex by api AND by provider fallback (codex model.api is not openai-responses)", () => {
    expect(usesResponsesInputApi({ api: "openai-codex-responses" })).toBe(true);
    // provider fallback: even if codex's model.api is untagged/unexpected, the provider catches it
    expect(usesResponsesInputApi({ api: undefined, provider: "openai-codex" })).toBe(true);
    expect(usesResponsesInputApi({ provider: "openai-codex" })).toBe(true);
  });

  it("is false for non-Responses providers (anthropic, openai chat-completions, ollama)", () => {
    expect(usesResponsesInputApi({ api: "anthropic-messages", provider: "anthropic" })).toBe(false);
    expect(usesResponsesInputApi({ api: "openai-completions", provider: "openai" })).toBe(false);
    expect(usesResponsesInputApi({ api: "openai-completions", provider: "ollama" })).toBe(false);
    expect(usesResponsesInputApi({})).toBe(false);
  });

  it("is a strict superset of isResponsesApiProvider", () => {
    for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses", "openai-completions", "anthropic-messages"]) {
      if (isResponsesApiProvider({ api })) expect(usesResponsesInputApi({ api })).toBe(true);
    }
  });
});
