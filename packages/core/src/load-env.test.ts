import { describe, it, expect, beforeEach } from "vitest";
import { assertEnvLoaded, resetEnvLoadedForTest, loadEnvFile } from "./load-env.js";

describe("assertEnvLoaded()", () => {
  beforeEach(() => {
    resetEnvLoadedForTest();
  });

  it("throws before loadEnvFile() is called", () => {
    expect(() => assertEnvLoaded()).toThrow(
      "loadEnvFile() must be called before createSecretManager()",
    );
  });

  it("does NOT throw after loadEnvFile() is called", () => {
    // Call loadEnvFile with a non-existent path (returns -1 but still sets flag)
    loadEnvFile("/tmp/comis-test-nonexistent-env-file-12345");
    expect(() => assertEnvLoaded()).not.toThrow();
  });

  it("resetEnvLoadedForTest() resets the flag", () => {
    loadEnvFile("/tmp/comis-test-nonexistent-env-file-12345");
    expect(() => assertEnvLoaded()).not.toThrow();

    resetEnvLoadedForTest();
    expect(() => assertEnvLoaded()).toThrow();
  });
});
