// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ExitCode } from "./exit-codes.js";

describe("ExitCode constants", () => {
  it("declares ExitCode.DaemonRequired === 4 per CLI exit-code numbering contract", () => {
    expect(ExitCode.DaemonRequired).toBe(4);
  });

  it("Every exit code is unique", () => {
    const values = Object.values(ExitCode);
    const uniq = new Set(values);
    expect(uniq.size).toBe(values.length);
  });

  it("Documented values match plan", () => {
    expect(ExitCode.Success).toBe(0);
    expect(ExitCode.GeneralFailure).toBe(1);
    expect(ExitCode.UsageError).toBe(2);
    expect(ExitCode.ConfigError).toBe(3);
    expect(ExitCode.DaemonRequired).toBe(4);
    expect(ExitCode.DaemonRestartSignal).toBe(42);
  });
});
