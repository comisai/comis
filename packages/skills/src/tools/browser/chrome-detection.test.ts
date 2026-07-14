// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  },
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("node:os", () => ({
  default: {
    homedir: vi.fn().mockReturnValue("/home/testuser"),
  },
  homedir: vi.fn().mockReturnValue("/home/testuser"),
}));

// We need to mock constants to avoid importing the real module chain
vi.mock("./constants.js", () => ({
  DEFAULT_CDP_PORT: 9222,
  DEFAULT_BROWSER_PROFILE: "comis",
}));

vi.mock("./config.js", () => ({}));

import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { findChrome, launchChrome, stopChrome, buildChromeEnv, type RunningChrome } from "./chrome-detection.js";

let fetchMock: ReturnType<typeof vi.fn>;
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset fs mocks to defaults — clearAllMocks() only clears call history,
  // not return values, so any test that customizes readdirSync/existsSync
  // would otherwise leak into the next test.
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readdirSync).mockReturnValue(
    [] as unknown as ReturnType<typeof fs.readdirSync>,
  );
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function createMockChildProcess(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  (proc as Record<string, unknown>).pid = 12345;
  (proc as Record<string, unknown>).killed = false;
  (proc as Record<string, unknown>).exitCode = null;
  (proc as Record<string, unknown>).kill = vi.fn().mockImplementation(() => {
    (proc as Record<string, unknown>).killed = true;
    return true;
  });
  (proc as Record<string, unknown>).stdin = new EventEmitter();
  (proc as Record<string, unknown>).stdout = new EventEmitter();
  (proc as Record<string, unknown>).stderr = new EventEmitter();
  return proc;
}

// ── findChrome ──────────────────────────────────────────────────────

describe("findChrome", () => {
  describe("custom path", () => {
    it("returns custom executable when path exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = findChrome("/usr/local/bin/my-chrome");

      expect(result).toEqual({ kind: "custom", path: "/usr/local/bin/my-chrome" });
    });

    it("returns null when custom path does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = findChrome("/usr/local/bin/nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("macOS detection", () => {
    beforeEach(() => {
      setPlatform("darwin");
      vi.mocked(os.homedir).mockReturnValue("/Users/testuser");
    });

    it("finds Google Chrome at system location", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "chrome",
        path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });
    });

    it("finds Brave when Chrome is not available", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "brave",
        path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      });
    });

    it("finds browser in user home Applications", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/Users/testuser/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "chrome",
        path: "/Users/testuser/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });
    });

    it("returns first match when multiple browsers exist", () => {
      // Google Chrome (system) comes before Brave in candidate order
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ||
        p === "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      );

      const result = findChrome();

      expect(result!.kind).toBe("chrome");
    });

    it("returns null when no browser is found", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = findChrome();

      expect(result).toBeNull();
    });

    it("finds Canary as last resort", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "canary",
        path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      });
    });
  });

  describe("Linux detection", () => {
    beforeEach(() => {
      setPlatform("linux");
    });

    it("finds google-chrome at /usr/bin", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/usr/bin/google-chrome",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "chrome",
        path: "/usr/bin/google-chrome",
      });
    });

    it("finds the brave-browser binary", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/usr/bin/brave-browser",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "brave",
        path: "/usr/bin/brave-browser",
      });
    });

    it("finds the snap chromium binary", () => {
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/snap/bin/chromium",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "chromium",
        path: "/snap/bin/chromium",
      });
    });

    it("returns null when no browser is found on Linux", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = findChrome();

      expect(result).toBeNull();
    });
  });

  describe("CloakBrowser detection", () => {
    beforeEach(() => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser");
    });

    it("prefers CloakBrowser over stock Chrome on Linux when both exist", () => {
      setPlatform("linux");
      vi.mocked(fs.readdirSync).mockReturnValue([
        "chromium-146.0.7680.177.4",
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/home/testuser/.cloakbrowser" ||
        p === "/home/testuser/.cloakbrowser/chromium-146.0.7680.177.4/chrome" ||
        p === "/usr/bin/google-chrome",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "cloak",
        path: "/home/testuser/.cloakbrowser/chromium-146.0.7680.177.4/chrome",
      });
    });

    it("picks the newest version when multiple are cached", () => {
      setPlatform("linux");
      vi.mocked(fs.readdirSync).mockReturnValue([
        "chromium-146.0.7680.177.3",
        "chromium-146.0.7680.177.4",
        "chromium-145.0.7632.109.2",
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        typeof p === "string" && p.startsWith("/home/testuser/.cloakbrowser"),
      );

      const result = findChrome();

      expect(result?.kind).toBe("cloak");
      expect(result?.path).toBe(
        "/home/testuser/.cloakbrowser/chromium-146.0.7680.177.4/chrome",
      );
    });

    it("finds the macOS .app bundle binary", () => {
      setPlatform("darwin");
      vi.mocked(os.homedir).mockReturnValue("/Users/testuser");
      vi.mocked(fs.readdirSync).mockReturnValue([
        "chromium-145.0.7632.109.2",
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/Users/testuser/.cloakbrowser" ||
        p === "/Users/testuser/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium",
      );

      const result = findChrome();

      expect(result).toEqual({
        kind: "cloak",
        path: "/Users/testuser/.cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium",
      });
    });

    it("falls through to stock Chrome when cloakbrowser dir is empty", () => {
      setPlatform("linux");
      vi.mocked(fs.readdirSync).mockReturnValue(
        [] as unknown as ReturnType<typeof fs.readdirSync>,
      );
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/home/testuser/.cloakbrowser" ||
        p === "/usr/bin/google-chrome",
      );

      const result = findChrome();

      expect(result?.kind).toBe("chrome");
    });

    it("does not invoke readdirSync when ~/.cloakbrowser is missing", () => {
      setPlatform("linux");
      vi.mocked(fs.existsSync).mockImplementation((p) =>
        p === "/usr/bin/google-chrome",
      );

      const result = findChrome();

      expect(result?.kind).toBe("chrome");
      // readdirSync should never have been called because the root dir
      // existsSync check returned false.
      expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    it("explicit chromePath overrides CloakBrowser auto-detect", () => {
      setPlatform("linux");
      vi.mocked(fs.readdirSync).mockReturnValue([
        "chromium-146.0.7680.177.4",
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = findChrome("/custom/path/to/chrome");

      expect(result).toEqual({ kind: "custom", path: "/custom/path/to/chrome" });
    });
  });

  describe("unsupported platform", () => {
    it("returns null on Windows", () => {
      setPlatform("win32");

      const result = findChrome();

      expect(result).toBeNull();
    });

    it("returns null on FreeBSD", () => {
      setPlatform("freebsd");

      const result = findChrome();

      expect(result).toBeNull();
    });
  });
});

// ── launchChrome ────────────────────────────────────────────────────

describe("launchChrome", () => {
  let mockProc: ChildProcessWithoutNullStreams;

  beforeEach(() => {
    mockProc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    // Default: Chrome exists and CDP becomes reachable immediately
    vi.mocked(fs.existsSync).mockReturnValue(true);
    fetchMock.mockResolvedValue({ ok: true });
  });

  it("throws when no browser is found", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(
      launchChrome({ enabled: true }),
    ).rejects.toThrow("No supported browser found");
  });

  it("spawns Chrome with required base args", async () => {
    setPlatform("darwin");

    await launchChrome({
      enabled: true,
      cdpPort: 9222,
      defaultProfile: "test-profile",
    });

    const spawnCall = vi.mocked(spawn).mock.calls[0]!;
    const args = spawnCall[1] as string[];

    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
    expect(args).toContain("--disable-sync");
    expect(args).toContain("--disable-features=Translate,MediaRouter");
    expect(args.some((arg) => arg.includes("ServiceWorker"))).toBe(false);
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("--dns-prefetch-disable");
    expect(args).toContain("--disable-preconnect");
    expect(args).toContain("--password-store=basic");
    expect(args[args.length - 1]).toBe("about:blank");
  });

  it("includes user-data-dir based on profile name", async () => {
    setPlatform("darwin");
    vi.mocked(os.homedir).mockReturnValue("/Users/testuser");

    await launchChrome({
      enabled: true,
      defaultProfile: "my-profile",
    });

    const spawnCall = vi.mocked(spawn).mock.calls[0]!;
    const args = spawnCall[1] as string[];
    const udDir = args.find((a) => a.startsWith("--user-data-dir="));

    expect(udDir).toContain("my-profile");
    expect(udDir).toContain("user-data");
  });

  it("includes headless args by default", async () => {
    setPlatform("darwin");

    await launchChrome({ enabled: true });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];

    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-gpu");
  });

  it("omits headless args when headless is false", async () => {
    setPlatform("darwin");

    await launchChrome({ enabled: true, headless: false });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];

    expect(args).not.toContain("--headless=new");
    expect(args).not.toContain("--disable-gpu");
  });

  it("includes sandbox args when noSandbox is true", async () => {
    setPlatform("darwin");

    await launchChrome({ enabled: true, noSandbox: true });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];

    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-setuid-sandbox");
  });

  it("includes viewport args when viewport is configured", async () => {
    setPlatform("darwin");

    await launchChrome({
      enabled: true,
      viewport: { width: 1920, height: 1080 },
    });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];

    expect(args).toContain("--window-size=1920,1080");
  });

  it("includes Linux-specific args on Linux", async () => {
    setPlatform("linux");

    await launchChrome({ enabled: true });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];

    expect(args).toContain("--disable-dev-shm-usage");
  });

  it("omits Linux-specific args on macOS", async () => {
    setPlatform("darwin");

    await launchChrome({ enabled: true });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];

    expect(args).not.toContain("--disable-dev-shm-usage");
  });

  it("uses filtered spawnEnv when provided", async () => {
    setPlatform("darwin");

    await launchChrome(
      { enabled: true },
      { PATH: "/custom/bin", DISPLAY: ":0" },
    );

    const spawnCall = vi.mocked(spawn).mock.calls[0]!;
    const env = spawnCall[2]!.env as Record<string, string>;

    expect(env.PATH).toBe("/custom/bin");
    expect(env.DISPLAY).toBe(":0");
    expect(env.HOME).toBeDefined();
  });

  it("returns RunningChrome handle on success", async () => {
    setPlatform("darwin");

    const result = await launchChrome({ enabled: true, cdpPort: 9333 });

    expect(result.pid).toBe(12345);
    expect(result.cdpPort).toBe(9333);
    expect(result.proc).toBe(mockProc);
    expect(result.exe.kind).toBeDefined();
    expect(result.startedAt).toBeGreaterThan(0);
  });

  it("throws when CDP is not reachable within timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setPlatform("darwin");

    // CDP never becomes reachable
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    // Attach .catch immediately to prevent unhandled rejection
    const promise = launchChrome({ enabled: true }).catch((e: Error) => e);

    // Advance time past the 15s deadline in large steps
    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(250);
    }

    const result = await promise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Failed to start Chrome CDP");

    vi.useRealTimers();
  });

  it("surfaces chrome's exit signal + stderr in the failure error (obs: no silent launch death)", async () => {
    // Regression: a silent Chrome death (e.g. seccomp SIGSYS under a hardened
    // systemd sandbox) previously surfaced only as an opaque downstream
    // connectOverCDP ECONNREFUSED, needing hand-reproduction. launchChrome now
    // captures Chrome's stderr + exit and puts them in the thrown error, which
    // flows to the browser tool.result — diagnosable from the trajectory alone.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setPlatform("linux");
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const promise = launchChrome({ enabled: true }).catch((e: Error) => e);
    (mockProc.stderr as unknown as EventEmitter).emit("data", Buffer.from("Bad system call (core dumped)\n"));
    (mockProc as unknown as EventEmitter).emit("exit", null, "SIGSYS");

    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(250);
    }

    const msg = ((await promise) as Error).message;
    expect(msg).toContain("Failed to start Chrome CDP");
    expect(msg).toContain("killed by signal SIGSYS");
    expect(msg).toContain("Bad system call");

    vi.useRealTimers();
  });
});

// ── stopChrome ──────────────────────────────────────────────────────

describe("stopChrome", () => {
  function createRunningChrome(
    overrides?: Partial<ChildProcessWithoutNullStreams>,
  ): RunningChrome {
    const proc = createMockChildProcess();
    if (overrides) {
      Object.assign(proc, overrides);
    }
    return {
      pid: 12345,
      exe: { kind: "chrome", path: "/usr/bin/chrome" },
      userDataDir: "/tmp/test-profile",
      cdpPort: 9222,
      startedAt: Date.now(),
      proc,
    };
  }

  it("returns immediately when process is already killed", async () => {
    const running = createRunningChrome();
    (running.proc as Record<string, unknown>).killed = true;

    await stopChrome(running);

    expect(running.proc.kill).not.toHaveBeenCalled();
  });

  it("returns immediately when process has exitCode", async () => {
    const running = createRunningChrome();
    (running.proc as Record<string, unknown>).exitCode = 0;

    await stopChrome(running);

    expect(running.proc.kill).not.toHaveBeenCalled();
  });

  it("sends SIGTERM before SIGKILL on graceful shutdown", async () => {
    const running = createRunningChrome();
    // Process exits gracefully after SIGTERM
    vi.mocked(running.proc.kill).mockImplementation((sig) => {
      if (sig === "SIGTERM") {
        (running.proc as Record<string, unknown>).exitCode = 0;
      }
      return true;
    });

    await stopChrome(running);

    expect(running.proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("sends SIGKILL after timeout if still running", async () => {
    vi.useFakeTimers();

    const running = createRunningChrome();
    // Process does NOT exit after SIGTERM
    vi.mocked(running.proc.kill).mockImplementation(() => true);

    const promise = stopChrome(running, 500);

    // Advance past the timeout (500ms + polling intervals of 100ms)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    await promise;

    expect(running.proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(running.proc.kill).toHaveBeenCalledWith("SIGKILL");

    vi.useRealTimers();
  });
});

describe("buildChromeEnv — headed Chrome DISPLAY passthrough", () => {
  // Regression: headed Chrome (headless:false — the default when the installer
  // provisions Xvfb) is spawned with the FILTERED subprocess env, which strips
  // DISPLAY. Without DISPLAY, headed Chrome cannot reach the Xvfb virtual display
  // (:99), exits immediately, nothing listens on the CDP port, and the browser
  // tool's navigate fails `connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222`.
  // Verified live on a clean install (2026-07-10): direct headed chrome under
  // DISPLAY=:99 renders example.com, but the daemon-spawned chrome (no DISPLAY)
  // dies. Fix: pass DISPLAY/XAUTHORITY from the daemon env into the Chrome env
  // when headed (never for headless — no wasted X wiring, and exec-tool
  // subprocesses still never receive DISPLAY).
  const savedDisplay = process.env["DISPLAY"];
  const savedXauth = process.env["XAUTHORITY"];
  afterEach(() => {
    if (savedDisplay === undefined) delete process.env["DISPLAY"];
    else process.env["DISPLAY"] = savedDisplay;
    if (savedXauth === undefined) delete process.env["XAUTHORITY"];
    else process.env["XAUTHORITY"] = savedXauth;
  });

  it("passes DISPLAY + XAUTHORITY into the Chrome env when headed, preserving the filtered subprocess env", () => {
    process.env["DISPLAY"] = ":99";
    process.env["XAUTHORITY"] = "/home/comis/.Xauthority";
    const env = buildChromeEnv({ PATH: "/usr/bin", HOME: "/home/comis" }, true);
    expect(env["DISPLAY"]).toBe(":99");
    expect(env["XAUTHORITY"]).toBe("/home/comis/.Xauthority");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("does NOT inject DISPLAY when headless (headless chrome needs no X display)", () => {
    process.env["DISPLAY"] = ":99";
    const env = buildChromeEnv({ PATH: "/usr/bin" }, false);
    expect(env["DISPLAY"]).toBeUndefined();
  });

  it("omits DISPLAY when headed but the daemon env has none (no X available)", () => {
    delete process.env["DISPLAY"];
    const env = buildChromeEnv({ PATH: "/usr/bin" }, true);
    expect(env["DISPLAY"]).toBeUndefined();
  });
});
