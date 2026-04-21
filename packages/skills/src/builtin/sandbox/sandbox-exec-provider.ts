// SPDX-License-Identifier: Apache-2.0
/**
 * SandboxExecProvider -- macOS sandbox provider using sandbox-exec.
 *
 * Generates SBPL (Sandbox Profile Language) profiles that restrict
 * child process filesystem access via Apple's sandbox-exec utility.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { SandboxOptions, SandboxProvider } from "./types.js";

/** Escape a path for SBPL string literal. */
function sbplQuote(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve symlinks in a path for SBPL. On macOS, /var → /private/var,
 * /tmp → /private/tmp, /etc → /private/etc. The kernel uses resolved
 * paths for sandbox enforcement, so SBPL rules must use resolved paths.
 */
function resolvePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // Path doesn't exist yet — use as-is
  }
}

function buildSbplProfile(opts: SandboxOptions): string {
  // User home subdirectories needed by pip/uv (read-only).
  // pip scans all sys.path entries via os.scandir(); .pth files in system
  // site-packages inject ~/Projects/... and ~/Library/Python/... paths.
  // Without read access, pip crashes with PermissionError.
  // eslint-disable-next-line no-restricted-syntax -- Trusted: reading HOME for sandbox profile, no secrets
  const home = process.env.HOME ?? homedir();
  /* eslint-disable no-restricted-syntax -- Trusted: constant subpaths of daemon homedir */
  const homeReadPaths = [
    path.join(home, "Library"),
    path.join(home, "Projects"),
    path.join(home, ".local"),
    path.join(home, ".nvm"),     // nvm Node.js — npm/npx cli.js lives here
    path.join(home, ".claude"),  // claude CLI config, settings, hooks, skills
  /* eslint-enable no-restricted-syntax */
  ].filter((p) => existsSync(p)).map(resolvePath);

  // claude CLI stores auth/config at ~/.claude.json (a file at HOME root,
  // not inside ~/.claude/ directory). Without read access, `claude -p` hangs
  // indefinitely producing zero output.
  /* eslint-disable no-restricted-syntax -- Trusted: constant path of daemon homedir */
  const claudeJsonPath = path.join(home, ".claude.json");
  /* eslint-enable no-restricted-syntax */
  const claudeJsonLiteral = existsSync(claudeJsonPath) ? resolvePath(claudeJsonPath) : null;

  const readPaths = [
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/System",
    "/private/etc",
    "/private/var/db/timezone", // /usr/share/zoneinfo symlinks here; kernel resolves before sandbox check
    "/var/db/timezone",         // intermediate symlink target: /usr/share/zoneinfo → /var/db/timezone/zoneinfo
    "/opt/homebrew",
    "/usr/local",
    "/dev",
    "/private/tmp", // bash heredoc: creates temp files here, needs to read them back
    ...homeReadPaths,
    resolvePath(opts.workspacePath),
    ...opts.sharedPaths.map(resolvePath),
    ...opts.readOnlyPaths.map(resolvePath),
  ];

  // claude CLI directories that need write access:
  // ~/.claude/ — history, cache, session state, plans
  // ~/.local/share/claude/ — version data (already under ~/.local read path,
  //   but needs write for updates; covered by ~/.local in homeReadPaths for reads)
  /* eslint-disable no-restricted-syntax -- Trusted: constant subpaths of daemon homedir */
  const claudeWritePaths = [
    path.join(home, ".claude"),
    path.join(home, ".local", "share", "claude"),
  /* eslint-enable no-restricted-syntax */
  ].filter((p) => existsSync(p)).map(resolvePath);

  const writePaths = [
    resolvePath(opts.workspacePath),
    ...opts.sharedPaths.map(resolvePath),
    ...claudeWritePaths,
    "/private/tmp",
    "/private/var/folders",
  ];

  const resolvedTempDir = resolvePath(opts.tempDir);
  if (resolvedTempDir && resolvedTempDir !== "/tmp" && resolvedTempDir !== "/private/tmp") {
    writePaths.push(resolvedTempDir);
  }

  const lines = [
    "(version 1)",
    "(deny default)",
    "",
    ";; Process execution",
    "(allow process-exec)",
    "(allow process-fork)",
    "",
    ";; System operations",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    "",
    ";; Network (allow all -- network isolation is a separate concern)",
    "(allow network*)",
    "",
    ";; Path traversal: stat() on any path (type/size/perms only, not content)",
    "(allow file-read-metadata)",
    "",
    ";; Root directory read (required for path resolution on macOS)",
    '(allow file-read-data (literal "/"))',
    "",
    ";; Device writes (null, DTrace helper)",
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-write-data (literal "/dev/dtracehelper"))',
    "",
    ";; PTY/TTY device access (required for interactive tools: script, unbuffer, claude CLI)",
    ";; posix_openpt/grantpt need write on /dev/ptmx; slave needs write on /dev/ttysNNN",
    '(allow file-write* (literal "/dev/ptmx"))',
    '(allow file-write* (regex #"^/dev/ttys[0-9]+$"))',
    ";; ioctl on device files: tcgetattr/tcsetattr for terminal configuration",
    '(allow file-ioctl (subpath "/dev"))',
    "",
    ";; Read access",
    ...readPaths.map((p) => `(allow file-read* (subpath ${sbplQuote(p)}))`),
    // claude CLI auth file at HOME root (literal, not subpath)
    ...(claudeJsonLiteral ? [`(allow file-read* (literal ${sbplQuote(claudeJsonLiteral)}))`, `(allow file-write* (literal ${sbplQuote(claudeJsonLiteral)}))`] : []),
    "",
    ";; Write access",
    ...writePaths.map((p) => `(allow file-write* (subpath ${sbplQuote(p)}))`),
  ];

  return lines.join("\n");
}

export class SandboxExecProvider implements SandboxProvider {
  readonly name = "sandbox-exec";

  available(): boolean {
    try {
      execFileSync("which", ["sandbox-exec"], { encoding: "utf8" });

      // Runtime smoke test: verify sandbox-exec actually works with custom SBPL profiles.
      // On macOS Sequoia 15.3+, sandbox-exec with custom profiles silently fails
      // (exitCode 1, empty stdout/stderr). The minimal profile (allow default)
      // permits everything -- we only need to confirm sandbox-exec can execute at all.
      const out = execFileSync(
        "sandbox-exec",
        ["-p", "(version 1)(allow default)", "/bin/echo", "ok"],
        { encoding: "utf8", timeout: 3000 },
      );
      if (!out.includes("ok")) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  buildArgs(opts: SandboxOptions): string[] {
    const profile = buildSbplProfile(opts);
    return ["sandbox-exec", "-p", profile];
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
      // PYTHONNOUSERSITE is NOT set — sandbox read paths now include ~/Library
      // and ~/Projects, so pip's sys.path scanning works. Removing it lets
      // Python find packages installed to PYTHONUSERBASE.
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
