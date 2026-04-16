/**
 * Tests for the init CLI command registration.
 *
 * Verifies that the init command is registered with the expected
 * 27 CLI flags covering all mode, provider, gateway, channel,
 * path, behavior, and reset options.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerInitCommand } from "./init.js";

describe("registerInitCommand", () => {
  it("registers the init command", () => {
    const program = new Command();
    registerInitCommand(program);
    const initCmd = program.commands.find((c) => c.name() === "init");
    expect(initCmd).toBeDefined();
    expect(initCmd!.description()).toBe(
      "Interactive setup wizard for first-time configuration",
    );
  });

  it("registers all 27 CLI flags", () => {
    const program = new Command();
    registerInitCommand(program);
    const initCmd = program.commands.find((c) => c.name() === "init")!;
    const optionLongs = initCmd.options.map((o) => o.long);

    // Mode flags (4)
    expect(optionLongs).toContain("--non-interactive");
    expect(optionLongs).toContain("--accept-risk");
    expect(optionLongs).toContain("--quick");
    expect(optionLongs).toContain("--json");

    // Provider/credentials (4)
    expect(optionLongs).toContain("--provider");
    expect(optionLongs).toContain("--api-key");
    expect(optionLongs).toContain("--agent-name");
    expect(optionLongs).toContain("--model");

    // Gateway (5)
    expect(optionLongs).toContain("--gateway-port");
    expect(optionLongs).toContain("--gateway-bind");
    expect(optionLongs).toContain("--gateway-auth");
    expect(optionLongs).toContain("--gateway-token");
    expect(optionLongs).toContain("--gateway-password");

    // Channels (7)
    expect(optionLongs).toContain("--channels");
    expect(optionLongs).toContain("--telegram-token");
    expect(optionLongs).toContain("--discord-token");
    expect(optionLongs).toContain("--slack-bot-token");
    expect(optionLongs).toContain("--slack-app-token");
    expect(optionLongs).toContain("--line-token");
    expect(optionLongs).toContain("--line-secret");

    // Paths (2)
    expect(optionLongs).toContain("--data-dir");
    expect(optionLongs).toContain("--config-dir");

    // Post-setup behavior (3)
    expect(optionLongs).toContain("--start-daemon");
    expect(optionLongs).toContain("--skip-health");
    expect(optionLongs).toContain("--skip-validation");

    // Reset (2)
    expect(optionLongs).toContain("--reset");
    expect(optionLongs).toContain("--reset-scope");
  });

  it("has exactly 27 options", () => {
    const program = new Command();
    registerInitCommand(program);
    const initCmd = program.commands.find((c) => c.name() === "init")!;
    expect(initCmd.options).toHaveLength(27);
  });

  it("parses --channels as comma-separated list", () => {
    const program = new Command();
    registerInitCommand(program);
    const initCmd = program.commands.find((c) => c.name() === "init")!;
    const channelsOpt = initCmd.options.find((o) => o.long === "--channels");
    expect(channelsOpt).toBeDefined();
    // Commander stores the parseArg function, verifying it exists
    expect(channelsOpt!.parseArg).toBeDefined();
  });

  it("parses --gateway-port as integer", () => {
    const program = new Command();
    registerInitCommand(program);
    const initCmd = program.commands.find((c) => c.name() === "init")!;
    const portOpt = initCmd.options.find((o) => o.long === "--gateway-port");
    expect(portOpt).toBeDefined();
    expect(portOpt!.parseArg).toBeDefined();
  });
});
