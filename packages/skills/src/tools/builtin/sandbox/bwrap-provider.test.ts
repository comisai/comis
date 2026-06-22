// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// -- Mocks --

vi.mock(import("node:fs"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, existsSync: vi.fn().mockReturnValue(false) },
    existsSync: vi.fn().mockReturnValue(false),
  };
});

vi.mock(import("node:child_process"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock(import("node:os"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: vi.fn().mockReturnValue("/home/testuser") },
    homedir: vi.fn().mockReturnValue("/home/testuser"),
  };
});

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

    it("ro-binds /etc/fonts when present so libfontconfig finds its config", () => {
      // Regression: without /etc/fonts in the bind list, every text-rendering
      // call (matplotlib, Pango, Pillow TTF, ImageMagick, headless Chromium,
      // weasyprint, ffmpeg drawtext) prints "Cannot load default config file"
      // to stderr and falls back to a minimal compiled-in config, breaking
      // the font substitution chain for non-Latin scripts.
      vi.mocked(existsSync).mockImplementation((p) => String(p) === "/etc/fonts");

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      const hasRoBind = (target: string) => {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--ro-bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      };
      expect(hasRoBind("/etc/fonts")).toBe(true);
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
      // The diff should be much less than SYSTEM_RO_PATHS.length (21 paths)
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

    it("omits hardcoded claude CLI credential paths even when they exist on disk", () => {
      // Worst case: all three claude credential paths exist on disk. The
      // hardcoded claude binds were removed from the provider, so none may
      // appear as a bwrap bind target (neither --ro-bind nor --bind), in any
      // position, regardless of secureCredentialHome.
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

      expect(args).not.toContain("/home/testuser/.claude.json");
      expect(args).not.toContain("/home/testuser/.claude");
      expect(args).not.toContain("/home/testuser/.local/share/claude");
    });

    // -- Dev tool RW paths (XDG paths aligned with systemd ReadWritePaths) --

    it("rw-binds ~/.npm, ~/.cache, and ~/.local/share when they all exist", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser");
      vi.mocked(existsSync).mockImplementation((p) => {
        const existing = [
          "/home/testuser/.npm",
          "/home/testuser/.cache",
          "/home/testuser/.local/share",
        ];
        return existing.includes(String(p));
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      const hasBindTriple = (target: string) => {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      };
      expect(hasBindTriple("/home/testuser/.npm")).toBe(true);
      expect(hasBindTriple("/home/testuser/.cache")).toBe(true);
      expect(hasBindTriple("/home/testuser/.local/share")).toBe(true);
    });

    it("rw-binds ~/.local/share AFTER ro-binding ~/.local so RW overrides RO", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser");
      vi.mocked(existsSync).mockImplementation((p) => {
        const existing = [
          "/home/testuser/.local",         // from getUserRoPaths → ro-bound
          "/home/testuser/.local/share",   // from getDevToolRwPaths → rw-bound, MUST come after
          "/home/testuser/.cache",
          "/home/testuser/.npm",
        ];
        return existing.includes(String(p));
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      // Locate the --ro-bind /home/testuser/.local triple and the
      // --bind /home/testuser/.local/share triple.
      let roLocalIdx = -1;
      let rwLocalShareIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--ro-bind" &&
          args[i + 1] === "/home/testuser/.local" &&
          args[i + 2] === "/home/testuser/.local"
        ) {
          roLocalIdx = i;
        }
        if (
          args[i] === "--bind" &&
          args[i + 1] === "/home/testuser/.local/share" &&
          args[i + 2] === "/home/testuser/.local/share"
        ) {
          rwLocalShareIdx = i;
        }
      }
      expect(roLocalIdx).toBeGreaterThan(-1);
      expect(rwLocalShareIdx).toBeGreaterThan(-1);
      // The RW bind for the .local/share subpath MUST appear AFTER the RO bind
      // for .local so bwrap applies the more-permissive mount on top.
      expect(rwLocalShareIdx).toBeGreaterThan(roLocalIdx);
    });

    it("rw-binds dev tool paths BEFORE the discovery readOnlyPaths loop", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser");
      vi.mocked(existsSync).mockImplementation((p) => {
        const existing = [
          "/home/testuser/.npm",
          "/home/testuser/.cache",
          "/home/testuser/.local/share",
          "/opt/discovery-ro",
        ];
        return existing.includes(String(p));
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(
        makeOpts({ readOnlyPaths: ["/opt/discovery-ro"] }),
      );

      let rwCacheIdx = -1;
      let roDiscoveryIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--bind" &&
          args[i + 1] === "/home/testuser/.cache" &&
          args[i + 2] === "/home/testuser/.cache"
        ) {
          rwCacheIdx = i;
        }
        if (
          args[i] === "--ro-bind" &&
          args[i + 1] === "/opt/discovery-ro" &&
          args[i + 2] === "/opt/discovery-ro"
        ) {
          roDiscoveryIdx = i;
        }
      }
      expect(rwCacheIdx).toBeGreaterThan(-1);
      expect(roDiscoveryIdx).toBeGreaterThan(-1);
      // Dev tool RW MUST come before discovery RO so caller-supplied RO can't
      // shadow these (i.e. user can't accidentally disable XDG RW by passing
      // a parent path in readOnlyPaths).
      expect(rwCacheIdx).toBeLessThan(roDiscoveryIdx);
    });

    it("skips dev tool paths that don't exist (e.g. ~/.npm missing)", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser");
      vi.mocked(existsSync).mockImplementation((p) => {
        // ~/.npm intentionally missing
        const existing = [
          "/home/testuser/.cache",
          "/home/testuser/.local/share",
        ];
        return existing.includes(String(p));
      });

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts());

      const hasBindTriple = (target: string) => {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      };
      // .cache and .local/share present
      expect(hasBindTriple("/home/testuser/.cache")).toBe(true);
      expect(hasBindTriple("/home/testuser/.local/share")).toBe(true);
      // .npm missing → no bind triple for it
      expect(hasBindTriple("/home/testuser/.npm")).toBe(false);
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

    // -- Network modes (ENDPOINT-03: cap-socket bind for the lease endpoint) --

    describe("network modes", () => {
      /** Locate the index of the "--bind <path> <path>" triple, or -1. */
      function bindTripleIndex(args: string[], target: string): number {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--bind" && args[i + 1] === target && args[i + 2] === target) {
            return i;
          }
        }
        return -1;
      }

      it("cap-socket mode binds the socket after --unshare-all then --unshare-net (arg-order)", () => {
        // ENDPOINT-03: the lease endpoint listens on a unix socket the jailed
        // child must reach. netns affects IP sockets only, so a bound unix path
        // stays reachable under --unshare-net — but the --bind MUST follow the
        // --unshare-net so bwrap applies it inside the new namespace (mirrors
        // broker-only). With no cap-socket branch the _exhaustive guard throws.
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(
          makeOpts({ network: { mode: "cap-socket", capSocketPath: "/run/cap.sock" } }),
        );

        const unshareAllIdx = args.indexOf("--unshare-all");
        const unshareNetIdx = args.indexOf("--unshare-net");
        const capBindIdx = bindTripleIndex(args, "/run/cap.sock");

        expect(unshareAllIdx).toBeGreaterThan(0);
        expect(unshareNetIdx).toBeGreaterThan(0);
        expect(capBindIdx).toBeGreaterThan(0);
        // Arg-order is load-bearing: --unshare-all, then --unshare-net, then the bind.
        expect(unshareNetIdx).toBeGreaterThan(unshareAllIdx);
        expect(capBindIdx).toBeGreaterThan(unshareNetIdx);

        // cap-socket must NOT re-share the net (no --share-net) and still hardens.
        expect(args).not.toContain("--share-net");
        expect(args).toContain("--new-session");
        expect(args).toContain("--die-with-parent");
      });

      it("open mode is unregressed (--share-net, no --unshare-net)", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(makeOpts({ network: { mode: "open" } }));

        expect(args).toContain("--share-net");
        expect(args).not.toContain("--unshare-net");
      });

      it("broker-only mode is unregressed (binds broker socket after --unshare-net)", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(
          makeOpts({ network: { mode: "broker-only", brokerSocketPath: "/run/broker.sock" } }),
        );

        const unshareNetIdx = args.indexOf("--unshare-net");
        const brokerBindIdx = bindTripleIndex(args, "/run/broker.sock");
        expect(unshareNetIdx).toBeGreaterThan(0);
        expect(brokerBindIdx).toBeGreaterThan(unshareNetIdx);
        expect(args).not.toContain("--share-net");
      });

      it("none mode is unregressed (--unshare-net, no socket bind, no --share-net)", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(makeOpts({ network: { mode: "none" } }));

        expect(args).toContain("--unshare-net");
        expect(args).not.toContain("--share-net");
      });
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

    it("preserves existing non-PATH env vars (CUSTOM_VAR untouched)", () => {
      const provider = new BwrapProvider();
      const env = provider.wrapEnv(
        { PATH: "/usr/bin", CUSTOM_VAR: "hello" },
        "/home/agent/workspace",
      );

      // PATH gets augmented (asserted in dedicated tests below).
      // Non-PATH vars must be carried through verbatim.
      expect(env.CUSTOM_VAR).toBe("hello");
    });

    // -- New toolchain env vars (Task 3) --

    it("sets RUSTUP_HOME, UV_TOOL_DIR, PIPX_HOME, PIPX_BIN_DIR, PNPM_HOME, BUN_INSTALL, DENO_DIR, YARN_CACHE_FOLDER", () => {
      const provider = new BwrapProvider();
      const env = provider.wrapEnv({ PATH: "/usr/bin" }, "/tmp/ws");

      // RUSTUP_HOME points at the system rustup install (NOT workspace) so
      // the multiplexer can find the toolchain on first call. CARGO_HOME stays
      // workspace-rooted so `cargo install` outputs survive in the workspace.
      // See bwrap-provider.ts comment for rationale.
      expect(env.RUSTUP_HOME).toBe("/usr/local/rustup");
      expect(env.UV_TOOL_DIR).toBe("/tmp/ws/.cache/uv/tools");
      expect(env.PIPX_HOME).toBe("/tmp/ws/.cache/pipx");
      // PIPX_BIN_DIR aligns with PYTHONUSERBASE/bin so user-installed and
      // pipx-installed CLIs share a single PATH entry.
      expect(env.PIPX_BIN_DIR).toBe("/tmp/ws/.local/bin");
      expect(env.PNPM_HOME).toBe("/tmp/ws/.cache/pnpm");
      expect(env.BUN_INSTALL).toBe("/tmp/ws/.cache/bun");
      expect(env.DENO_DIR).toBe("/tmp/ws/.cache/deno");
      expect(env.YARN_CACHE_FOLDER).toBe("/tmp/ws/.cache/yarn");
    });

    it("preserves all pre-existing env redirects (regression guard)", () => {
      const provider = new BwrapProvider();
      const env = provider.wrapEnv({ PATH: "/usr/bin" }, "/tmp/ws");

      // Same set as the comprehensive test above, asserted alongside the new keys
      // to catch any accidental removal during the wrapEnv refactor.
      expect(env.TMPDIR).toBe("/tmp/ws/.comis-tmp");
      expect(env.NPM_CONFIG_CACHE).toBe("/tmp/ws/.cache/npm");
      expect(env.PIP_CACHE_DIR).toBe("/tmp/ws/.cache/pip");
      expect(env.XDG_CACHE_HOME).toBe("/tmp/ws/.cache");
      // XDG_STATE_HOME redirected so tools defaulting to ~/.local/state don't
      // EROFS (~/.local is RO under getUserRoPaths; only ~/.local/share is
      // carved out RW by getDevToolRwPaths).
      expect(env.XDG_STATE_HOME).toBe("/tmp/ws/.local/state");
      expect(env.PYTHONUSERBASE).toBe("/tmp/ws/.local");
      expect(env.MPLCONFIGDIR).toBe("/tmp/ws/.cache/matplotlib");
      expect(env.MPLBACKEND).toBe("Agg");
      expect(env.UV_PYTHON_INSTALL_DIR).toBe("/tmp/ws/.cache/uv/python");
      expect(env.CARGO_HOME).toBe("/tmp/ws/.cache/cargo");
      expect(env.GOPATH).toBe("/tmp/ws/.cache/go");
      expect(env.GOMODCACHE).toBe("/tmp/ws/.cache/go/pkg/mod");
      expect(env.GEM_HOME).toBe("/tmp/ws/.cache/gems");
      expect(env.BUNDLE_PATH).toBe("/tmp/ws/.cache/bundle");
    });

    it("prepends six tool-bin paths to PATH in documented order, then env.PATH", () => {
      const provider = new BwrapProvider();
      const env = provider.wrapEnv({ PATH: "/usr/bin:/bin" }, "/tmp/ws");

      // Order is load-bearing: pip --user / pipx CLIs first (most common in
      // agent flows), then cargo, go, bun, pnpm, deno. env.PATH is appended
      // last so installed CLIs shadow system tools when same name conflicts.
      expect(env.PATH.split(":")).toEqual([
        "/tmp/ws/.local/bin",
        "/tmp/ws/.cache/cargo/bin",
        "/tmp/ws/.cache/go/bin",
        "/tmp/ws/.cache/bun/bin",
        "/tmp/ws/.cache/pnpm",
        "/tmp/ws/.cache/deno/bin",
        "/usr/bin",
        "/bin",
      ]);
    });

    it("produces a valid PATH (no trailing/duplicate colons) when env.PATH is missing", () => {
      const provider = new BwrapProvider();
      const env = provider.wrapEnv({}, "/tmp/ws");

      // PATH must NOT end with ':' and must NOT contain '::' (an empty entry)
      expect(env.PATH).not.toMatch(/:$/);
      expect(env.PATH).not.toMatch(/::/);
      // Exactly the six tool-bin paths, in order
      expect(env.PATH.split(":")).toEqual([
        "/tmp/ws/.local/bin",
        "/tmp/ws/.cache/cargo/bin",
        "/tmp/ws/.cache/go/bin",
        "/tmp/ws/.cache/bun/bin",
        "/tmp/ws/.cache/pnpm",
        "/tmp/ws/.cache/deno/bin",
      ]);
    });

    it("drops empty segments from inherited PATH (leading/trailing/double colons)", () => {
      // Regression test for empty-segment PATH handling: an inherited PATH like ":foo:bar",
      // "foo::bar", or "foo:bar:" expands the empty segment to "." on
      // Unix, making the sandboxed CWD the first directory searched for
      // any binary. The provider must filter empty segments from
      // env.PATH before joining onto the tool-bin prefix.
      const provider = new BwrapProvider();

      for (const dirtyPath of [":/usr/bin", "/usr/bin:", "/usr/bin::/bin", ":/usr/bin:/bin:"]) {
        const env = provider.wrapEnv({ PATH: dirtyPath }, "/tmp/ws");
        const segments = env.PATH.split(":");
        // No empty segments survive.
        expect(
          segments.every((s) => s.length > 0),
          `PATH "${env.PATH}" (derived from "${dirtyPath}") must contain no empty segments`,
        ).toBe(true);
        // The cleaned inherited entries are appended after the tool-bin
        // prefix; "/usr/bin" must be present, "." must not.
        expect(segments).toContain("/usr/bin");
        expect(segments).not.toContain("");
        expect(segments).not.toContain(".");
      }
    });
  });
});
