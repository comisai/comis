// SPDX-License-Identifier: Apache-2.0
// @allow-throw: exhaustiveness guard on networkMode union; unreachable at runtime, caught by TypeScript; equivalent to assertNever().
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

import { safePath } from "@comis/core";

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
 *
 * @param home - User home directory path.
 */
function getUserRoPaths(home: string): string[] {
  return [
    safePath(home, ".gitconfig"),
    safePath(home, ".config", "git"),
    // pip/uv: .pth files in system site-packages inject custom paths into
    // sys.path. pip scans all sys.path via os.scandir(); without read access
    // it crashes with PermissionError.
    safePath(home, ".local"),
    // nvm Node.js — npm/npx need to read their cli.js source files
    safePath(home, ".nvm"),
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
  return [
    safePath(home, ".npm"),
    safePath(home, ".cache"),
    safePath(home, ".local", "share"),
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

    // -- Dev tool RW paths (read-write) --
    // MUST come after getUserRoPaths above so the RW bind for ~/.local/share
    // overrides the RO bind for ~/.local. MUST come before the discovery
    // readOnlyPaths loop below so caller-supplied RO can't shadow these.
    // Mirror of systemd ReadWritePaths in comis.service.template.
    //
    // When secureCredentialHome is true, skip
    // ~/.local/share entirely — a RW bind over this parent directory would
    // expose any credential material living under it (e.g. a stray
    // ~/.local/share/<cli> auth dir) to the sandbox. Skipping the ~/.local/share
    // bind is the safest correct option; dev tools can still use
    // workspace-redirected paths from wrapEnv() (XDG_DATA_HOME, UV_TOOL_DIR,
    // PIPX_HOME, etc.).
    const localSharePath = safePath(os.homedir(), ".local", "share");
    for (const dp of getDevToolRwPaths(os.homedir())) {
      if (opts.secureCredentialHome && dp === localSharePath) continue;
      args.push("--bind", dp, dp);
    }

    // -- Read-only paths (discovery paths, custom) --
    for (const ro of opts.readOnlyPaths) {
      if (existsSync(ro)) {
        args.push("--ro-bind", ro, ro);
      }
    }

    // -- Isolation flags --
    const networkMode = opts.network?.mode ?? "open";
    args.push("--unshare-all");
    if (networkMode === "open") {
      args.push("--share-net");
    } else if (networkMode === "broker-only") {
      // broker-only: kernel-enforced network namespace; broker reachable via
      // bind-mounted unix socket only. No general internet egress.
      args.push("--unshare-net");
      const { brokerSocketPath } = opts.network as { mode: "broker-only"; brokerSocketPath: string };
      args.push("--bind", brokerSocketPath, brokerSocketPath);
    } else if (networkMode === "none") {
      // none: kernel-enforced deny-all egress — --unshare-all already dropped the
      // netns; we simply do NOT re-share it (no --share-net, no socket, no proxy).
      // The skill-validation jail uses this so a synthesized script cannot reach
      // the network during dynamic validation (T-201-35).
      args.push("--unshare-net");
    } else {
      // exhaustiveness guard — TypeScript will flag this if the
      // SandboxOptions.network union gains a new member without updating here.
      const _exhaustive: never = networkMode;
      throw new Error(`Unhandled network mode: ${String(_exhaustive)}`);
    }
    args.push(
      "--die-with-parent",
      "--new-session",
    );

    // -- Working directory --
    args.push("--chdir", opts.cwd);

    return args;
  }

  wrapEnv(env: Record<string, string>, workspacePath: string): Record<string, string> {
    const cacheDir = safePath(workspacePath, ".cache");

    // Workspace-rooted bin dirs that hold CLIs installed by sandboxed package
    // managers. Prepended to PATH so a binary installed by `cargo install <crate>`
    // (or pipx, go install, bun add -g, deno install, pnpm add -g) on one exec
    // call is invocable on the NEXT exec call. Ordering: highest-frequency first.
    const toolBinPaths = [
      safePath(workspacePath, ".local", "bin"),  // PYTHONUSERBASE/bin + PIPX_BIN_DIR
      safePath(cacheDir, "cargo", "bin"),         // cargo install
      safePath(cacheDir, "go", "bin"),            // go install
      safePath(cacheDir, "bun", "bin"),           // bun add -g
      safePath(cacheDir, "pnpm"),                 // pnpm global (PNPM_HOME itself is the bin dir)
      safePath(cacheDir, "deno", "bin"),          // deno install
    ];

    return {
      ...env,
      // Temp files: heredocs, wheel builds, etc.
      TMPDIR: safePath(workspacePath, ".comis-tmp"),
      // Package manager caches
      NPM_CONFIG_CACHE: safePath(cacheDir, "npm"),
      PIP_CACHE_DIR: safePath(cacheDir, "pip"),

      XDG_CACHE_HOME: cacheDir,
      // XDG_STATE_HOME (~/.local/state by default): pipx logs, some Python
      // tools, runtime state. The ~/.local parent bind is RO (getUserRoPaths)
      // and getDevToolRwPaths only carves out ~/.local/share, so anything
      // defaulting to ~/.local/state would EROFS without this redirect.
      // pipx happens to survive (PIPX_HOME captures all pipx state) but other
      // XDG-state-using tools would not. Defensive belt-and-suspenders matching
      // the existing XDG_CACHE_HOME pattern.
      XDG_STATE_HOME: safePath(workspacePath, ".local", "state"),
      // Python: redirect user packages into workspace.
      // PYTHONNOUSERSITE is NOT set — sandbox read paths cover dirs that
      // pip needs to scan. Removing it lets Python find packages installed
      // to PYTHONUSERBASE.
      PYTHONUSERBASE: safePath(workspacePath, ".local"),
      MPLCONFIGDIR: safePath(cacheDir, "matplotlib"),
      // Force non-interactive backend — prevents plt.show() from opening GUI and blocking
      MPLBACKEND: "Agg",
      // uv: redirect managed Python installs into workspace
      UV_PYTHON_INSTALL_DIR: safePath(cacheDir, "uv", "python"),
      // Rust
      CARGO_HOME: safePath(cacheDir, "cargo"),
      // Go
      GOPATH: safePath(cacheDir, "go"),
      GOMODCACHE: safePath(cacheDir, "go", "pkg", "mod"),
      // Ruby
      GEM_HOME: safePath(cacheDir, "gems"),
      BUNDLE_PATH: safePath(cacheDir, "bundle"),
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
      UV_TOOL_DIR: safePath(cacheDir, "uv", "tools"),
      // pipx: venvs root + bin dir. PIPX_BIN_DIR aligns with PYTHONUSERBASE/bin
      // (PYTHONUSERBASE = workspace/.local) so user-installed and pipx-installed
      // CLIs share a single PATH entry: workspace/.local/bin.
      PIPX_HOME: safePath(cacheDir, "pipx"),
      PIPX_BIN_DIR: safePath(workspacePath, ".local", "bin"),
      // pnpm global store + bin dir (PNPM_HOME is on PATH below).
      PNPM_HOME: safePath(cacheDir, "pnpm"),
      // bun: install root; binaries land in $BUN_INSTALL/bin.
      BUN_INSTALL: safePath(cacheDir, "bun"),
      // deno: cache + installed CLI dir ($DENO_DIR/bin via `deno install`).
      DENO_DIR: safePath(cacheDir, "deno"),
      // yarn cache; mirrors the others for completeness even though yarn is rare in agent flows.
      YARN_CACHE_FOLDER: safePath(cacheDir, "yarn"),

      // PATH augmentation MUST come after the spread above so it overrides
      // any PATH carried in `env`. Inherited PATH is split-and-filtered
      // to drop empty segments (leading/trailing/consecutive colons in
      // env.PATH expand to "." entries on Unix -- a security smell because
      // a sandboxed exec then resolves binaries from the workspace CWD
      // before $PATH dirs). filter(Boolean).join(":") at the top level is
      // not enough: it only handles `env.PATH ?? ""` being the empty
      // string; an inherited PATH of ":foo:bar" or "foo::bar" survives
      // the filter as a single non-empty segment and reintroduces the
      // empty entry after the final join.
      PATH: [
        ...toolBinPaths,
        ...(env.PATH ?? "").split(":").filter((p) => p.length > 0),
      ].join(":"),
    };
  }
}
