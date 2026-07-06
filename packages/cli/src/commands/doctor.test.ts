// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the doctor CLI command registration.
 *
 * Verifies that the doctor command is registered with the expected
 * options: --repair, --config, --format, and --refresh-test.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerDoctorCommand } from "./doctor.js";

describe("registerDoctorCommand", () => {
  it("registers the doctor command with --repair, --config, --format, --refresh-test options", () => {
    const program = new Command();
    registerDoctorCommand(program);

    const doctorCmd = program.commands.find((c) => c.name() === "doctor");
    expect(doctorCmd).toBeDefined();
    // Description names all 11 diagnostic subsystems (including version-skew,
    // Teams, Google Chat, secrets-audit, and LCD, which the earlier 6-subsystem
    // string omitted).
    expect(doctorCmd!.description()).toBe(
      "Diagnose 11 subsystems: configuration, daemon, gateway, version-skew, channel, Teams, Google Chat, workspace, OAuth, secrets-audit, and LCD health",
    );

    const optionNames = doctorCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--repair");
    expect(optionNames).toContain("--config");
    expect(optionNames).toContain("--format");
    // Opt-in refresh probe flag.
    expect(optionNames).toContain("--refresh-test");

    // --help text MUST warn the operator about token rotation.
    const refreshTestOption = doctorCmd!.options.find(
      (o) => o.long === "--refresh-test",
    );
    expect(refreshTestOption).toBeDefined();
    expect(refreshTestOption!.description).toContain(
      "WARNING: rotates the refresh token at OpenAI",
    );
  });
});
