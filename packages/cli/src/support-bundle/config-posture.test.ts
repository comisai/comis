// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the config-posture membership digest.
 *
 * The load-bearing property: `buildConfigPosture` emits ONLY top-level config
 * section NAMES present in the raw config file — each a member of the fixed
 * AppConfigSchema universe — plus the system `config_posture` finding's closed
 * labels and COUNT. No config VALUE can enter the function: its only config
 * input is a list of key NAMES, so the digest is content-free by construction.
 *
 * These goldens pin that membership is a set-membership check (never a config
 * dump), that an unknown or mistyped key is dropped (output is a subset of the
 * universe, so a typo cannot leak), and that the system finding is plucked
 * verbatim or null when it is absent.
 */

import { describe, it, expect } from "vitest";
import { buildConfigPosture } from "./config-posture.js";
import { parseConfigPosture } from "./types.js";

/** A system finding element — mirrors the SystemHealthReport `findings[]` shape. */
type SystemFinding = { code: string; detail: string; count: number; hint: string };

/**
 * The config_posture finding as it renders on a system report: closed name+state
 * labels and a stranded-secret COUNT only — verified content-free, never a
 * secret value.
 */
const CONFIG_POSTURE_FINDING: SystemFinding = {
  code: "config_posture",
  detail:
    "2 config-posture signal(s) (insecure or drifted config) — flagged: gateway.tls (off), stranded secrets (2)",
  count: 2,
  hint: "reconcile the flagged config knobs",
};

describe("buildConfigPosture membership", () => {
  it("emits only the top-level section names the raw config actually wrote", () => {
    const digest = buildConfigPosture(["gateway", "channels", "embedding"], []);
    // Set-equality: the emitted order follows the fixed universe; membership is
    // what matters. NOT all 42 defaulted sections — only what the user wrote.
    expect(new Set(digest.sections)).toEqual(new Set(["gateway", "channels", "embedding"]));
    expect(digest.sections.length).toBe(3);
    expect(digest.schemaVersion).toBe(1);
  });

  it("drops an unknown or mistyped key so the output is a subset of the schema universe", () => {
    const digest = buildConfigPosture(["gateway", "bogusTypoKey", "channels"], []);
    expect(new Set(digest.sections)).toEqual(new Set(["gateway", "channels"]));
    expect(digest.sections).not.toContain("bogusTypoKey");
  });

  it("returns empty sections and a null posture finding for an empty raw config", () => {
    const digest = buildConfigPosture([], []);
    expect(digest.sections).toEqual([]);
    expect(digest.configPosture).toBeNull();
  });

  it("carries only section names even when those sections hold secret values", () => {
    // The signature admits NAMES only, so a secret-bearing section contributes
    // just its NAME — a config value cannot structurally enter the function.
    const secretBearingSections = ["security", "providers", "gateway"];
    const digest = buildConfigPosture(secretBearingSections, []);
    expect(new Set(digest.sections)).toEqual(new Set(secretBearingSections));
    for (const section of digest.sections) {
      expect(secretBearingSections).toContain(section);
    }
  });
});

describe("buildConfigPosture system finding pluck", () => {
  it("copies the config_posture finding detail, count, and hint verbatim", () => {
    const digest = buildConfigPosture(["gateway"], [CONFIG_POSTURE_FINDING]);
    expect(digest.configPosture).toEqual({
      detail: CONFIG_POSTURE_FINDING.detail,
      count: 2,
      hint: CONFIG_POSTURE_FINDING.hint,
    });
    // The label is a closed name+state token and the COUNT is a number — the
    // stranded-secret count never carries the secret values themselves.
    expect(digest.configPosture?.detail).toContain("gateway.tls (off)");
    expect(digest.configPosture?.detail).toContain("stranded secrets (2)");
  });

  it("returns a null posture when no config_posture finding is present in the system set", () => {
    const digest = buildConfigPosture(
      ["gateway"],
      [{ code: "model_health", detail: "an unrelated finding", count: 1, hint: "unrelated hint" }],
    );
    expect(digest.configPosture).toBeNull();
  });
});

describe("buildConfigPosture output contract", () => {
  it("emits a digest that round-trips through parseConfigPosture", () => {
    const digest = buildConfigPosture(["gateway", "channels"], [CONFIG_POSTURE_FINDING]);
    const parsed = parseConfigPosture(digest);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.schemaVersion).toBe(1);
      expect(new Set(parsed.value.sections)).toEqual(new Set(["gateway", "channels"]));
      expect(parsed.value.configPosture?.count).toBe(2);
    }
  });
});
