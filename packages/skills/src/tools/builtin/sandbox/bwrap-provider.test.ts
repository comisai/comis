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
import { createHash } from "node:crypto";
import { BwrapProvider, resolveJailNode, resolveJailAgentCli } from "./bwrap-provider.js";
import type { SandboxOptions } from "./types.js";

/** sha256 of the given bytes, lowercase hex — the manifest pin shape. */
function shaHex(s: string): string {
  return createHash("sha256").update(Buffer.from(s)).digest("hex");
}

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

    // WR-05: the JAIL-03 credential-denylist base is the EXPLICIT `opts.home`,
    // not the ambient `os.homedir()`. A caller-supplied shared path that is a
    // credential dir under the INJECTED home (~/.ssh) must be screened and
    // rejected — proving buildArgs screens against opts.home. The ambient
    // os.homedir() is mocked to a DIFFERENT path (/home/testuser), so if
    // buildArgs still read the ambient home (pre-fix) the bind would NOT match
    // the denylist and would be wrongly emitted instead of throwing.
    it("screens caller binds against the injected opts.home, not the ambient homedir", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/testuser"); // ambient (must be ignored)
      vi.mocked(existsSync).mockReturnValue(true);

      const provider = createAvailableProvider();
      // A shared path under the INJECTED home that is a credential dir (~/.ssh).
      const opts = makeOpts({
        home: "/home/injected",
        sharedPaths: ["/home/injected/.ssh"],
      });

      expect(() => provider.buildArgs(opts)).toThrow(/refusing unsafe jail bind/);
    });

    // WR-05: with opts.home supplied the generator does NOT consult the ambient
    // homedir at all — the screen-vs-bind interaction is deterministic without
    // mocking process env. A safe bind under the injected home is emitted, and a
    // credential dir under the AMBIENT home (which buildArgs must ignore) is NOT
    // treated as denylisted (it is just an unrelated, non-existent path here).
    it("uses opts.home for the user RO binds when supplied (ambient homedir not consulted)", () => {
      vi.mocked(os.homedir).mockReturnValue("/home/ambient");
      vi.mocked(existsSync).mockImplementation((p) => String(p) === "/home/injected/.gitconfig");

      const provider = createAvailableProvider();
      const args = provider.buildArgs(makeOpts({ home: "/home/injected" }));

      // The RO user-config bind resolves against the INJECTED home.
      expect(args).toContain("/home/injected/.gitconfig");
      // The ambient home's config is never bound (existsSync false for it anyway,
      // but more importantly buildArgs derived its paths from opts.home).
      expect(args).not.toContain("/home/ambient/.gitconfig");
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
        // The cap socket is a DAEMON-MINTED per-run path (conventionally under
        // /run/comis) — it is NOT screened by validateBindMount even though /run
        // is denylisted for caller binds (it is part of the trusted allow-list).
        const capSock = "/run/comis/cap.sock";
        const args = provider.buildArgs(
          makeOpts({ network: { mode: "cap-socket", capSocketPath: capSock } }),
        );

        const unshareAllIdx = args.indexOf("--unshare-all");
        const unshareNetIdx = args.indexOf("--unshare-net");
        const capBindIdx = bindTripleIndex(args, capSock);

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
        // Daemon-minted broker socket — also under /run/comis, also un-screened.
        const brokerSock = "/run/comis/broker.sock";
        const args = provider.buildArgs(
          makeOpts({ network: { mode: "broker-only", brokerSocketPath: brokerSock } }),
        );

        const unshareNetIdx = args.indexOf("--unshare-net");
        const brokerBindIdx = bindTripleIndex(args, brokerSock);
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

    // -- §4.7 hardening: --seccomp fd (JAIL-01) --

    describe("--seccomp fd emission (JAIL-01)", () => {
      it("emits --seccomp <fd> when a seccomp fd is provided", () => {
        // The provider/caller resolves the fd via loadSeccompProfileFd() and
        // passes it in; buildArgs is PURE (no live fs probe). The fd rides
        // beside --new-session/--die-with-parent.
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(makeOpts({ seccompFd: 7 }));

        const seccompIdx = args.indexOf("--seccomp");
        expect(seccompIdx).toBeGreaterThan(0);
        expect(args[seccompIdx + 1]).toBe("7");
      });

      it("OMITS --seccomp when no fd is provided (degrade, not crash)", () => {
        // loadSeccompProfileFd returns null when the BPF blob is absent →
        // buildArgs must omit --seccomp entirely; the other §4.7 controls hold.
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(makeOpts());

        expect(args).not.toContain("--seccomp");
      });

      it("OMITS --seccomp when the fd is explicitly null", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(makeOpts({ seccompFd: null }));

        expect(args).not.toContain("--seccomp");
      });
    });

    // -- §4.7 hardening: validateBindMount screening (JAIL-03) --

    describe("validateBindMount screening (JAIL-03)", () => {
      it("THROWS at jail construction when a host bind resolves into a denylisted dir", () => {
        // A denylisted bind (here a system /etc/* path supplied as a shared path)
        // is a misconfig that must FAIL LOUD — never silently emitted as a hole.
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        expect(() =>
          provider.buildArgs(makeOpts({ sharedPaths: ["/etc/cron.d"] })),
        ).toThrow(/unsafe jail bind/i);
      });

      it("THROWS when a host bind is a credential dir under HOME (~/.ssh)", () => {
        vi.mocked(os.homedir).mockReturnValue("/home/testuser");
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        expect(() =>
          provider.buildArgs(makeOpts({ sharedPaths: ["/home/testuser/.ssh"] })),
        ).toThrow(/unsafe jail bind/i);
      });

      it("does NOT throw for a safe workspace bind", () => {
        vi.mocked(os.homedir).mockReturnValue("/home/testuser");
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        expect(() => provider.buildArgs(makeOpts())).not.toThrow();
      });
    });

    // -- §4.7 hardening: writable-path audit (JAIL-02) --
    //
    // The audit asserts the emitted bind list for a typical autonomy jail does
    // NOT RW-bind any host-trusted writable path enumerated by ROADMAP
    // success-criterion 4 / JAIL-02. Each ROADMAP target is a NAMED case (no
    // shorthand subset): config, hooks, cron, ~/.nvm, learned-memory/skill,
    // execPath. AND a RO-bound parent must not let a nonexistent child config be
    // created (the CVE-2026-25725 hole).

    describe("writable-path audit (JAIL-02) — full ROADMAP success-criterion-4 enumeration", () => {
      const HOME = "/home/testuser";

      /** True iff `target` appears as the source of a `--bind` (RW) triple. */
      function isRwBound(args: string[], target: string): boolean {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      }

      /** True iff `target` appears as the source of a `--ro-bind` (RO) triple. */
      function isRoBound(args: string[], target: string): boolean {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--ro-bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      }

      /**
       * Build a typical autonomy jail with EVERYTHING on disk (worst case) so the
       * audit proves the bind list excludes the trusted writable paths even when
       * they exist — not merely because existsSync filtered them out.
       */
      function autonomyJailArgs(): string[] {
        vi.mocked(os.homedir).mockReturnValue(HOME);
        vi.mocked(existsSync).mockReturnValue(true);
        const provider = createAvailableProvider();
        return provider.buildArgs(
          makeOpts({ workspacePath: `${HOME}/.comis/workspace-agent`, cwd: `${HOME}/.comis/workspace-agent` }),
        );
      }

      it("does NOT RW-bind the agent config dir/file (config)", () => {
        const args = autonomyJailArgs();
        // The ~/.comis config tree must not be writable from inside the jail.
        expect(isRwBound(args, `${HOME}/.comis/config.yaml`)).toBe(false);
        expect(isRwBound(args, `${HOME}/.comis`)).toBe(false);
        expect(isRwBound(args, `${HOME}/.config`)).toBe(false);
      });

      it("does NOT RW-bind the hooks dir (hooks)", () => {
        const args = autonomyJailArgs();
        expect(isRwBound(args, `${HOME}/.comis/hooks`)).toBe(false);
      });

      it("does NOT RW-bind the cron dir (cron)", () => {
        const args = autonomyJailArgs();
        expect(isRwBound(args, `${HOME}/.comis/cron`)).toBe(false);
      });

      it("does NOT RW-bind ~/.nvm (the Node toolchain is RO, never writable)", () => {
        const args = autonomyJailArgs();
        // ~/.nvm is RO-bound by getUserRoPaths; it must NEVER be RW-bound (a
        // writable Node toolchain is a host-RCE persistence vector).
        expect(isRwBound(args, `${HOME}/.nvm`)).toBe(false);
      });

      it("does NOT RW-bind learned-memory / learned-skill files", () => {
        const args = autonomyJailArgs();
        // The agent's learned memory + skills are host-trusted state; a jailed
        // surface must not be able to rewrite them (poisoning vector).
        expect(isRwBound(args, `${HOME}/.comis/memory.db`)).toBe(false);
        expect(isRwBound(args, `${HOME}/.comis/skills`)).toBe(false);
      });

      it("does NOT RW-bind the bound execPath (the Node binary is never writable)", () => {
        // A writable interpreter binary is a host-RCE vector. The default
        // autonomy jail never RW-binds the daemon's process.execPath. (The
        // JAIL-04 bind mode that RO-binds execPath when node is absent on the
        // jail PATH is asserted in the Node-runtime-honesty suite.)
        const args = autonomyJailArgs();
        expect(isRwBound(args, process.execPath)).toBe(false);
        expect(isRwBound(args, "/usr/local/bin/node")).toBe(false);
      });

      it("does NOT RO-bind a PARENT that lets a nonexistent child config be created (CVE-2026-25725)", () => {
        // The CVE-2026-25725 hole: a RO-bind of a parent dir whose named child
        // config does NOT yet exist still lets the child be CREATED inside the
        // jail (bwrap RO-binds the dir, not the absent file). The audit forbids
        // RO-binding the ~/.comis parent (which would expose config/hooks/cron
        // creation) — only specific existing leaves may be bound.
        vi.mocked(os.homedir).mockReturnValue(HOME);
        // ~/.comis exists but the config FILE does not (the nonexistent child).
        vi.mocked(existsSync).mockImplementation((p) => String(p) !== `${HOME}/.comis/config.yaml`);
        const provider = createAvailableProvider();
        const args = provider.buildArgs(
          makeOpts({ workspacePath: `${HOME}/.comis/workspace-agent`, cwd: `${HOME}/.comis/workspace-agent` }),
        );
        // Neither RW nor RO bind of the ~/.comis parent (which would smuggle a
        // creatable config child).
        expect(isRwBound(args, `${HOME}/.comis`)).toBe(false);
        expect(isRoBound(args, `${HOME}/.comis`)).toBe(false);
      });
    });

    // -- §4.6 Node-runtime honesty (JAIL-04): buildArgs binds execPath on "bind" --

    describe("Node-runtime bind in buildArgs (JAIL-04)", () => {
      it("RO-binds execPath when jailNode mode is 'bind'", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const execPath = "/usr/local/bin/node";
        const args = provider.buildArgs(
          makeOpts({ jailNode: { mode: "bind", execPath } }),
        );

        // The daemon node binary is bound READ-ONLY (never RW — a writable
        // interpreter is a host-RCE vector).
        const hasRoBind = (target: string) => {
          for (let i = 0; i < args.length - 2; i++) {
            if (args[i] === "--ro-bind" && args[i + 1] === target && args[i + 2] === target) {
              return true;
            }
          }
          return false;
        };
        expect(hasRoBind(execPath)).toBe(true);
        // Never RW.
        expect(args.some((a, i) => a === "--bind" && args[i + 1] === execPath)).toBe(false);
      });

      it("does NOT bind execPath when jailNode mode is 'path' (node already on the jail PATH)", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(makeOpts({ jailNode: { mode: "path" } }));

        // No spurious execPath bind — node resolves from the bound RO paths.
        expect(args).not.toContain("/usr/local/bin/node");
      });

      it("does NOT bind execPath when jailNode mode is 'unavailable'", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(
          makeOpts({ jailNode: { mode: "unavailable", hint: "no node" } }),
        );

        expect(args).not.toContain("/usr/local/bin/node");
      });
    });

    // -- §4.7 comis-agent CLI bind in buildArgs (CLI-05): --ro-bind the binary --

    describe("comis-agent CLI bind in buildArgs (CLI-05)", () => {
      const binPath = "/x/comis-agent-entry.js";

      function hasRoBind(args: string[], target: string): boolean {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--ro-bind" && args[i + 1] === target && args[i + 2] === target) {
            return true;
          }
        }
        return false;
      }

      it("RO-binds the comis-agent binary (src==dest) when jailAgentCli mode is 'bind'", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(
          makeOpts({ jailAgentCli: { mode: "bind", binPath } }),
        );

        // The bound binary triple is adjacent (so COMIS_AGENT_BIN/PATH resolves
        // it in-jail) and READ-ONLY — a writable binary is a host-RCE vector.
        expect(hasRoBind(args, binPath)).toBe(true);
        // Never RW.
        expect(args.some((a, i) => a === "--bind" && args[i + 1] === binPath)).toBe(false);
      });

      it("does NOT bind the comis-agent binary when jailAgentCli mode is 'unavailable'", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(
          makeOpts({ jailAgentCli: { mode: "unavailable", hint: "comis-agent missing" } }),
        );

        expect(args).not.toContain(binPath);
      });

      it("does NOT bind the comis-agent binary when jailAgentCli is absent", () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const provider = createAvailableProvider();
        const args = provider.buildArgs(makeOpts());

        expect(args).not.toContain(binPath);
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

// ---------------------------------------------------------------------------
// resolveJailNode (JAIL-04 / v8 §4.6) — Node-runtime honesty.
// PURE three-mode resolver: probe node on the jail PATH → bind execPath →
// mark unavailable. macOS-unit-testable via an injected `exists` predicate.
// ---------------------------------------------------------------------------

describe("resolveJailNode (JAIL-04) — Node-runtime honesty", () => {
  it("mode 'path' when a node executable resolves under the bound RO pathDirs", () => {
    const result = resolveJailNode({
      pathDirs: ["/usr/bin", "/usr/local/bin"],
      execPath: "/opt/daemon/node",
      // A fake exists predicate: node lives under /usr/local/bin.
      exists: (p) => p === "/usr/local/bin/node",
    });
    expect(result.mode).toBe("path");
  });

  it("mode 'bind' with execPath when node is NOT on the jail PATH but execPath is set", () => {
    const result = resolveJailNode({
      pathDirs: ["/usr/bin", "/usr/local/bin"],
      execPath: "/opt/daemon/node",
      // No node under any pathDir; execPath exists.
      exists: (p) => p === "/opt/daemon/node",
    });
    expect(result.mode).toBe("bind");
    if (result.mode === "bind") {
      expect(result.execPath).toBe("/opt/daemon/node");
    }
  });

  it("mode 'unavailable' with a hint when neither a jail-PATH node nor a bindable execPath exists", () => {
    const result = resolveJailNode({
      pathDirs: ["/usr/bin"],
      execPath: undefined,
      exists: () => false,
    });
    expect(result.mode).toBe("unavailable");
    if (result.mode === "unavailable") {
      expect(typeof result.hint).toBe("string");
      expect(result.hint.length).toBeGreaterThan(0);
    }
  });

  it("the unavailable hint NEVER claims a bundled Node and names the remediation", () => {
    const result = resolveJailNode({ pathDirs: [], execPath: undefined, exists: () => false });
    expect(result.mode).toBe("unavailable");
    if (result.mode === "unavailable") {
      const h = result.hint.toLowerCase();
      // Must explicitly DENY a bundled Node (the spoofing class T-211-21).
      expect(h).toContain("bundled");
      // Names the remediation (install node / make the daemon binary bindable)
      // and which surfaces degrade.
      expect(h).toMatch(/install node|bindable|process\.execpath|execpath/);
      expect(h).toMatch(/unavailable|surface/);
    }
  });

  it("mode 'unavailable' even when execPath is set but does not exist on disk", () => {
    // An execPath that the exists-predicate says is absent must NOT be claimed
    // bindable — honesty over an optimistic bind.
    const result = resolveJailNode({
      pathDirs: ["/usr/bin"],
      execPath: "/gone/node",
      exists: () => false,
    });
    expect(result.mode).toBe("unavailable");
  });

  it("defaults to fs.existsSync when no exists predicate is injected", () => {
    // Production omits the predicate → the resolver uses the real existsSync
    // (mocked here). Mock says /usr/bin/node exists → "path".
    vi.mocked(existsSync).mockImplementation((p) => String(p) === "/usr/bin/node");
    const result = resolveJailNode({ pathDirs: ["/usr/bin"], execPath: "/opt/node" });
    expect(result.mode).toBe("path");
  });
});

// ---------------------------------------------------------------------------
// resolveJailAgentCli (CLI-05/06) — the comis-agent binary honest-degrade.
// PURE three-mode resolver: hash-verify the bound binary against the manifest
// pin → bind / unavailable-missing / unavailable-hash-mismatch. macOS-unit-
// testable via injected `exists` + `readFile` (no real fs, no real binary).
// ---------------------------------------------------------------------------

describe("resolveJailAgentCli (CLI-05/06) — comis-agent binary honest-degrade", () => {
  const binPath = "/opt/skills/dist/.../comis-agent-entry.js";
  const bytes = "the-real-comis-agent-entry-bytes";
  const expectedSha = shaHex(bytes);

  it("mode 'bind' when the file exists AND its sha256 matches the manifest pin", () => {
    const result = resolveJailAgentCli({
      binPath,
      expectedSha,
      exists: (p) => p === binPath,
      readFile: () => Buffer.from(bytes),
    });
    expect(result.mode).toBe("bind");
    if (result.mode === "bind") {
      expect(result.binPath).toBe(binPath);
    }
  });

  it("mode 'unavailable' (missing) when the file does NOT exist — the hint names comis-agent + the scoped degrade", () => {
    const result = resolveJailAgentCli({
      binPath,
      expectedSha,
      exists: () => false,
      readFile: () => Buffer.from(bytes),
    });
    expect(result.mode).toBe("unavailable");
    if (result.mode === "unavailable") {
      const h = result.hint.toLowerCase();
      expect(h).toContain("comis-agent");
      // The CLI surface degrades but the orchestrate SCRIPT surface still works.
      expect(h).toMatch(/script surface|cli surface|still work|unavailable/);
    }
  });

  it("mode 'unavailable' (hash MISMATCH / tamper) when the bytes do not match the pin — the hint names the mismatch", () => {
    const result = resolveJailAgentCli({
      binPath,
      expectedSha,
      exists: (p) => p === binPath,
      readFile: () => Buffer.from("TAMPERED-bytes-different-from-the-pin"),
    });
    expect(result.mode).toBe("unavailable");
    if (result.mode === "unavailable") {
      const h = result.hint.toLowerCase();
      expect(h).toContain("comis-agent");
      // The mismatch is named as a tamper / hash-mismatch signal (refuse to bind).
      expect(h).toMatch(/mismatch|tamper/);
    }
  });

  it("the unavailable hint NEVER echoes the expected hash or the binary bytes (content-free §2.7)", () => {
    const result = resolveJailAgentCli({
      binPath,
      expectedSha,
      exists: (p) => p === binPath,
      readFile: () => Buffer.from("TAMPERED-bytes"),
    });
    expect(result.mode).toBe("unavailable");
    if (result.mode === "unavailable") {
      // Never leak the hash digest or the raw bytes into the hint.
      expect(result.hint).not.toContain(expectedSha);
      expect(result.hint).not.toContain("TAMPERED-bytes");
    }
  });

  it("defaults to fs existsSync/readFileSync when no predicates are injected", () => {
    // Production omits the predicates → the resolver uses the real fs (mocked
    // here). The file is absent → unavailable (no throw on a missing binary).
    vi.mocked(existsSync).mockReturnValue(false);
    const result = resolveJailAgentCli({ binPath, expectedSha });
    expect(result.mode).toBe("unavailable");
  });
});
