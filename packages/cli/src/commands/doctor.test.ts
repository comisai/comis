// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the doctor CLI command registration.
 *
 * Verifies that the doctor command is registered with the expected
 * options: --repair, --config, --format, and --refresh-test
 * (Phase 10 SC-10-2 / Plan 10-04).
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
    // Phase 10 SC-10-2: description includes OAuth as the 6th subsystem.
    expect(doctorCmd!.description()).toBe(
      "Diagnose configuration, daemon, gateway, channel, workspace, and OAuth health",
    );

    const optionNames = doctorCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--repair");
    expect(optionNames).toContain("--config");
    expect(optionNames).toContain("--format");
    // Phase 10 SC-10-2 (Plan 10-04, D-10-04-01): opt-in refresh probe flag.
    expect(optionNames).toContain("--refresh-test");

    // D-10-04-02: --help text MUST warn the operator about token rotation.
    const refreshTestOption = doctorCmd!.options.find(
      (o) => o.long === "--refresh-test",
    );
    expect(refreshTestOption).toBeDefined();
    expect(refreshTestOption!.description).toContain(
      "WARNING: rotates the refresh token at OpenAI",
    );
  });
});
