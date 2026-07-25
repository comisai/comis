// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  isDirectDaemonRun,
  runDaemonEntrypoint,
  type DaemonProcessRuntime,
} from "./daemon-entrypoint.js";

function makeRuntime(
  overrides: Partial<DaemonProcessRuntime> = {},
): DaemonProcessRuntime {
  return {
    argv: ["node", "/app/daemon.js"],
    env: {},
    stderr: { write: vi.fn() },
    exit: vi.fn(),
    ...overrides,
  };
}

describe("daemon entrypoint", () => {
  it("recognizes direct daemon and process-manager execution", () => {
    expect(isDirectDaemonRun(makeRuntime())).toBe(true);
    expect(isDirectDaemonRun(makeRuntime({
      argv: ["node", "/app/worker.js"],
      env: { pm_id: "0" },
    }))).toBe(true);
    expect(isDirectDaemonRun(makeRuntime({
      argv: ["node", "/app/worker.js"],
    }))).toBe(false);
  });

  it("reports startup failure and exits after offering rollback", async () => {
    const runtime = makeRuntime();
    const buildRollbackSuggestion = vi.fn(() => ({
      hint: "Restore the saved configuration",
      diff: "changed: scheduler",
    }));

    await runDaemonEntrypoint(runtime, {
      defaultConfigPaths: ["/config/default.yaml"],
      exists: () => true,
      parseConfigPaths: () => [],
      handleRestoreFlag: vi.fn(),
      buildRollbackSuggestion,
      main: vi.fn().mockRejectedValue(new Error("startup failed")),
    });

    expect(runtime.stderr.write).toHaveBeenCalledWith("FATAL: startup failed\n");
    expect(buildRollbackSuggestion).toHaveBeenCalledWith("/config/default.yaml");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
