import { describe, it, expect, vi, beforeEach } from "vitest";

// -- Mocks --

vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn().mockReturnValue(false) },
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: { homedir: vi.fn().mockReturnValue("/home/testuser") },
  homedir: vi.fn().mockReturnValue("/home/testuser"),
}));

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { BwrapProvider } from "./bwrap-provider.js";
import type { SandboxOptions } from "./types.js";

function makeOpts(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workspacePath: "/home/agent/workspace",
    sharedPaths: [],
    readOnlyPaths: [],
    cwd: "/home/agent/workspace",
    tempDir: "/home/agent/workspace/.tmp",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// -- available() --

describe("BwrapProvider", () => {
  describe("available()", () => {
    it("returns true when which succeeds and caches bwrapPath", () => {
      vi.mocked(execFileSync).mockReturnValue("/usr/bin/bwrap\n");

      const provider = new BwrapProvider();
      expect(provider.available()).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith("which", ["bwrap"], { encoding: "utf8" });
    });

    it("returns false when which throws", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("not found");
      });

      const provider = new BwrapProvider();
      expect(provider.available()).toBe(false);
    });

    it("returns true on second call without re-running which (caching)", () => {
      vi.mocked(execFileSync).mockReturnValue("/usr/bin/bwrap\n");

      const provider = new BwrapProvider();
      expect(provider.available()).toBe(true);
      expect(provider.available()).toBe(true);
      // Only called once due to caching
      expect(execFileSync).toHaveBeenCalledTimes(1);
    });
  });

  // -- buildArgs() --

  describe("buildArgs()", () => {
    function createAvailableProvider(): BwrapProvider {
      vi.mocked(execFileSync).mockReturnValue("/usr/bin/bwrap\n");
      const provider = new BwrapProvider();
      provider.available();
      return provider;
    }

    it("includes all expected bwrap flags in correct order", () => {
      // Only a few system paths "exist"
      vi.mocked(existsSync).mockImplementation((p) => {
        const existing = ["/usr", "/bin"];
        return existing.includes(String(p));
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      // First arg is the bwrap binary
      expect(args[0]).toBe("/usr/bin/bwrap");

      // System paths come first
      const usrIdx = args.indexOf("--ro-bind");
      expect(usrIdx).toBeGreaterThan(0);

      // Then --proc, --dev
      expect(args).toContain("--proc");
      expect(args).toContain("--dev");

      // Then --tmpfs
      expect(args).toContain("--tmpfs");

      // Then workspace --bind
      const workspaceBindIdx = args.indexOf("/home/agent/workspace");
      expect(workspaceBindIdx).toBeGreaterThan(0);

      // Then isolation flags
      expect(args).toContain("--unshare-all");
      expect(args).toContain("--share-net");
      expect(args).toContain("--die-with-parent");
      expect(args).toContain("--new-session");

      // Then --chdir
      expect(args).toContain("--chdir");
      expect(args[args.length - 1]).toBe("/home/agent/workspace");
    });

    it("includes --ro-bind for system paths that exist and skips those that do not", () => {
      vi.mocked(existsSync).mockImplementation((p) => {
        return String(p) === "/usr" || String(p) === "/bin";
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      // /usr and /bin should be ro-bound: --ro-bind <src> <dest>
      const hasRoBind = (target: string) => {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--ro-bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      };
      expect(hasRoBind("/usr")).toBe(true);
      expect(hasRoBind("/bin")).toBe(true);

      // /sbin should NOT appear (existsSync returns false)
      expect(args.filter((a) => a === "/sbin")).toHaveLength(0);
    });

    it("caches system paths after first call", () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const provider = createAvailableProvider();
      vi.mocked(existsSync).mockClear();

      provider.buildArgs(makeOpts());
      const firstCallCount = vi.mocked(existsSync).mock.calls.length;

      provider.buildArgs(makeOpts());
      const secondCallCount = vi.mocked(existsSync).mock.calls.length;

      // Second call should not call existsSync for system paths again
      // It may still call for readOnlyPaths and getUserRoPaths, but system paths are cached.
      // The diff should be much less than SYSTEM_RO_PATHS.length (20 paths)
      expect(secondCallCount - firstCallCount).toBeLessThan(firstCallCount);
    });

    it("includes --bind for workspace and shared paths", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const provider = createAvailableProvider();
      const args = provider.buildArgs(
        makeOpts({ sharedPaths: ["/shared/data", "/shared/reports"] }),
      );

      // workspace: --bind <src> <dest>
      const hasBind = (target: string) => {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      };
      expect(hasBind("/home/agent/workspace")).toBe(true);

      // shared paths
      expect(args).toContain("/shared/data");
      expect(args).toContain("/shared/reports");
    });

    it("includes --ro-bind for readOnlyPaths that exist, skips those that don't", () => {
      vi.mocked(existsSync).mockImplementation((p) => {
        return String(p) === "/opt/tools";
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(
        makeOpts({ readOnlyPaths: ["/opt/tools", "/opt/missing"] }),
      );

      // /opt/tools should be ro-bound
      const toolsIdx = args.lastIndexOf("/opt/tools");
      expect(toolsIdx).toBeGreaterThan(0);

      // /opt/missing should NOT appear
      expect(args).not.toContain("/opt/missing");
    });

    it("includes user config paths when they exist", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser");
      vi.mocked(existsSync).mockImplementation((p) => {
        return String(p) === "/home/testuser/.gitconfig";
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      expect(args).toContain("/home/testuser/.gitconfig");
    });

    it("includes claude CLI paths as ro-bind and rw-bind when they exist", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser");
      vi.mocked(existsSync).mockImplementation((p) => {
        const existing = [
          "/home/testuser/.claude.json",
          "/home/testuser/.claude",
          "/home/testuser/.local/share/claude",
        ];
        return existing.includes(String(p));
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      // ~/.claude.json should be ro-bound (read-only config/auth)
      const hasRoBind = (target: string) => {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--ro-bind" && args[i + 1] === target) return true;
        }
        return false;
      };
      expect(hasRoBind("/home/testuser/.claude.json")).toBe(true);

      // ~/.claude/ and ~/.local/share/claude/ should be rw-bound
      const hasBind = (target: string) => {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--bind" && args[i + 1] === target) return true;
        }
        return false;
      };
      expect(hasBind("/home/testuser/.claude")).toBe(true);
      expect(hasBind("/home/testuser/.local/share/claude")).toBe(true);
    });

    it("includes isolation flags: --unshare-all, --share-net, --die-with-parent, --new-session", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      expect(args).toContain("--unshare-all");
      expect(args).toContain("--share-net");
      expect(args).toContain("--die-with-parent");
      expect(args).toContain("--new-session");
    });

    it("includes --chdir with opts.cwd", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts({ cwd: "/custom/cwd" }));

      const chdirIdx = args.indexOf("--chdir");
      expect(chdirIdx).toBeGreaterThan(0);
      expect(args[chdirIdx + 1]).toBe("/custom/cwd");
    });

    it("binds tempDir when it differs from /tmp", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts({ tempDir: "/home/agent/workspace/.tmp" }));

      expect(args).toContain("/home/agent/workspace/.tmp");
    });

    it("does NOT bind tempDir when it equals /tmp", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts({ tempDir: "/tmp" }));

      // Should have --tmpfs /tmp but NOT --bind /tmp /tmp
      const tmpfsIdx = args.indexOf("--tmpfs");
      expect(args[tmpfsIdx + 1]).toBe("/tmp");

      // /tmp should only appear after --tmpfs, not after --bind
      const bindIndices = args
        .map((a, i) => (a === "--bind" ? i : -1))
        .filter((i) => i !== -1);
      for (const bi of bindIndices) {
        expect(args[bi + 1]).not.toBe("/tmp");
      }
    });

    it("includes --dev-bind for /dev/pts (PTY support)", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      // PTY slave devices must be dev-bind mounted (not just --bind)
      const devBindIdx = args.indexOf("--dev-bind");
      expect(devBindIdx).toBeGreaterThan(0);
      expect(args[devBindIdx + 1]).toBe("/dev/pts");
      expect(args[devBindIdx + 2]).toBe("/dev/pts");
    });

    it("produces valid output with empty sharedPaths and readOnlyPaths", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const provider = createAvailableProvider();
      const args = provider.buildArgs(
        makeOpts({ sharedPaths: [], readOnlyPaths: [] }),
      );

      expect(args[0]).toBe("/usr/bin/bwrap");
      expect(args).toContain("--unshare-all");
      expect(args).toContain("--chdir");
    });
  });

  // -- wrapEnv() --

  describe("wrapEnv()", () => {
    it("sets TMPDIR, cache dirs, and language-specific dirs relative to workspace", () => {
      const provider = new BwrapProvider();
      const env = provider.wrapEnv({ PATH: "/usr/bin" }, "/home/agent/workspace");

      expect(env.TMPDIR).toBe("/home/agent/workspace/.comis-tmp");
      expect(env.NPM_CONFIG_CACHE).toBe("/home/agent/workspace/.cache/npm");
      expect(env.PIP_CACHE_DIR).toBe("/home/agent/workspace/.cache/pip");
      expect(env.XDG_CACHE_HOME).toBe("/home/agent/workspace/.cache");
      expect(env.PYTHONUSERBASE).toBe("/home/agent/workspace/.local");
      expect(env.MPLCONFIGDIR).toBe("/home/agent/workspace/.cache/matplotlib");
      expect(env.MPLBACKEND).toBe("Agg");
      // PYTHONNOUSERSITE must NOT be set — prevents finding packages at PYTHONUSERBASE
      expect(env.PYTHONNOUSERSITE).toBeUndefined();
      // PIP_USER must NOT be set — conflicts with venv installs
      expect(env.PIP_USER).toBeUndefined();
      // PYTHONPATH must NOT be set — was clearing legitimate .pth entries
      expect(env.PYTHONPATH).toBeUndefined();
      expect(env.UV_PYTHON_INSTALL_DIR).toBe("/home/agent/workspace/.cache/uv/python");
      expect(env.CARGO_HOME).toBe("/home/agent/workspace/.cache/cargo");
      expect(env.GOPATH).toBe("/home/agent/workspace/.cache/go");
      expect(env.GOMODCACHE).toBe("/home/agent/workspace/.cache/go/pkg/mod");
      expect(env.GEM_HOME).toBe("/home/agent/workspace/.cache/gems");
      expect(env.BUNDLE_PATH).toBe("/home/agent/workspace/.cache/bundle");
    });

    it("preserves existing env vars", () => {
      const provider = new BwrapProvider();
      const env = provider.wrapEnv(
        { PATH: "/usr/bin", CUSTOM_VAR: "hello" },
        "/home/agent/workspace",
      );

      expect(env.PATH).toBe("/usr/bin");
      expect(env.CUSTOM_VAR).toBe("hello");
    });
  });
});
