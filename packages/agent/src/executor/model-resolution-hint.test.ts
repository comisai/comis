// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { diagnoseUnresolvedModel } from "./model-resolution-hint.js";
import { FAIL_CLOSED_PROFILE } from "./model-profile.js";

describe("diagnoseUnresolvedModel", () => {
  it("names the unknown model id + the provider's available ids when the provider IS registered", () => {
    // Config can name an unknown model on a registered provider with several
    // concrete model IDs available for remediation.
    // The old hint blamed provider registration and misdirected the operator to
    // providers.entries; the provider was fine — only the model id was wrong.
    const d = diagnoseUnresolvedModel("openai-codex", "gpt-5.6", [
      "gpt-5.6-terra",
      "gpt-5.4",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
    ]);
    expect(d.reason).toBe("model_id_unknown");
    // Names the exact bad id and the provider.
    expect(d.hint).toContain("gpt-5.6");
    expect(d.hint).toContain("openai-codex");
    // Lists every available id (so the operator sees the valid choices) …
    for (const id of ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.4"]) {
      expect(d.hint).toContain(id);
    }
    // … deterministically, sorted (stable message regardless of registry order).
    expect(d.hint.indexOf("gpt-5.4")).toBeLessThan(d.hint.indexOf("gpt-5.6-luna"));
    // Connects to the DOWNSTREAM symptom: the fail-closed nano profile that
    // exhausts context (what the operator actually hit, mis-hinted as "raise
    // effectiveContextCapNano / reset conversation").
    expect(d.hint).toMatch(/nano/i);
    expect(d.hint).toMatch(/context/i);
    expect(d.hint).toContain(String(FAIL_CLOSED_PROFILE.contextWindow));
    // Must NOT misdirect to provider registration in this class.
    expect(d.hint).not.toContain("providers.entries");
  });

  it("keeps the provider-registration hint when the provider has NO models at all", () => {
    const d = diagnoseUnresolvedModel("made-up-provider", "some-model", []);
    expect(d.reason).toBe("provider_unregistered");
    expect(d.hint).toContain("providers.entries");
  });

  it("is deterministic and does not mutate the caller's array", () => {
    const ids = ["z-model", "a-model"];
    const d1 = diagnoseUnresolvedModel("p", "x", ids);
    const d2 = diagnoseUnresolvedModel("p", "x", ["a-model", "z-model"]);
    expect(d1.hint).toBe(d2.hint);
    expect(ids).toEqual(["z-model", "a-model"]); // input order preserved
  });
});
