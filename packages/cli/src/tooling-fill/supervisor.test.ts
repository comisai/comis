// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for supervisor.ts — auto-detect systemd / pm2 / bare-process,
 * plus stop/start commands.
 *
 * Mock pattern: replace `node:child_process` at module-load time with a
 * wrapper that exposes a `vi.fn()` for `execFile`. supervisor.ts wraps
 * `execFile` at import time via `promisify(execFile)`, so we configure
 * the mock with callback-style stubs that `promisify` then awaits.
 *
 * @module
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// We deliberately strip util.promisify.custom from the mocked execFile so
// that supervisor.ts's `promisify(execFile)` falls back to the default
// callback-based promisify. We then teach our scripted callbacks to call
// back with a {stdout, stderr} object — promisify-default uses argument 2
// of the callback as the resolved value when it's a single non-error arg
// (per node:util docs). To match Node's child_process.execFile contract
// (which resolves to {stdout, stderr}), we set the custom symbol on our
// mock so promisify routes through the original-style resolver.
import { promisify } from "node:util";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Build a vi.fn() that carries util.promisify.custom — when promisify
  // sees the custom symbol it uses that custom impl (which resolves
  // {stdout, stderr}), but we control THAT impl so test stubs script the
  // resolved value directly.
  const mockExecFile = vi.fn() as unknown as typeof actual.execFile & {
    [k: symbol]: unknown;
  };
  // Lift the actual util.promisify.custom impl shape: it's
  //   (...args) => Promise<{stdout, stderr}>
  // We re-implement it to invoke the underlying mock with a callback
  // adapter, so test stubs configured via mockImplementationOnce see the
  // (file, args, opts, cb) shape and can fire cb(err, stdout, stderr).
  (mockExecFile as { [k: symbol]: unknown })[promisify.custom] = (
    ...callArgs: unknown[]
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const cb = (
        err: (Error & { code?: string | number; signal?: string }) | null,
        stdout: string,
        stderr: string,
      ): void => {
        if (err) {
          // Match Node's behavior: attach stdout/stderr so callers can
          // inspect on rejection (we don't rely on this in supervisor.ts
          // — only `code`/`signal`/`message` are read).
          (
            err as Error & { stdout?: string; stderr?: string }
          ).stdout = stdout;
          (
            err as Error & { stdout?: string; stderr?: string }
          ).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      };
      // Forward to the underlying vi.fn() with the (..., cb) shape so
      // mockImplementationOnce stubs receive what they expect.
      (mockExecFile as unknown as (...a: unknown[]) => unknown)(
        ...callArgs,
        cb,
      );
    });

  return {
    ...actual,
    default: { ...actual, execFile: mockExecFile },
    execFile: mockExecFile,
  };
});

const cp = await import("node:child_process");
const {
  detectSupervisor,
  stopDaemon,
  startDaemon,
  MANUAL_RECIPE_HINT,
} = await import("./supervisor.js");

type ExecFileCallback = (
  err: (Error & { code?: string | number; signal?: string }) | null,
  stdout: string,
  stderr: string,
) => void;

interface ScriptedCall {
  /** stdout to feed; if `error` is set, callback fires with the error first. */
  stdout?: string;
  stderr?: string;
  error?: Error & { code?: string | number; signal?: string };
}

/**
 * Push N scripted invocations onto the execFile mock, in order.
 * Each call pulls the next ScriptedCall and fires its callback async.
 *
 * The underlying mock is invoked by our util.promisify.custom shim with
 * (...origArgs, cb) — the cb is always the final positional argument.
 * Our scriptExecFile pulls cb from the args list rather than relying on
 * a fixed (file, args, opts, cb) shape, so callers like detectSupervisor
 * which use the (file, args, opts) form work too.
 */
function scriptExecFile(...calls: ScriptedCall[]): {
  capturedArgs: Array<{ file: string; args: readonly string[] }>;
} {
  const capturedArgs: Array<{ file: string; args: readonly string[] }> = [];
  const mock = cp.execFile as unknown as Mock;
  for (const c of calls) {
    mock.mockImplementationOnce((...callArgs: unknown[]) => {
      const file = callArgs[0] as string;
      const args = callArgs[1] as readonly string[];
      const cb = callArgs[callArgs.length - 1] as ExecFileCallback;
      capturedArgs.push({ file, args });
      setImmediate(() => {
        if (c.error) {
          cb(c.error, c.stdout ?? "", c.stderr ?? "");
        } else {
          cb(null, c.stdout ?? "", c.stderr ?? "");
        }
      });
      return {} as ReturnType<typeof cp.execFile>;
    });
  }
  return { capturedArgs };
}

beforeEach(() => {
  (cp.execFile as unknown as Mock).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("detectSupervisor", () => {
  it("returns {kind:'systemd'} when systemctl is-active comis is active", async () => {
    scriptExecFile({ stdout: "active\n" });
    const s = await detectSupervisor();
    expect(s).toEqual({ kind: "systemd" });
  });

  it("falls through to pm2 when systemctl reports inactive", async () => {
    scriptExecFile(
      { stdout: "inactive\n" },
      { stdout: '[{"name":"comis","pm_id":0}]' },
    );
    const s = await detectSupervisor();
    expect(s).toEqual({ kind: "pm2" });
  });

  it("falls through to bare-process when systemd and pm2 both fail", async () => {
    const sysErr = Object.assign(new Error("not installed"), {
      code: "ENOENT",
    });
    const pmErr = Object.assign(new Error("pm2 not found"), {
      code: "ENOENT",
    });
    scriptExecFile(
      { error: sysErr },
      { error: pmErr },
      { stdout: "12345\n" },
    );
    const s = await detectSupervisor();
    expect(s).toEqual({ kind: "bare-process" });
  });

  it("returns {kind:'none'} when no probe matches", async () => {
    const e = Object.assign(new Error("not found"), { code: "ENOENT" });
    scriptExecFile({ error: e }, { error: e }, { error: e });
    const s = await detectSupervisor();
    expect(s).toEqual({ kind: "none" });
  });
});

describe("stopDaemon", () => {
  it("runs `systemctl stop comis` for systemd", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({ kind: "systemd" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].file).toBe("bash");
    expect(capturedArgs[0].args).toEqual(["-c", "systemctl stop comis"]);
  });

  it("runs `pm2 stop comis` for pm2", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({ kind: "pm2" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual(["-c", "pm2 stop comis"]);
  });

  it("runs `pkill -f 'node.*daemon\\.js'` for bare-process", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({ kind: "bare-process" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual([
      "-c",
      "pkill -f 'node.*daemon\\.js'",
    ]);
  });

  // stop manual is a no-op.
  // The operator's --restart-cmd is a single command that does both stop+start.
  // If we ran it at stopDaemon AND startDaemon it would (a) execute twice and
  // (b) leave the daemon UP during the file edit. Treat manual mode as
  // start-only: stopDaemon is a no-op; the operator's cmd runs once at
  // startDaemon, after the file edit lands.
  it("is a no-op for {kind:'manual'} (operator's cmd runs at startDaemon only)", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({
      kind: "manual",
      cmd: "echo restarting",
    });
    expect(r.ok).toBe(true);
    expect(capturedArgs).toHaveLength(0);
  });

  it("returns err({kind:'detection-failed'}) with the manual recipe for {kind:'none'}", async () => {
    const r = await stopDaemon({ kind: "none" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("detection-failed");
      expect(r.error.message).toBe(MANUAL_RECIPE_HINT);
    }
  });

  it("maps ETIMEDOUT to err({kind:'timeout'})", async () => {
    const e = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
    });
    scriptExecFile({ error: e });
    const r = await stopDaemon({ kind: "systemd" }, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("timeout");
    }
  });
});

describe("startDaemon", () => {
  it("returns err({kind:'unsupported'}) for bare-process startDaemon", async () => {
    const r = await startDaemon({ kind: "bare-process" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("unsupported");
      expect(r.error.message).toContain("Bare-process");
    }
  });

  // start/manual symmetry
  it("runs the supplied cmd verbatim for startDaemon {kind:'manual'}", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await startDaemon({ kind: "manual", cmd: "do start" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual(["-c", "do start"]);
  });

  // start/none manual recipe
  it("returns err({kind:'detection-failed'}) for startDaemon {kind:'none'}", async () => {
    const r = await startDaemon({ kind: "none" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("detection-failed");
      expect(r.error.message).toBe(MANUAL_RECIPE_HINT);
    }
  });

  // start systemd & pm2 sanity
  it("runs `systemctl start comis` for startDaemon systemd", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await startDaemon({ kind: "systemd" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual(["-c", "systemctl start comis"]);
  });

  it("runs `pm2 start comis` for startDaemon pm2", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await startDaemon({ kind: "pm2" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual(["-c", "pm2 start comis"]);
  });
});
