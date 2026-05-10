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

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, execFile: vi.fn() },
    execFile: vi.fn(),
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
 */
function scriptExecFile(...calls: ScriptedCall[]): {
  capturedArgs: Array<{ file: string; args: readonly string[] }>;
} {
  const capturedArgs: Array<{ file: string; args: readonly string[] }> = [];
  const mock = cp.execFile as unknown as Mock;
  for (const c of calls) {
    mock.mockImplementationOnce(
      (
        file: string,
        args: readonly string[],
        _opts: unknown,
        cb?: ExecFileCallback,
      ) => {
        // promisify(execFile) always invokes the (file, args, opts, cb) form.
        const callback = (cb ??
          (typeof _opts === "function" ? (_opts as ExecFileCallback) : null))!;
        capturedArgs.push({ file, args });
        setImmediate(() => {
          if (c.error) {
            callback(c.error, c.stdout ?? "", c.stderr ?? "");
          } else {
            callback(null, c.stdout ?? "", c.stderr ?? "");
          }
        });
        return {} as ReturnType<typeof cp.execFile>;
      },
    );
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
  // Test 1 — systemd path
  it("returns {kind:'systemd'} when systemctl is-active comis is active", async () => {
    scriptExecFile({ stdout: "active\n" });
    const s = await detectSupervisor();
    expect(s).toEqual({ kind: "systemd" });
  });

  // Test 2 — systemd inactive falls through to pm2
  it("falls through to pm2 when systemctl reports inactive", async () => {
    scriptExecFile(
      { stdout: "inactive\n" },
      { stdout: '[{"name":"comis","pm_id":0}]' },
    );
    const s = await detectSupervisor();
    expect(s).toEqual({ kind: "pm2" });
  });

  // Test 3 — both fall through to bare-process
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

  // Test 4 — nothing → none
  it("returns {kind:'none'} when no probe matches", async () => {
    const e = Object.assign(new Error("not found"), { code: "ENOENT" });
    scriptExecFile({ error: e }, { error: e }, { error: e });
    const s = await detectSupervisor();
    expect(s).toEqual({ kind: "none" });
  });
});

describe("stopDaemon", () => {
  // Test 5 — systemd
  it("runs `systemctl stop comis` for systemd", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({ kind: "systemd" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].file).toBe("bash");
    expect(capturedArgs[0].args).toEqual(["-c", "systemctl stop comis"]);
  });

  // Test 6 — pm2
  it("runs `pm2 stop comis` for pm2", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({ kind: "pm2" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual(["-c", "pm2 stop comis"]);
  });

  // Test 7 — bare-process
  it("runs `pkill -f 'node.*daemon\\.js'` for bare-process", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({ kind: "bare-process" });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual([
      "-c",
      "pkill -f 'node.*daemon\\.js'",
    ]);
  });

  // Test 9 (stop/start manual)
  it("runs the supplied cmd verbatim for {kind:'manual'}", async () => {
    const { capturedArgs } = scriptExecFile({ stdout: "" });
    const r = await stopDaemon({
      kind: "manual",
      cmd: "echo restarting",
    });
    expect(r.ok).toBe(true);
    expect(capturedArgs[0].args).toEqual(["-c", "echo restarting"]);
  });

  // Test 10 (stop none)
  it("returns err({kind:'detection-failed'}) with the manual recipe for {kind:'none'}", async () => {
    const r = await stopDaemon({ kind: "none" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("detection-failed");
      expect(r.error.message).toBe(MANUAL_RECIPE_HINT);
    }
  });

  // Test 11 — ETIMEDOUT
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
  // Test 8 — bare-process unsupported
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
