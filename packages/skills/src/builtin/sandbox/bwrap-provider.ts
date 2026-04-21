// SPDX-License-Identifier: Apache-2.0
/**
 * BwrapProvider -- Linux sandbox provider using Bubblewrap (bwrap).
 *
 * Generates bwrap CLI arguments that wrap child process spawns with
 * kernel-enforced filesystem isolation using user namespaces.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxOptions, SandboxProvider } from "./types.js";

/**
 * System paths to bind read-only. Filtered by existsSync once at
 * first buildArgs() call and cached for the provider's lifetime.
 */
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
];

/**
 * Per-user config paths to bind read-only. Resolved against the daemon
 * user's HOME at startup. These contain no secrets -- git config has
 * author name/email, not credentials (those live in credential helpers
 * or ~/.ssh which is intentionally NOT mounted).
 */
function getUserRoPaths(home: string): string[] {
  /* eslint-disable no-restricted-syntax -- Trusted: constant subpaths of homedir, no user input */
  return [
    path.join(home, ".gitconfig"),
    path.join(home, ".config", "git"),
    // pip/uv: .pth files in system site-packages inject custom paths into
    // sys.path. pip scans all sys.path via os.scandir(); without read access
    // it crashes with PermissionError.
    path.join(home, ".local"),
    // nvm Node.js — npm/npx need to read their cli.js source files
    path.join(home, ".nvm"),
    // claude CLI auth/config at HOME root (not inside ~/.claude/ directory).
    // Without read access, `claude -p` hangs indefinitely producing zero output.
    path.join(home, ".claude.json"),
  /* eslint-enable no-restricted-syntax */
  ].filter((p) => existsSync(p));
}

/**
 * Per-user claude CLI paths that need read-write access.
 * ~/.claude/ stores history, cache, settings, hooks, and skills.
 * ~/.local/share/claude/ stores version data and session state.
 */
function getClaudeCodeRwPaths(home: string): string[] {
  /* eslint-disable no-restricted-syntax -- Trusted: constant subpaths of homedir */
  return [
    path.join(home, ".claude"),
    path.join(home, ".local", "share", "claude"),
  /* eslint-enable no-restricted-syntax */
  ].filter((p) => existsSync(p));
}

export class BwrapProvider implements SandboxProvider {
  readonly name = "bwrap";

  private bwrapPath: string | null = null;
  /** Cached set of system paths that exist (populated on first buildArgs call). */
  private resolvedSysPaths: string[] | null = null;

  available(): boolean {
    if (this.bwrapPath !== null) return true;
    try {
      this.bwrapPath = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
      return true;
    } catch {
      return false;
    }
  }

  private getSystemPaths(): string[] {
    if (!this.resolvedSysPaths) {
      this.resolvedSysPaths = SYSTEM_RO_PATHS.filter((p) => existsSync(p));
    }
    return this.resolvedSysPaths;
  }

  buildArgs(opts: SandboxOptions): string[] {
    const args: string[] = [this.bwrapPath!];

    // -- System paths (read-only, cached at first call) --
    for (const sysPath of this.getSystemPaths()) {
      args.push("--ro-bind", sysPath, sysPath);
    }

    // -- Special filesystems --
    args.push("--proc", "/proc");
    args.push("--dev", "/dev");
    args.push("--dev-bind", "/dev/pts", "/dev/pts"); // PTY slave devices (interactive tools)

    // -- Temp directory (read-write) --
    args.push("--tmpfs", "/tmp");
    if (opts.tempDir && opts.tempDir !== "/tmp") {
      args.push("--bind", opts.tempDir, opts.tempDir);
    }

    // -- Workspace (read-write) --
    args.push("--bind", opts.workspacePath, opts.workspacePath);

    // -- Shared paths (read-write) --
    for (const sp of opts.sharedPaths) {
      args.push("--bind", sp, sp);
    }

    // -- User config paths (read-only) --
    for (const up of getUserRoPaths(os.homedir())) {
      args.push("--ro-bind", up, up);
    }

    // -- claude CLI paths (read-write) --
    for (const cp of getClaudeCodeRwPaths(os.homedir())) {
      args.push("--bind", cp, cp);
    }

    // -- Read-only paths (discovery paths, custom) --
    for (const ro of opts.readOnlyPaths) {
      if (existsSync(ro)) {
        args.push("--ro-bind", ro, ro);
      }
    }

    // -- Isolation flags --
    args.push(
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
    );

    // -- Working directory --
    args.push("--chdir", opts.cwd);

    return args;
  }

  wrapEnv(env: Record<string, string>, workspacePath: string): Record<string, string> {
    // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
    const cacheDir = path.join(workspacePath, ".cache");
    return {
      ...env,
      // Temp files: heredocs, wheel builds, etc.
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      TMPDIR: path.join(workspacePath, ".comis-tmp"),
      // Package manager caches
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      NPM_CONFIG_CACHE: path.join(cacheDir, "npm"),
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      PIP_CACHE_DIR: path.join(cacheDir, "pip"),
       
      XDG_CACHE_HOME: cacheDir,
      // Python: redirect user packages into workspace.
      // PYTHONNOUSERSITE is NOT set — sandbox read paths cover dirs that
      // pip needs to scan. Removing it lets Python find packages installed
      // to PYTHONUSERBASE.
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      PYTHONUSERBASE: path.join(workspacePath, ".local"),
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      MPLCONFIGDIR: path.join(cacheDir, "matplotlib"),
      // Force non-interactive backend — prevents plt.show() from opening GUI and blocking
      MPLBACKEND: "Agg",
      // uv: redirect managed Python installs into workspace
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      UV_PYTHON_INSTALL_DIR: path.join(cacheDir, "uv", "python"),
      // Rust
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      CARGO_HOME: path.join(cacheDir, "cargo"),
      // Go
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      GOPATH: path.join(cacheDir, "go"),
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      GOMODCACHE: path.join(cacheDir, "go", "pkg", "mod"),
      // Ruby
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      GEM_HOME: path.join(cacheDir, "gems"),
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      BUNDLE_PATH: path.join(cacheDir, "bundle"),
    };
  }
}
