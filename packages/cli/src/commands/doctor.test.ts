/**
 * Tests for the doctor CLI command registration.
 *
 * Verifies that the doctor command is registered with the expected
 * options: --repair, --config, and --format.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerDoctorCommand } from "./doctor.js";

describe("registerDoctorCommand", () => {
  it("registers the doctor command with --repair, --config, --format options", () => {
    const program = new Command();
    registerDoctorCommand(program);

    const doctorCmd = program.commands.find((c) => c.name() === "doctor");
    expect(doctorCmd).toBeDefined();
    expect(doctorCmd!.description()).toBe(
      "Diagnose configuration, daemon, gateway, channel, and workspace health",
    );

    const optionNames = doctorCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--repair");
    expect(optionNames).toContain("--config");
    expect(optionNames).toContain("--format");
  });
});
