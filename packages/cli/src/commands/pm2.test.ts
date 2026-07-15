// SPDX-License-Identifier: Apache-2.0
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConsoleSpy,
  createProcessExitSpy,
  createTestProgram,
  getSpyOutput,
} from "../test-helpers.js";

const promisifiedExec = vi.fn();
const mockExecFile = Object.assign(vi.fn(), {
  [promisify.custom]: promisifiedExec,
});

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: { homedir: vi.fn(() => "/tmp/test-home") },
  homedir: vi.fn(() => "/tmp/test-home"),
}));

const { registerPm2Command } = await import("./pm2.js");

describe("pm2 status failure semantics", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits unsuccessfully when the daemon is not managed by pm2", async () => {
    promisifiedExec
      .mockResolvedValueOnce({ stdout: "6.0.0\n", stderr: "" })
      .mockRejectedValueOnce(new Error("process not found"));
    const program = createTestProgram();
    registerPm2Command(program);

    await expect(program.parseAsync(["node", "test", "pm2", "status"]))
      .rejects.toThrow("process.exit called");

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("Daemon is not managed by pm2");
  });

  it("writes an ecosystem file that launches the role-gated daemon entrypoint", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(true);
    promisifiedExec.mockResolvedValue({ stdout: "6.0.0\n", stderr: "" });
    const program = createTestProgram();
    registerPm2Command(program);

    await program.parseAsync(["node", "test", "pm2", "setup"]);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("daemon-entrypoint.js"),
      { mode: 0o600 },
    );
  });
});
