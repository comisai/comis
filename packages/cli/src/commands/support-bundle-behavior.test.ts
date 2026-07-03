// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `support-bundle` command action.
 *
 * Drives the Commander action with a mocked orchestrator so the exit-code
 * mapping, the json output shape, and the printed (never executed) reporter
 * next-steps are exercised without a real data dir:
 *   - `--deep` without `--session` is a usage error and never calls the
 *     orchestrator,
 *   - a degraded triage still exits success and prints the machine-readable
 *     { bundleDir, status, activeSignals } shape,
 *   - an unproducible bundle exits with a general failure and surfaces the hint,
 *   - the table view prints the path, the privacy notice, and the copy-paste
 *     tar and gh lines.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ok, err } from "@comis/shared";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";
import { ExitCode } from "../util/exit-codes.js";

// The offline orchestrator (already on disk) is mocked so the action runs with
// no real data dir; only the command wiring is under test here.
vi.mock("../support-bundle/generate.js", () => ({
  generateSupportBundle: vi.fn(),
}));

// systemGetEnv is overridden so the default config-path resolver is driven from
// the test rather than the invoking user's environment. Everything else on
// @comis/core (safePath, sanitizeLogString, systemNowMs) stays real.
let envState: Record<string, string | undefined> = {};
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    systemGetEnv: vi.fn((key: string) => envState[key]),
  };
});

const { registerSupportBundleCommand } = await import("./support-bundle.js");
const { generateSupportBundle } = await import("../support-bundle/generate.js");

/** A degraded (but successfully written) bundle result. */
const degradedBundle = ok({
  bundleDir: "/tmp/test-home/.comis/support-bundles/comis-support-2026-07-03T00-00-00-000Z",
  status: "degraded",
  activeSignals: ["daemon_down", "gateway_unreachable"],
  warnings: [{ source: "doctor", code: "doctor_run_failed", count: 1, message: "partial" }],
});

/** A clean, healthy bundle result with no active signals and no warnings. */
const healthyBundle = ok({
  bundleDir: "/tmp/test-home/.comis/support-bundles/comis-support-2026-07-03T01-00-00-000Z",
  status: "healthy",
  activeSignals: [],
  warnings: [],
});

/** The one hard failure: the bundle directory could not be produced. */
const unproducible = err({
  kind: "bundle-unproducible",
  errorKind: "resource",
  hint: "Ensure the data dir is writable and the support-bundles slot is a real directory.",
  reason: "EACCES",
});

describe("support-bundle usage guard", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    envState = {};
    vi.mocked(generateSupportBundle).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits with a usage error when --deep is passed without a --session target", async () => {
    const program = createTestProgram();
    registerSupportBundleCommand(program);

    try {
      await program.parseAsync(["node", "test", "support-bundle", "--deep"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(ExitCode.UsageError);
    // The orchestrator is never reached on a usage error.
    expect(vi.mocked(generateSupportBundle)).not.toHaveBeenCalled();
  });
});

describe("support-bundle json output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    envState = {};
    vi.mocked(generateSupportBundle).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prints bundleDir, status, and activeSignals as json and exits success on a degraded triage", async () => {
    vi.mocked(generateSupportBundle).mockResolvedValue(degradedBundle as never);

    const program = createTestProgram();
    registerSupportBundleCommand(program);

    try {
      await program.parseAsync(["node", "test", "support-bundle", "--format", "json"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    // Degraded triage is still a written bundle → success exit code.
    expect(exitSpy.spy).toHaveBeenCalledWith(ExitCode.Success);
    // The default window (24h) is forwarded to the orchestrator.
    expect(vi.mocked(generateSupportBundle)).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHours: 24 }),
    );
    // Exactly the machine-readable shape, nothing more.
    const printed = JSON.parse(consoleSpy.log.mock.calls[0]?.[0] as string);
    expect(printed).toEqual({
      bundleDir: degradedBundle.value.bundleDir,
      status: "degraded",
      activeSignals: ["daemon_down", "gateway_unreachable"],
    });
  });

  it("resolves config paths from the COMIS_CONFIG_PATHS environment when no --config flag is given", async () => {
    envState = { COMIS_CONFIG_PATHS: "/a/config.yaml:/b/config.yaml" };
    vi.mocked(generateSupportBundle).mockResolvedValue(degradedBundle as never);

    const program = createTestProgram();
    registerSupportBundleCommand(program);

    try {
      await program.parseAsync(["node", "test", "support-bundle", "--format", "json"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(vi.mocked(generateSupportBundle)).toHaveBeenCalledWith(
      expect.objectContaining({ configPaths: ["/a/config.yaml", "/b/config.yaml"] }),
    );
  });
});

describe("support-bundle failure branch", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    envState = {};
    vi.mocked(generateSupportBundle).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("exits with a general failure and surfaces the hint when the bundle cannot be produced", async () => {
    vi.mocked(generateSupportBundle).mockResolvedValue(unproducible as never);

    const program = createTestProgram();
    registerSupportBundleCommand(program);

    try {
      await program.parseAsync(["node", "test", "support-bundle", "--config", "/x/config.yaml"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(ExitCode.GeneralFailure);
    const errOutput = getSpyOutput(consoleSpy.error);
    expect(errOutput).toContain("Ensure the data dir is writable");
  });
});

describe("support-bundle table output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    envState = {};
    vi.mocked(generateSupportBundle).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prints the path, status, privacy notice, and copy-paste tar and gh lines in table format", async () => {
    vi.mocked(generateSupportBundle).mockResolvedValue(degradedBundle as never);

    const program = createTestProgram();
    registerSupportBundleCommand(program);

    try {
      await program.parseAsync(["node", "test", "support-bundle", "--config", "/x/config.yaml"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(ExitCode.Success);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain(degradedBundle.value.bundleDir);
    expect(output).toContain("degraded");
    expect(output).toContain("daemon_down");
    // The copy-paste lines are PRINTED, never executed.
    expect(output).toContain("tar czf comis-support-2026-07-03T00-00-00-000Z.tar.gz");
    expect(output).toContain(
      `gh issue create --body-file ${degradedBundle.value.bundleDir}/issue-summary.md`,
    );
    // The privacy notice rides along with every human-readable bundle.
    expect(output.toLowerCase()).toContain("delete it after triage");
  });

  it("prints no active-signal or warning lines for a clean healthy triage in table format", async () => {
    vi.mocked(generateSupportBundle).mockResolvedValue(healthyBundle as never);

    const program = createTestProgram();
    registerSupportBundleCommand(program);

    try {
      await program.parseAsync(["node", "test", "support-bundle", "--config", "/x/config.yaml"]);
    } catch (e) {
      expect((e as Error).message).toBe("process.exit called");
    }

    expect(exitSpy.spy).toHaveBeenCalledWith(ExitCode.Success);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("healthy");
    // No signals and no partial sections → those lines are omitted entirely.
    expect(output).not.toContain("Active signals:");
    expect(output).not.toContain("section(s) were partial");
  });
});
