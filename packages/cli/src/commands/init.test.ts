// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the init CLI command registration.
 *
 * Verifies that the init command is registered with the expected
 * 25 CLI flags covering all mode, provider, gateway, channel,
 * path, behavior, and reset options.
 */

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

// Short-circuit the wizard run so the interactive action reaches its
// terminal exit path without driving real prompts/IO.
vi.mock("../wizard/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/state.js")>()),
  runWizardFlow: vi.fn().mockResolvedValue({ completedSteps: [] }),
}));
// The interactive branch dynamically imports the clack adapter — stub it.
vi.mock("../wizard/clack-adapter.js", () => ({
  createClackAdapter: vi.fn(() => ({})),
}));

import { registerInitCommand, buildStepRegistry } from "./init.js";
import { buildNonInteractiveState } from "../wizard/non-interactive.js";
import type { WizardStepId } from "../wizard/types.js";

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

  it("registers all 25 CLI flags", () => {
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

    // Gateway (3)
    expect(optionLongs).toContain("--gateway-port");
    expect(optionLongs).toContain("--gateway-bind");
    expect(optionLongs).toContain("--gateway-token");

    // Channels (11)
    expect(optionLongs).toContain("--channels");
    expect(optionLongs).toContain("--telegram-token");
    expect(optionLongs).toContain("--discord-token");
    expect(optionLongs).toContain("--slack-bot-token");
    expect(optionLongs).toContain("--slack-app-token");
    expect(optionLongs).toContain("--line-token");
    expect(optionLongs).toContain("--line-secret");
    expect(optionLongs).toContain("--msteams-app-id");
    expect(optionLongs).toContain("--msteams-app-password");
    expect(optionLongs).toContain("--msteams-tenant-id");
    expect(optionLongs).toContain("--msteams-auth-mode");

    // Media generation + processing (8)
    expect(optionLongs).toContain("--image-provider");
    expect(optionLongs).toContain("--image-api-key");
    expect(optionLongs).toContain("--video-provider");
    expect(optionLongs).toContain("--video-api-key");
    expect(optionLongs).toContain("--stt-provider");
    expect(optionLongs).toContain("--stt-api-key");
    expect(optionLongs).toContain("--tts-provider");
    expect(optionLongs).toContain("--tts-api-key");

    // Paths (2)
    expect(optionLongs).toContain("--data-dir");
    expect(optionLongs).toContain("--config-dir");

    // Credential storage (1)
    expect(optionLongs).toContain("--storage");

    // Post-setup behavior (3)
    expect(optionLongs).toContain("--start-daemon");
    expect(optionLongs).toContain("--skip-health");
    expect(optionLongs).toContain("--skip-validation");

    // Reset (2)
    expect(optionLongs).toContain("--reset");
    expect(optionLongs).toContain("--reset-scope");
  });

  it("has exactly 41 options", () => {
    const program = new Command();
    registerInitCommand(program);
    const initCmd = program.commands.find((c) => c.name() === "init")!;
    expect(initCmd.options).toHaveLength(41);
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

describe("non-interactive step coverage", () => {
  // Every step the registry registers is interactive EXCEPT the three terminal
  // steps the runner always executes itself. Any interactive step missing from
  // completedSteps runs in non-interactive mode and hits a prompt, throwing
  // "...prompt reached in non-interactive mode -- this is a bug". This invariant
  // ties completedSteps to the live registry so the two cannot drift — the
  // regression guard for the omitted "tool-providers" step.
  it("non-interactive completedSteps covers every registered interactive step", () => {
    const TERMINAL = new Set<WizardStepId>([
      "write-config",
      "daemon-start",
      "finish",
    ]);
    const registered = [...buildStepRegistry().keys()] as WizardStepId[];
    const interactive = registered.filter((id) => !TERMINAL.has(id));
    const completed = new Set(
      buildNonInteractiveState({
        nonInteractive: true,
        acceptRisk: true,
        provider: "openai",
        storage: "file",
      }).completedSteps,
    );
    const missing = interactive.filter((id) => !completed.has(id));
    expect(missing).toEqual([]);
  });
});

describe("interactive completion exits the process", () => {
  it("calls process.exit(0) after the interactive wizard succeeds", async () => {
    // Regression: the interactive success path fell off the end of the action
    // without exiting. The clack adapter holds the raw-mode TTY stdin handle,
    // so the event loop never drains and `comis init` hangs after "Happy
    // building!". The success path must exit explicitly like the cancel/error
    // paths already do.
    const program = new Command();
    registerInitCommand(program);

    const origTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number): never => {
        throw new Error(`__exit__:${code ?? 0}`);
      }) as never);

    try {
      await expect(
        program.parseAsync(["node", "comis", "init"]),
      ).rejects.toThrow("__exit__:0");
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      if (origTTY) {
        Object.defineProperty(process.stdin, "isTTY", origTTY);
      } else {
        // restore to the original (vitest default: not a TTY)
        Object.defineProperty(process.stdin, "isTTY", {
          value: undefined,
          configurable: true,
        });
      }
    }
  });
});
