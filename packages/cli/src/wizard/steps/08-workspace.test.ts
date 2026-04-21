// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for workspace directory step (step 08).
 *
 * Verifies default directory selection, custom directory input,
 * disk space detection and display, and graceful statfs failure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  statfs: vi.fn(async () => ({
    bavail: 100_000_000,
    bsize: 4096,
  })),
}));

vi.mock("node:os", () => {
  const homedir = vi.fn(() => "/home/test");
  return {
    homedir,
    default: { homedir },
  };
});

import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import type { WizardPrompter, WizardState, Spinner } from "../index.js";
import { workspaceStep } from "./08-workspace.js";

// ---------- Mock Prompter Helper ----------

function createMockPrompter(
  responses: {
    text?: string[];
  } = {},
): WizardPrompter {
  const textQueue = [...(responses.text ?? [])];

  const mockSpinner: Spinner = {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async (opts) => {
      const val = textQueue.shift();
      return val ?? opts.defaultValue ?? "";
    }),
    select: vi.fn(async () => ""),
    multiselect: vi.fn(async () => []),
    password: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    spinner: vi.fn(() => mockSpinner),
    group: vi.fn(async (steps) => {
      const result: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(steps)) {
        result[key] = await (fn as () => Promise<unknown>)();
      }
      return result;
    }) as WizardPrompter["group"],
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
  };
}

function baseState(): WizardState {
  return { completedSteps: [] };
}

// ---------- Tests ----------

describe("workspaceStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue("/home/test");
    vi.mocked(statfs).mockResolvedValue({
      bavail: 100_000_000,
      bsize: 4096,
    } as never);
  });

  it("has correct step id and label", () => {
    expect(workspaceStep.id).toBe("workspace");
    expect(workspaceStep.label).toBe("Workspace");
  });

  it("selects default data dir when user accepts default", async () => {
    const prompter = createMockPrompter({
      text: ["/home/test/.comis/data"],
    });

    const result = await workspaceStep.execute(baseState(), prompter);

    expect(result.dataDir).toBe("/home/test/.comis/data");
  });

  it("uses user-provided custom directory path", async () => {
    const prompter = createMockPrompter({
      text: ["/opt/comis/data"],
    });

    const result = await workspaceStep.execute(baseState(), prompter);

    expect(result.dataDir).toBe("/opt/comis/data");
  });

  it("displays disk space info when statfs succeeds", async () => {
    const prompter = createMockPrompter();

    await workspaceStep.execute(baseState(), prompter);

    // Should log disk space info
    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Disk space"),
    );
  });

  it("handles statfs failure gracefully without showing disk space", async () => {
    vi.mocked(statfs).mockRejectedValue(new Error("ENOENT"));

    const prompter = createMockPrompter();

    const result = await workspaceStep.execute(baseState(), prompter);

    // Should still set dataDir
    expect(result.dataDir).toBeDefined();

    // Should not show disk space line when statfs fails
    const infoCalls = vi.mocked(prompter.log.info).mock.calls;
    const diskSpaceCalls = infoCalls.filter(
      ([msg]) => typeof msg === "string" && msg.includes("Disk space"),
    );
    expect(diskSpaceCalls).toHaveLength(0);
  });

  it("shows section separator note", async () => {
    const prompter = createMockPrompter();

    await workspaceStep.execute(baseState(), prompter);

    expect(prompter.note).toHaveBeenCalled();
  });

  it("shows agent memory info message", async () => {
    const prompter = createMockPrompter();

    await workspaceStep.execute(baseState(), prompter);

    expect(prompter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Agent memory"),
    );
  });

  it("trims whitespace from user input", async () => {
    const prompter = createMockPrompter({
      text: ["  /opt/comis/data  "],
    });

    const result = await workspaceStep.execute(baseState(), prompter);

    expect(result.dataDir).toBe("/opt/comis/data");
  });

  it("falls back to default dir when user provides empty string", async () => {
    const prompter = createMockPrompter({
      text: [""],
    });

    const result = await workspaceStep.execute(baseState(), prompter);

    expect(result.dataDir).toBe("/home/test/.comis");
  });

  it("text prompt uses homedir-based default", async () => {
    const prompter = createMockPrompter();

    await workspaceStep.execute(baseState(), prompter);

    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Data directory",
        defaultValue: "/home/test/.comis",
      }),
    );
  });
});
