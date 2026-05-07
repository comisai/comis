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
 *
 * Exported so the bwrap smoke test in detect-provider.ts consumes the
 * same list — drift between smoke and production binds caused a real
 * false-negative on usrmerge x86-64 hosts (smoke test missed /lib64
 * → /bin/true's dynamic linker unreachable → smoke EPERMs while the
 * production sandbox actually works fine).
 */
export const SYSTEM_RO_PATHS = [
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
  // fontconfig config (font.conf, conf.d/). Without this, libfontconfig prints
  // "Cannot load default config file" to stderr on every text-rendering call
  // (matplotlib, Pango, Pillow TTF, ImageMagick, headless Chromium, weasyprint,
  // ffmpeg drawtext, LibreOffice headless) and falls back to a minimal compiled-in
  // config — which silently breaks the substitution chain for non-Latin scripts
  // (CJK/Arabic/devanagari render as Tofu boxes even when the fonts are present
  // under /usr/share/fonts). Per-user cache lives in XDG_CACHE_HOME/fontconfig,
  // which is already RW via the workspace .cache bind in wrapEnv().
  "/etc/fonts",
] as const;

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

/**
 * Per-user XDG paths that need read-write access for language package managers.
 *
 * These paths MUST match the systemd ReadWritePaths in
 * packages/daemon/systemd/comis.service.template. Without RW access here,
 * package managers writing to standard XDG paths (npm, uv, pipx, cargo, go,
 * deno, bun) fail with EROFS at the bwrap mount layer even when the outer
 * systemd sandbox permits the write.
 *
 * Why these specific paths:
 * - ~/.npm     -- npm/npx default cache + global modules root.
 * - ~/.cache   -- XDG_CACHE_HOME default; uv archives, deno cache, bun cache,
 *                pip wheel cache, cargo registry cache, go module cache.
 *                wrapEnv() also redirects most caches into the workspace, but
 *                some tools (e.g. uv's archive cache) still touch ~/.cache
 *                during early bootstrap before env vars take effect.
 * - ~/.local/share -- XDG_DATA_HOME default; uvx tool installs, pipx venvs,
 *                    rustup toolchains, generic XDG_DATA consumers.
 *
 * Note: this returns a subset of paths bound RO by getUserRoPaths
 * (specifically ~/.local). The RW bind is emitted AFTER the RO bind in
 * buildArgs, which causes bwrap to apply the more-permissive RW mount on
 * top of the RO mount for the ~/.local/share subpath. ~/.local itself
 * remains RO; only ~/.local/share becomes RW.
 */
function getDevToolRwPaths(home: string): string[] {
  /* eslint-disable no-restricted-syntax -- Trusted: constant subpaths of homedir, no user input */
  return [
    path.join(home, ".npm"),
    path.join(home, ".cache"),
    path.join(home, ".local", "share"),
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

    // -- Dev tool RW paths (read-write) --
    // MUST come after getUserRoPaths above so the RW bind for ~/.local/share
    // overrides the RO bind for ~/.local. MUST come before the discovery
    // readOnlyPaths loop below so caller-supplied RO can't shadow these.
    // Mirror of systemd ReadWritePaths in comis.service.template.
    for (const dp of getDevToolRwPaths(os.homedir())) {
      args.push("--bind", dp, dp);
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

    // Workspace-rooted bin dirs that hold CLIs installed by sandboxed package
    // managers. Prepended to PATH so a binary installed by `cargo install <crate>`
    // (or pipx, go install, bun add -g, deno install, pnpm add -g) on one exec
    // call is invocable on the NEXT exec call. Ordering: highest-frequency first.
    const toolBinPaths = [
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      path.join(workspacePath, ".local", "bin"),  // PYTHONUSERBASE/bin + PIPX_BIN_DIR
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      path.join(cacheDir, "cargo", "bin"),         // cargo install
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      path.join(cacheDir, "go", "bin"),            // go install
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      path.join(cacheDir, "bun", "bin"),           // bun add -g
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      path.join(cacheDir, "pnpm"),                 // pnpm global (PNPM_HOME itself is the bin dir)
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      path.join(cacheDir, "deno", "bin"),          // deno install
    ];

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
      // XDG_STATE_HOME (~/.local/state by default): pipx logs, some Python
      // tools, runtime state. The ~/.local parent bind is RO (getUserRoPaths)
      // and getDevToolRwPaths only carves out ~/.local/share, so anything
      // defaulting to ~/.local/state would EROFS without this redirect.
      // pipx happens to survive (PIPX_HOME captures all pipx state) but other
      // XDG-state-using tools would not. Defensive belt-and-suspenders matching
      // the existing XDG_CACHE_HOME pattern.
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      XDG_STATE_HOME: path.join(workspacePath, ".local", "state"),
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
      // Rust: rustup multiplexer needs RUSTUP_HOME to locate the toolchain.
      // Pointed at the system rustup install (written by install.sh's
      // install_rust at /usr/local/rustup). A workspace-rooted RUSTUP_HOME
      // would be empty on first call, breaking `cargo install <crate>` with
      // "rustup could not choose a version of cargo to run, because no default
      // is configured" — confirmed on a real VPS during the dev-sandbox matrix
      // test. CARGO_HOME stays workspace-rooted (above) so `cargo install`
      // outputs land in <workspace>/.cache/cargo/bin and survive.
      // Tradeoff: agent loses the ability to `rustup install <toolchain>` from
      // inside exec (would need RW to /usr/local/rustup). Acceptable — the
      // canonical use case is `cargo install <crate>`, which works.
      RUSTUP_HOME: "/usr/local/rustup",
      // uv: tool install dir for `uvx` / `uv tool install` (paired with UV_PYTHON_INSTALL_DIR above).
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      UV_TOOL_DIR: path.join(cacheDir, "uv", "tools"),
      // pipx: venvs root + bin dir. PIPX_BIN_DIR aligns with PYTHONUSERBASE/bin
      // (PYTHONUSERBASE = workspace/.local) so user-installed and pipx-installed
      // CLIs share a single PATH entry: workspace/.local/bin.
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      PIPX_HOME: path.join(cacheDir, "pipx"),
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      PIPX_BIN_DIR: path.join(workspacePath, ".local", "bin"),
      // pnpm global store + bin dir (PNPM_HOME is on PATH below).
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      PNPM_HOME: path.join(cacheDir, "pnpm"),
      // bun: install root; binaries land in $BUN_INSTALL/bin.
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      BUN_INSTALL: path.join(cacheDir, "bun"),
      // deno: cache + installed CLI dir ($DENO_DIR/bin via `deno install`).
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      DENO_DIR: path.join(cacheDir, "deno"),
      // yarn cache; mirrors the others for completeness even though yarn is rare in agent flows.
      // eslint-disable-next-line no-restricted-syntax -- Trusted: workspace path is daemon-controlled, constant subpaths
      YARN_CACHE_FOLDER: path.join(cacheDir, "yarn"),

      // PATH augmentation MUST come after the spread above so it overrides
      // any PATH carried in `env`. Empty entries are filtered to avoid
      // trailing/duplicate colons when env.PATH is undefined.
      PATH: [...toolBinPaths, env.PATH ?? ""].filter(Boolean).join(":"),
    };
  }
}
