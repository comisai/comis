// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createDaemonHandlers, type DaemonHandlerDeps } from "./daemon-handlers.js";

// ---------------------------------------------------------------------------
// Helper: create mock LogLevelManager
// ---------------------------------------------------------------------------

function makeDeps(): DaemonHandlerDeps {
  return {
    logLevelManager: {
      getLogger: vi.fn(),
      setLevel: vi.fn(),
      setGlobalLevel: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon.setLogLevel", () => {
  // -------------------------------------------------------------------------
  // Admin trust level required
  // -------------------------------------------------------------------------

  it("rejects daemon.setLogLevel without admin trust level", async () => {
    const deps = makeDeps();
    const handlers = createDaemonHandlers(deps);

    await expect(
      handlers["daemon.setLogLevel"]!({ level: "debug", _trustLevel: "viewer" }),
    ).rejects.toThrow("Admin access required");

    expect(deps.logLevelManager.setLevel).not.toHaveBeenCalled();
    expect(deps.logLevelManager.setGlobalLevel).not.toHaveBeenCalled();
  });

  it("rejects daemon.setLogLevel without any trust level", async () => {
    const deps = makeDeps();
    const handlers = createDaemonHandlers(deps);

    await expect(
      handlers["daemon.setLogLevel"]!({ level: "debug" }),
    ).rejects.toThrow("Admin access required");

    expect(deps.logLevelManager.setLevel).not.toHaveBeenCalled();
    expect(deps.logLevelManager.setGlobalLevel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Silent level restriction
  // -------------------------------------------------------------------------

  it("rejects 'silent' level even with admin trust level", async () => {
    const deps = makeDeps();
    const handlers = createDaemonHandlers(deps);

    await expect(
      handlers["daemon.setLogLevel"]!({ level: "silent", _trustLevel: "admin" }),
    ).rejects.toThrow('Invalid log level: "silent"');

    expect(deps.logLevelManager.setLevel).not.toHaveBeenCalled();
    expect(deps.logLevelManager.setGlobalLevel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Functional tests (with admin)
  // -------------------------------------------------------------------------

  it("sets per-module level when module is provided", async () => {
    const deps = makeDeps();
    const handlers = createDaemonHandlers(deps);

    const result = await handlers["daemon.setLogLevel"]!({
      level: "debug",
      module: "agent",
      _trustLevel: "admin",
    });

    expect(deps.logLevelManager.setLevel).toHaveBeenCalledWith("agent", "debug");
    expect(deps.logLevelManager.setGlobalLevel).not.toHaveBeenCalled();
    expect(result).toEqual({
      updated: true,
      module: "agent",
      level: "debug",
      scope: "module",
      persistent: false,
    });
  });

  it("sets global level when module is not provided", async () => {
    const deps = makeDeps();
    const handlers = createDaemonHandlers(deps);

    const result = await handlers["daemon.setLogLevel"]!({
      level: "warn",
      _trustLevel: "admin",
    });

    expect(deps.logLevelManager.setGlobalLevel).toHaveBeenCalledWith("warn");
    expect(deps.logLevelManager.setLevel).not.toHaveBeenCalled();
    expect(result).toEqual({
      updated: true,
      level: "warn",
      scope: "global",
      persistent: false,
    });
  });

  it("rejects invalid log level", async () => {
    const deps = makeDeps();
    const handlers = createDaemonHandlers(deps);

    await expect(
      handlers["daemon.setLogLevel"]!({ level: "verbose", _trustLevel: "admin" }),
    ).rejects.toThrow('Invalid log level: "verbose"');

    expect(deps.logLevelManager.setLevel).not.toHaveBeenCalled();
    expect(deps.logLevelManager.setGlobalLevel).not.toHaveBeenCalled();
  });

  it("rejects missing level parameter", async () => {
    const deps = makeDeps();
    const handlers = createDaemonHandlers(deps);

    await expect(
      handlers["daemon.setLogLevel"]!({ _trustLevel: "admin" }),
    ).rejects.toThrow("level parameter is required");

    expect(deps.logLevelManager.setLevel).not.toHaveBeenCalled();
    expect(deps.logLevelManager.setGlobalLevel).not.toHaveBeenCalled();
  });

  it("allows all valid non-silent levels with admin", async () => {
    const validLevels = ["fatal", "error", "warn", "info", "debug", "trace"];
    for (const level of validLevels) {
      const deps = makeDeps();
      const handlers = createDaemonHandlers(deps);

      const result = await handlers["daemon.setLogLevel"]!({
        level,
        _trustLevel: "admin",
      });

      expect(result).toEqual(
        expect.objectContaining({ updated: true, level }),
      );
    }
  });
});
