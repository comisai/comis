// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureEnvironmentVariables,
  captureProviderEnvironment,
} from "../../../test/support/daemon-harness.js";

describe("daemon harness provider environment rollback", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("restores exact absent empty and populated provider variable states", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "";
    const rollback = captureProviderEnvironment();

    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["OPENROUTER_API_KEY"] = "test-key";
    rollback();
    rollback();

    expect(Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_API_KEY")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(process.env, "OPENROUTER_API_KEY")).toBe(true);
    expect(process.env["OPENROUTER_API_KEY"]).toBe("");
  });

  it("restores an existing harness configuration path after mutation", () => {
    process.env["COMIS_CONFIG_PATHS"] = "/tmp/original-config.yaml";
    const rollback = captureEnvironmentVariables(["COMIS_CONFIG_PATHS"]);

    process.env["COMIS_CONFIG_PATHS"] = "/tmp/test-config.yaml";
    rollback();

    expect(process.env["COMIS_CONFIG_PATHS"]).toBe("/tmp/original-config.yaml");
  });
});
