// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// -- Mocks --

const mockBwrapAvailable = vi.fn();
const mockSbexecAvailable = vi.fn();
const mockExistsSync = vi.fn<(p: string) => boolean>();
const mockSpawnSync = vi.fn<(cmd: string, args: string[], opts: object) => { status: number | null; stdout: string; stderr: string; signal?: NodeJS.Signals | null }>();

vi.mock("./bwrap-provider.js", () => {
  // Mirror of SYSTEM_RO_PATHS from bwrap-provider.ts — keep in sync (co-located
  // test, drift breaks regression coverage). Inlined here because vi.mock
  // factories are hoisted above all module-level statements; referencing an
  // outer const triggers TDZ on hoist.
  const SYSTEM_RO_PATHS = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/lib32",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/hostname",
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/pki",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/alternatives",
    "/etc/localtime",
    "/etc/passwd",
    "/etc/group",
    "/etc/nsswitch.conf",
    "/etc/fonts",
  ];
  return {
    BwrapProvider: class {
      readonly name = "bwrap";
      available() {
        return mockBwrapAvailable();
      }
    },
    SYSTEM_RO_PATHS,
  };
});

vi.mock("./sandbox-exec-provider.js", () => {
  return {
    SandboxExecProvider: class {
      readonly name = "sandbox-exec";
      available() {
        return mockSbexecAvailable();
      }
    },
  };
});

vi.mock("node:fs", () => ({
  existsSync: (p: string) => mockExistsSync(p),
}));

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[], opts: object) => mockSpawnSync(cmd, args, opts),
}));

import { detectSandboxProvider, type DetectLogger } from "./detect-provider.js";

let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

type LogLevel = "info" | "warn";

function createMockLogger(): DetectLogger & {
  calls: Array<{ level: LogLevel; obj: Record<string, unknown>; msg: string }>;
} {
  const calls: Array<{ level: LogLevel; obj: Record<string, unknown>; msg: string }> = [];
  return {
    calls,
    info(obj: Record<string, unknown>, msg: string) {
      calls.push({ level: "info", obj, msg });
    },
    warn(obj: Record<string, unknown>, msg: string) {
      calls.push({ level: "warn", obj, msg });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default to "not in container" -- tests that exercise the container path opt in.
  mockExistsSync.mockReturnValue(false);
  // Default the bwrap smoke test to success -- tests that simulate a kernel
  // that rejects --unshare-pid + --proc /proc opt in by overriding this.
  mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("detectSandboxProvider", () => {
  it("returns BwrapProvider on linux when bwrap is available", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);

    const result = detectSandboxProvider();

    expect(result).toBeDefined();
    expect(result!.name).toBe("bwrap");
  });

  it("returns BwrapProvider with NO log when bwrap smoke test passes", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeDefined();
    expect(result!.name).toBe("bwrap");
    expect(logger.calls).toHaveLength(0);
    // Smoke probe must run with the actual production isolation flags so we
    // catch kernels that reject the combo BwrapProvider.buildArgs() relies on.
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockSpawnSync.mock.calls[0]!;
    expect(cmd).toBe("bwrap");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--proc");
  });

  it("smoke test binds /lib64 when present (usrmerge x86-64 regression — fixes false-negative)", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);
    // Simulate Ubuntu 24.04 usrmerge layout: /usr /bin /lib /lib64 all exist;
    // /sbin and /lib32 absent (they would be filtered out).
    mockExistsSync.mockImplementation((p: string) =>
      ["/usr", "/bin", "/lib", "/lib64", "/etc/resolv.conf", "/etc/hosts", "/etc/passwd"].includes(p),
    );
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    detectSandboxProvider();

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const args = mockSpawnSync.mock.calls[0]![1];
    // /lib64 must be bound — this is the bug fix.
    const lib64Idx = args.indexOf("/lib64");
    expect(lib64Idx).toBeGreaterThan(-1);
    expect(args[lib64Idx - 1]).toBe("--ro-bind");
    expect(args[lib64Idx + 1]).toBe("/lib64");
    // Absent paths must NOT be bound (existsSync filter must run).
    expect(args).not.toContain("/sbin");
    expect(args).not.toContain("/lib32");
  });

  it("smoke test still uses --unshare-pid + --proc /proc after refactor", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);
    mockExistsSync.mockImplementation((p: string) => p === "/usr" || p === "/bin" || p === "/lib");
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    detectSandboxProvider();

    const args = mockSpawnSync.mock.calls[0]![1];
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--proc");
    expect(args).toContain("/proc");
    expect(args).toContain("/bin/true");
  });

  it("returns BwrapProvider but WARNs when smoke test fails on a bare-metal host", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "bwrap: Creating new namespace failed: Operation not permitted",
      signal: null,
    });
    // Default mockExistsSync is false → not a container.
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    // Bare-metal: keep the provider so exec fails loudly via bwrap stderr.
    // We do NOT silently disable the sandbox on bare metal — that would
    // be a real security regression on a production host.
    expect(result).toBeDefined();
    expect(result!.name).toBe("bwrap");
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.level).toBe("warn");
    expect(logger.calls[0]!.msg).toContain("smoke test failed");
    expect(logger.calls[0]!.obj.hint).toContain("bare-metal host");
    expect(logger.calls[0]!.obj.errorKind).toBe("config");
    // Child output is untrusted content; retain only a closed class + byte count.
    expect(logger.calls[0]!.obj.stderrClass).toBe("permission_denied");
    expect(logger.calls[0]!.obj.stderrBytes).toBe(
      Buffer.byteLength("bwrap: Creating new namespace failed: Operation not permitted"),
    );
    expect(JSON.stringify(logger.calls[0]!.obj)).not.toContain("Creating new namespace failed");
    expect(logger.calls[0]!.obj.signal).toBeNull();
    // Hint structure: closed-class guidance first, kernel sysctls secondary.
    expect(logger.calls[0]!.obj.hint).toMatch(/failure class/i);
    expect(logger.calls[0]!.obj.hint).toContain("kernel.unprivileged_userns_clone");
    expect(logger.calls[0]!.obj.hint).toContain("apparmor_restrict_unprivileged_userns");
    // Order matters: failure-class guidance precedes kernel sysctl guidance.
    const hint = String(logger.calls[0]!.obj.hint);
    expect(hint.toLowerCase().indexOf("failure class"))
      .toBeLessThan(hint.indexOf("kernel.unprivileged_userns_clone"));
  });

  it("smoke-test failure log includes signal field when bwrap is killed by signal", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
    });
    const logger = createMockLogger();

    detectSandboxProvider(logger);

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.obj.signal).toBe("SIGTERM");
  });

  it("returns undefined inside a container when smoke test fails (auto-disable for dev/testing)", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
    });
    // Container detected → Docker Desktop linuxkit case.
    mockExistsSync.mockImplementation((p: string) => p === "/.dockerenv");
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    // Sandbox is auto-disabled inside a container so dev/testing exec is
    // functional. WARN must be loud because we have just dropped the
    // intra-container exec sandbox.
    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.level).toBe("warn");
    expect(logger.calls[0]!.msg).toContain("Exec sandbox DISABLED");
    expect(logger.calls[0]!.msg).toContain("UNSANDBOXED");
    expect(logger.calls[0]!.obj.hint).toContain("PRODUCTION DEPLOYMENTS MUST USE A REAL LINUX HOST");
    expect(logger.calls[0]!.obj.errorKind).toBe("config");
  });

  it("returns undefined on linux when bwrap is NOT available, logs WARN with hint", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(false);
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.level).toBe("warn");
    expect(logger.calls[0]!.msg).toContain("bwrap not found");
    expect(logger.calls[0]!.obj.hint).toContain("bubblewrap");
  });

  it("returns undefined on linux in a container (Docker), logs INFO not WARN", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(false);
    mockExistsSync.mockImplementation((p: string) => p === "/.dockerenv");
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.level).toBe("info");
    expect(logger.calls[0]!.msg).toContain("container runtime");
    expect(logger.calls[0]!.obj.hint).toContain("Container runtime detected");
    expect(logger.calls[0]!.obj.errorKind).toBeUndefined();
  });

  it("returns undefined on linux in a Podman container, logs INFO not WARN", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(false);
    mockExistsSync.mockImplementation((p: string) => p === "/run/.containerenv");
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.level).toBe("info");
  });

  it("returns SandboxExecProvider on darwin when sandbox-exec is available", () => {
    setPlatform("darwin");
    mockSbexecAvailable.mockReturnValue(true);

    const result = detectSandboxProvider();

    expect(result).toBeDefined();
    expect(result!.name).toBe("sandbox-exec");
  });

  it("returns undefined on darwin when sandbox-exec is NOT available, logs WARN", () => {
    setPlatform("darwin");
    mockSbexecAvailable.mockReturnValue(false);
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.msg).toContain("sandbox-exec not found");
  });

  it('returns undefined on unsupported platform (e.g., "win32"), logs WARN with platform name', () => {
    setPlatform("win32");
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.msg).toContain("Unsupported platform");
    expect(logger.calls[0]!.obj.hint).toContain("win32");
  });

  it("works correctly when no logger is provided (no crash on undefined logger)", () => {
    setPlatform("freebsd");

    // Should not throw
    const result = detectSandboxProvider();

    expect(result).toBeUndefined();
  });

  it("logger receives correct hint and errorKind fields", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(false);
    const logger = createMockLogger();

    detectSandboxProvider(logger);

    expect(logger.calls[0]!.obj.errorKind).toBe("config");
    expect(typeof logger.calls[0]!.obj.hint).toBe("string");
  });
});
