// SPDX-License-Identifier: Apache-2.0
/**
 * WR-02 regression tests for buildPlaceholdersFromBindings.
 *
 * RED phase (test08-fix): the function does not yet emit a WARN when envVarName is
 * absent and secretRef is not env-var-shaped. These tests fail until the warn
 * is added.
 *
 * Behavior tested:
 *   - When envVarName is present: use it as the key (no warning)
 *   - When envVarName is absent and secretRef is env-var-shaped (ALL_CAPS_SNAKE):
 *     use secretRef as key, no warning
 *   - When envVarName is absent and secretRef is opaque (lowercase / kebab):
 *     use secretRef as key BUT emit WARN with hint
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { BrokerBindingConfig } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// Lazy import so module mocking is in place before import.
async function getBuilder() {
  const mod = await import("./broker-placeholder-builder.js");
  return mod.buildPlaceholdersFromBindings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBinding(secretRef: string, envVarName?: string): BrokerBindingConfig {
  // BrokerBindingConfig from @comis/core schema
  return {
    secretRef,
    ...(envVarName !== undefined && { envVarName }),
  } as BrokerBindingConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPlaceholdersFromBindings (WR-02)", () => {
  it("envVarName present → uses envVarName as placeholder key, no warning", async () => {
    const logger = createMockLogger();
    const buildPlaceholdersFromBindings = await getBuilder();

    const result = buildPlaceholdersFromBindings(
      { binding1: makeBinding("anthropic-prod-secret", "ANTHROPIC_API_KEY") },
      logger as any,
    );

    expect(result).toEqual({ ANTHROPIC_API_KEY: "comis-broker-placeholder" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("secretRef is env-var-shaped (ALL_CAPS) and envVarName absent → no warning", async () => {
    const logger = createMockLogger();
    const buildPlaceholdersFromBindings = await getBuilder();

    const result = buildPlaceholdersFromBindings(
      { binding1: makeBinding("ANTHROPIC_API_KEY") },
      logger as any,
    );

    expect(result).toEqual({ ANTHROPIC_API_KEY: "comis-broker-placeholder" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("secretRef env-var-shaped starting with uppercase letter followed by underscore and digits — no warning", async () => {
    const logger = createMockLogger();
    const buildPlaceholdersFromBindings = await getBuilder();

    const result = buildPlaceholdersFromBindings(
      { binding1: makeBinding("OPENAI_API_KEY2") },
      logger as any,
    );

    expect(result).toEqual({ OPENAI_API_KEY2: "comis-broker-placeholder" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("secretRef is opaque (lowercase kebab) and envVarName absent → emits WARN with hint", async () => {
    const logger = createMockLogger();
    const buildPlaceholdersFromBindings = await getBuilder();

    const result = buildPlaceholdersFromBindings(
      { binding1: makeBinding("anthropic-prod-secret") },
      logger as any,
    );

    // Key still set (fallback behavior preserved — silent 401 path)
    expect(result).toEqual({ "anthropic-prod-secret": "comis-broker-placeholder" });

    // WARN must have been emitted
    expect(logger.warn).toHaveBeenCalledOnce();
    const [warnFields, warnMsg] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(warnFields).toMatchObject({
      secretRef: "anthropic-prod-secret",
      hint: expect.stringContaining("envVarName"),
    });
    expect(warnMsg).toEqual(expect.stringContaining("secretRef is not env-var-shaped"));
  });

  it("secretRef is lowercase plain name and envVarName absent → emits WARN", async () => {
    const logger = createMockLogger();
    const buildPlaceholdersFromBindings = await getBuilder();

    buildPlaceholdersFromBindings(
      { binding1: makeBinding("my-key") },
      logger as any,
    );

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("multiple bindings: warns once per opaque secretRef, not for env-var-shaped ones", async () => {
    const logger = createMockLogger();
    const buildPlaceholdersFromBindings = await getBuilder();

    buildPlaceholdersFromBindings(
      {
        b1: makeBinding("GOOD_KEY"),          // env-var-shaped, no warn
        b2: makeBinding("opaque-secret"),     // opaque, warn
        b3: makeBinding("another-bad-key"),   // opaque, warn
        b4: makeBinding("bad-ref", "GOOD_NAMED_KEY"), // has envVarName, no warn
      },
      logger as any,
    );

    // Two warnings, one per opaque secretRef without envVarName
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("empty bindings → no warning, empty result", async () => {
    const logger = createMockLogger();
    const buildPlaceholdersFromBindings = await getBuilder();

    const result = buildPlaceholdersFromBindings({}, logger as any);
    expect(result).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
