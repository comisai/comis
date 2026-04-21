// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// -- Mocks --

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    realpathSync: vi.fn((p: string) => p),
  };
});

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { SandboxExecProvider } from "./sandbox-exec-provider.js";
import type { SandboxOptions } from "./types.js";

function makeOpts(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workspacePath: "/Users/agent/workspace",
    sharedPaths: [],
    readOnlyPaths: [],
    cwd: "/Users/agent/workspace",
    tempDir: "/Users/agent/workspace/.tmp",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SandboxExecProvider", () => {
  // -- available() --

  describe("available()", () => {
    it("returns true when which succeeds and smoke test passes", () => {
      vi.mocked(execFileSync).mockImplementation((cmd: string) => {
        if (cmd === "which") return "/usr/bin/sandbox-exec\n";
        if (cmd === "sandbox-exec") return "ok\n";
        return "";
      });

      const provider = new SandboxExecProvider();
      expect(provider.available()).toBe(true);
      expect(execFileSync).toHaveBeenCalledTimes(2);
      expect(execFileSync).toHaveBeenCalledWith("which", ["sandbox-exec"], {
        encoding: "utf8",
      });
      expect(execFileSync).toHaveBeenCalledWith(
        "sandbox-exec",
        ["-p", "(version 1)(allow default)", "/bin/echo", "ok"],
        { encoding: "utf8", timeout: 3000 },
      );
    });

    it("returns false when which throws", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("not found");
      });

      const provider = new SandboxExecProvider();
      expect(provider.available()).toBe(false);
    });

    it("returns false when which succeeds but smoke test fails", () => {
      vi.mocked(execFileSync).mockImplementation((cmd: string) => {
        if (cmd === "which") return "/usr/bin/sandbox-exec\n";
        // Smoke test throws (sandbox-exec silently fails on macOS Sequoia)
        throw new Error("sandbox-exec failed");
      });

      const provider = new SandboxExecProvider();
      expect(provider.available()).toBe(false);
    });

    it("returns false when smoke test returns unexpected output", () => {
      vi.mocked(execFileSync).mockImplementation((cmd: string) => {
        if (cmd === "which") return "/usr/bin/sandbox-exec\n";
        // Smoke test returns empty string instead of "ok"
        return "";
      });

      const provider = new SandboxExecProvider();
      expect(provider.available()).toBe(false);
    });
  });

  // -- buildArgs() --

  describe("buildArgs()", () => {
    it('returns ["sandbox-exec", "-p", profile] where profile is a valid SBPL string', () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts());

      expect(args).toHaveLength(3);
      expect(args[0]).toBe("sandbox-exec");
      expect(args[1]).toBe("-p");
      expect(typeof args[2]).toBe("string");
      expect(args[2]).toContain("(version 1)");
    });

    it("generated SBPL profile contains (version 1) and (deny default)", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts());
      const profile = args[2]!;

      expect(profile).toContain("(version 1)");
      expect(profile).toContain("(deny default)");
    });

    it("generated SBPL profile contains (allow process-exec) and (allow process-fork)", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts());
      const profile = args[2]!;

      expect(profile).toContain("(allow process-exec)");
      expect(profile).toContain("(allow process-fork)");
    });

    it("generated SBPL profile contains (allow network*)", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts());
      const profile = args[2]!;

      expect(profile).toContain("(allow network*)");
    });

    it("generated SBPL profile contains file-read* rules for system paths, workspace, sharedPaths, readOnlyPaths", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(
        makeOpts({
          sharedPaths: ["/shared/data"],
          readOnlyPaths: ["/opt/tools"],
        }),
      );
      const profile = args[2]!;

      // System paths
      expect(profile).toContain('(allow file-read* (subpath "/usr"))');
      expect(profile).toContain('(allow file-read* (subpath "/bin"))');
      expect(profile).toContain('(allow file-read* (subpath "/sbin"))');
      expect(profile).toContain('(allow file-read* (subpath "/Library"))');
      expect(profile).toContain('(allow file-read* (subpath "/System"))');
      expect(profile).toContain('(allow file-read* (subpath "/opt/homebrew"))');
      expect(profile).toContain('(allow file-read* (subpath "/usr/local"))');
      expect(profile).toContain('(allow file-read* (subpath "/dev"))');

      // Timezone symlink chain: /usr/share/zoneinfo → /var/db/timezone → /private/var/db/timezone
      expect(profile).toContain('(allow file-read* (subpath "/private/var/db/timezone"))');
      expect(profile).toContain('(allow file-read* (subpath "/var/db/timezone"))');

      // Heredoc temp files: bash creates in /private/tmp, needs to read back
      expect(profile).toContain('(allow file-read* (subpath "/private/tmp"))');

      // Workspace
      expect(profile).toContain(
        '(allow file-read* (subpath "/Users/agent/workspace"))',
      );

      // Shared
      expect(profile).toContain('(allow file-read* (subpath "/shared/data"))');

      // Read-only
      expect(profile).toContain('(allow file-read* (subpath "/opt/tools"))');
    });

    it("generated SBPL profile contains file-write* rules for workspace, sharedPaths, /private/tmp, /private/var/folders", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(
        makeOpts({ sharedPaths: ["/shared/data"] }),
      );
      const profile = args[2]!;

      expect(profile).toContain(
        '(allow file-write* (subpath "/Users/agent/workspace"))',
      );
      expect(profile).toContain('(allow file-write* (subpath "/shared/data"))');
      expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
      expect(profile).toContain(
        '(allow file-write* (subpath "/private/var/folders"))',
      );
    });

    it("SBPL profile properly quotes paths containing backslashes", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(
        makeOpts({ readOnlyPaths: ["/path\\with\\backslash"] }),
      );
      const profile = args[2]!;

      expect(profile).toContain("/path\\\\with\\\\backslash");
    });

    it("SBPL profile properly quotes paths containing double quotes (injection prevention)", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(
        makeOpts({ readOnlyPaths: ['/path"with"quotes'] }),
      );
      const profile = args[2]!;

      expect(profile).toContain('/path\\"with\\"quotes');
      // Ensure the profile does NOT have unescaped quotes that break SBPL
      expect(profile).not.toContain('(subpath "/path"with"quotes")');
    });

    it("produces valid output with empty sharedPaths and readOnlyPaths", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts({ sharedPaths: [], readOnlyPaths: [] }));
      const profile = args[2]!;

      expect(profile).toContain("(version 1)");
      expect(profile).toContain("(deny default)");
      expect(profile).toContain("(allow network*)");
      expect(args[0]).toBe("sandbox-exec");
    });

    it("generated SBPL profile includes claude CLI paths when they exist", () => {
      // Simulate ~/.claude.json existing on disk
      vi.mocked(existsSync).mockImplementation((p) =>
        typeof p === "string" && p.endsWith(".claude.json"),
      );

      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts());
      const profile = args[2]!;

      // ~/.claude.json literal read+write (auth/config file at HOME root)
      // Path may be resolved via realpathSync, so check for the pattern
      expect(profile).toMatch(/\(allow file-read\* \(literal ".*\.claude\.json"\)\)/);
      expect(profile).toMatch(/\(allow file-write\* \(literal ".*\.claude\.json"\)\)/);
    });

    it("tempDir is added to write paths when it differs from /tmp and /private/tmp", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(
        makeOpts({ tempDir: "/custom/temp" }),
      );
      const profile = args[2]!;

      expect(profile).toContain('(allow file-write* (subpath "/custom/temp"))');
    });

    it("tempDir is NOT added to write paths when it equals /tmp", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts({ tempDir: "/tmp" }));
      const profile = args[2]!;

      // /tmp should NOT appear as a separate write path (only /private/tmp)
      const writeLines = profile
        .split("\n")
        .filter((l) => l.includes("file-write*"));
      const tmpWriteLines = writeLines.filter((l) => l.includes('"/tmp"'));
      expect(tmpWriteLines).toHaveLength(0);
    });

    it("tempDir is NOT added to write paths when it equals /private/tmp", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts({ tempDir: "/private/tmp" }));
      const profile = args[2]!;

      // /private/tmp should appear exactly once (from the default list)
      const writeLines = profile
        .split("\n")
        .filter((l) => l.includes("file-write*") && l.includes("/private/tmp"));
      expect(writeLines).toHaveLength(1);
    });

    it("generated SBPL profile contains PTY/ioctl rules for interactive tool support", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts());
      const profile = args[2]!;

      // ioctl scoped to /dev (tcgetattr/tcsetattr for PTY configuration)
      expect(profile).toContain('(allow file-ioctl (subpath "/dev"))');
      // PTY master allocation via posix_openpt
      expect(profile).toContain('(allow file-write* (literal "/dev/ptmx"))');
      // PTY slave device writes
      expect(profile).toContain('(allow file-write* (regex #"^/dev/ttys[0-9]+$"))');
    });

    it("generated SBPL profile contains system operation rules", () => {
      const provider = new SandboxExecProvider();
      const args = provider.buildArgs(makeOpts());
      const profile = args[2]!;

      expect(profile).toContain("(allow sysctl-read)");
      expect(profile).toContain("(allow mach-lookup)");
      expect(profile).toContain("(allow signal (target self))");
    });
  });

  // -- wrapEnv() --

  describe("wrapEnv", () => {
    it("sets TMPDIR to workspace-local .comis-tmp", () => {
      const provider = new SandboxExecProvider();
      const env = provider.wrapEnv!({ PATH: "/usr/bin" }, "/ws");
      expect(env.TMPDIR).toBe("/ws/.comis-tmp");
    });

    it("redirects package manager caches into workspace", () => {
      const provider = new SandboxExecProvider();
      const env = provider.wrapEnv!({}, "/ws");
      expect(env.NPM_CONFIG_CACHE).toBe("/ws/.cache/npm");
      expect(env.PIP_CACHE_DIR).toBe("/ws/.cache/pip");
      expect(env.XDG_CACHE_HOME).toBe("/ws/.cache");
    });

    it("sets Python env vars — PYTHONUSERBASE redirected, no PYTHONNOUSERSITE", () => {
      const provider = new SandboxExecProvider();
      const env = provider.wrapEnv!({}, "/ws");
      expect(env.PYTHONUSERBASE).toBe("/ws/.local");
      expect(env.MPLCONFIGDIR).toBe("/ws/.cache/matplotlib");
      expect(env.MPLBACKEND).toBe("Agg");
      // PYTHONNOUSERSITE must NOT be set — it prevents finding packages at PYTHONUSERBASE
      expect(env.PYTHONNOUSERSITE).toBeUndefined();
      // PIP_USER must NOT be set — it conflicts with venv installs
      expect(env.PIP_USER).toBeUndefined();
      // PYTHONPATH must NOT be set — it was clearing legitimate .pth entries
      expect(env.PYTHONPATH).toBeUndefined();
    });

    it("sets uv, Rust, Go, and Ruby cache dirs", () => {
      const provider = new SandboxExecProvider();
      const env = provider.wrapEnv!({}, "/ws");
      expect(env.UV_PYTHON_INSTALL_DIR).toBe("/ws/.cache/uv/python");
      expect(env.CARGO_HOME).toBe("/ws/.cache/cargo");
      expect(env.GOPATH).toBe("/ws/.cache/go");
      expect(env.GEM_HOME).toBe("/ws/.cache/gems");
    });

    it("preserves existing env vars", () => {
      const provider = new SandboxExecProvider();
      const env = provider.wrapEnv!({ MY_VAR: "keep", PATH: "/usr/bin" }, "/ws");
      expect(env.MY_VAR).toBe("keep");
      expect(env.PATH).toBe("/usr/bin");
    });
  });
});
