// SPDX-License-Identifier: Apache-2.0
/**
 * `observedModelId` tests — the model id recorded for a live turn's
 * observability must reflect the model ACTUALLY in use, never pi-coding-agent's
 * silent default-model fallback when the configured model is unregistered.
 *
 * Live incident (v2.28, 260621): a local daemon with `provider: ollama` +
 * `model: qwen3.6:35b` (a custom model not in pi's `ModelRegistry`) recorded
 * EVERY `comis_tokens_total` / `comis_cost_usd_total` row as
 * `model="gemini-3.1-pro-preview"` — pi's default fallback object — instead of
 * `qwen3.6:35b`. `obs_token_usage` carried the same `provider=ollama` +
 * `model=gemini` chimera.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { observedModelId } from "./observed-model-id.js";

describe("observedModelId", () => {
  it("records the CONFIGURED model when the model did not resolve (pi fell back to its default)", () => {
    // The live bug: unregistered Ollama model. resolvedModel is undefined (Comis
    // could not resolve it); pi's session.model.id is its default fallback
    // (gemini-*). The recorded id must be the configured model actually sent to
    // the provider API, NOT pi's fallback object.
    expect(
      observedModelId(undefined, "gemini-3.1-pro-preview", "qwen3.6:35b"),
    ).toBe("qwen3.6:35b");
  });

  it("uses the live session id when the model DID resolve (reflects an in-session setModel switch)", () => {
    // When Comis resolved the model, session.model.id is authoritative and
    // tracks in-session switches / retry fallbacks — prefer it over config.
    expect(
      observedModelId({ id: "claude-opus-4-8" }, "claude-haiku-4-5", "claude-opus-4-8"),
    ).toBe("claude-haiku-4-5");
  });

  it("falls back to the resolved id when the session has no live model yet", () => {
    expect(
      observedModelId({ id: "claude-opus-4-8" }, undefined, "claude-opus-4-8"),
    ).toBe("claude-opus-4-8");
  });
});
