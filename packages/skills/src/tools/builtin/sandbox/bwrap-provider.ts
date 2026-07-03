// SPDX-License-Identifier: Apache-2.0
// @allow-throw: (1) exhaustiveness guard on networkMode union; unreachable at runtime, caught by TypeScript; equivalent to assertNever(). (2) screenBind() fails LOUD at jail construction on a denylisted bind — a misconfig must never be a silently-emitted hole.
/**
 * BwrapProvider -- Linux sandbox provider using Bubblewrap (bwrap).
 *
 * Generates bwrap CLI arguments that wrap child process spawns with
 * kernel-enforced filesystem isolation using user namespaces.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";

import { join } from "node:path";

import { safePath, validateBindMount } from "@comis/core";

import type {
  JailAgentCliResolution,
  JailNodeResolution,
  SandboxOptions,
  SandboxProvider,
} from "./types.js";

/**
 * Node-runtime honesty. Surfaces 2/3 (orchestrate / CLI)
 * need a `node` INSIDE the jail; there is NO bundled Node. Resolve, in order:
 *   1. PROBE — a `node` executable resolves under one of the bound RO `pathDirs`
 *      (the SYSTEM_RO_PATHS + ~/.nvm binds put one there on most hosts) → "path"
 *      (no bind needed).
 *   2. BIND — else, if the daemon's `execPath` exists, RO-bind it into the jail
 *      (precedent: the terminal-driver execPath binds) → "bind".
 *   3. UNAVAILABLE — else surfaces 2/3 cannot run jailed; the caller surfaces a
 *      loud doctor/boot signal. The hint NEVER claims a bundled Node and NEVER
 *      implies a silent unjailed fallback — either would spoof containment
 *      that does not exist. Surface 1 (in-process typed tools) still works.
 *
 * PURE: the only I/O is the injected `exists` predicate (defaults to
 * `existsSync`), so the resolver is macOS-unit-testable with a fake PATH/execPath.
 */
export function resolveJailNode(opts: {
  readonly pathDirs: readonly string[];
  readonly execPath?: string;
  /** Existence predicate (defaults to fs.existsSync) — injected for unit tests. */
  readonly exists?: (p: string) => boolean;
}): JailNodeResolution {
  const exists = opts.exists ?? existsSync;

  // 1. PROBE the bound RO PATH dirs for a node executable.
  for (const dir of opts.pathDirs) {
    if (exists(join(dir, "node"))) {
      return { mode: "path" };
    }
  }

  // 2. BIND the daemon's own node binary when it is present on disk.
  if (opts.execPath && exists(opts.execPath)) {
    return { mode: "bind", execPath: opts.execPath };
  }

  // 3. UNAVAILABLE — honest degrade. NEVER a bundled-Node claim.
  return {
    mode: "unavailable",
    hint:
      "Surfaces 2/3 (orchestrate/CLI) need node inside the jail; none found on the " +
      "jail PATH and process.execPath was not bindable — these surfaces are " +
      "UNAVAILABLE (surface 1 still works). Install node or ensure the daemon node " +
      "binary is bindable. There is NEVER a bundled Node and NEVER a silent " +
      "unjailed fallback.",
  };
}

/**
 * comis-agent CLI-binary honesty. The `comis-agent` CLI surface
 * needs its `#!/usr/bin/env node` entry (`comis-agent-entry.js`) bound into the
 * jail, sha256-PINNED against the committed build manifest so a swapped/modified
 * (tampered) binary is never bound. Resolve in two honest modes:
 *   1. BIND — the entry exists AND its sha256 matches `expectedSha` (the manifest
 *      pin) → RO-bind it (src==dest, so COMIS_AGENT_BIN/PATH resolves it in-jail).
 *   2. UNAVAILABLE — the entry is MISSING, or present but its bytes do NOT match
 *      the pin (tamper) → the CLI surface is UNAVAILABLE with a LOUD, content-free
 *      hint. The caller (orchestrate-tool) degrades ONLY the CLI surface
 *      — the orchestrate SCRIPT surface still runs (unlike resolveJailNode, an
 *      unavailable comis-agent binary does NOT refuse the whole jail).
 *
 * Content-free: the hint names the CAUSE (missing | hash-mismatch) and the
 * operator action — it NEVER echoes the expected hash or the binary bytes.
 *
 * PURE: the only I/O is the injected `exists` predicate (defaults to existsSync)
 * and `readFile` (defaults to readFileSync), so the resolver is macOS-unit-
 * testable with a fake binary + a fake hash — no real fs, no real binary.
 */
export function resolveJailAgentCli(opts: {
  /** The resolved comis-agent-entry.js path to bind. */
  readonly binPath: string;
  /** The committed manifest sha256 pin (lowercase hex) the bytes must match. */
  readonly expectedSha: string;
  /** Existence predicate (defaults to fs.existsSync) — injected for unit tests. */
  readonly exists?: (p: string) => boolean;
  /** File reader (defaults to fs.readFileSync) — injected for unit tests. */
  readonly readFile?: (p: string) => Buffer;
}): JailAgentCliResolution {
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? readFileSync;

  // 1. MISSING — the binary is not on disk. The CLI surface is unavailable; the
  //    orchestrate SCRIPT surface is independent and still runs.
  if (!exists(opts.binPath)) {
    return {
      mode: "unavailable",
      hint:
        "The comis-agent CLI binary was not found where it is expected in the " +
        "skills dist — the comis-agent CLI surface is UNAVAILABLE inside the jail " +
        "(the orchestrate SCRIPT surface still works). Rebuild (pnpm build) so the " +
        "comis-agent entry rides into dist. There is NEVER a silent unbound CLI.",
    };
  }

  // 2. HASH MISMATCH (tamper) — present but its bytes diverge from the manifest
  //    pin. REFUSE to bind a tampered binary; the CLI surface is
  //    unavailable. The hint NEVER echoes the hash or the bytes (content-free).
  const actualSha = createHash("sha256").update(readFile(opts.binPath)).digest("hex");
  if (actualSha !== opts.expectedSha) {
    return {
      mode: "unavailable",
      hint:
        "The comis-agent CLI binary's sha256 does NOT match the committed build " +
        "manifest — refusing to bind a tampered/mismatched binary (the comis-agent " +
        "CLI surface is UNAVAILABLE; the orchestrate SCRIPT surface still works). " +
        "Rebuild and regenerate the manifest (pnpm build && pnpm agent-cli:manifest).",
    };
  }

  // 3. BIND — exists AND the bytes match the pin. RO-bind it (read-only — a
  //    writable binary is a host-RCE vector).
  return { mode: "bind", binPath: opts.binPath };
}

/**
 * Screen a caller-controlled host bind path through the credential-denylist
 * backstop (validateBindMount) before it is emitted as a `--bind`/`--ro-bind`.
 *
 * Scope (the validator is a DENYLIST BACKSTOP on the ALLOW-LIST
 * binds, NOT the primary boundary): this screens the DYNAMIC, caller/agent-supplied
 * binds — the workspace, the temp dir, operator/graph shared paths, and skill
 * discovery read-only paths — which are the attack surface (an agent/operator
 * could supply `~/.ssh` or `/etc`). Intentionally NOT screened:
 *   - The CURATED system allow-lists (SYSTEM_RO_PATHS, getUserRoPaths,
 *     getDevToolRwPaths) — the vetted boundary itself (they include
 *     `/etc/resolv.conf` etc. the denylist would false-positive on).
 *   - The broker / cap unix sockets — DAEMON-MINTED per-run paths the agent
 *     cannot influence (conventionally under `/run/comis`, which the denylist
 *     refuses for caller binds); they are part of the trusted allow-list.
 *
 * A denylisted bind is a MISCONFIG that must FAIL LOUD — never a silently-emitted
 * hole. Throws at jail construction (this provider already carries the
 * file-level `@allow-throw` exhaustiveness annotation).
 */
function screenBind(hostPath: string, home: string): void {
  const verdict = validateBindMount(hostPath, home);
  if (!verdict.ok) {
    throw new Error(`refusing unsafe jail bind: ${hostPath} — ${verdict.reason}`);
  }
}

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
    // Self-prime the bwrap binary path (symmetry with getSystemPaths()'s lazy
    // resolvedSysPaths). Callers that build args on a fresh provider without
    // first calling available() — e.g. the orchestrate jail, which constructs a
    // new BwrapProvider() per run (orchestrate-jail.linux.test.ts:156) — would
    // otherwise get `[null, …]` and explode opaquely as `spawn(null)` →
    // `TypeError: The "file" argument must be of type string. Received null`
    // deep in node:child_process (the #236 orchestrate-jail.linux suite). In
    // production the shared provider is already primed at boot (detect-provider),
    // so this is a no-op there; available() caches bwrapPath. Deliberately does
    // NOT throw when bwrap is absent: the daemon gates orchestrate on provider
    // availability, and the macOS unit suite builds args with a fake spawn on a
    // bwrap-less host — failing here would break that legitimate arg-shape path.
    if (this.bwrapPath === null) {
      this.available();
    }
    const args: string[] = [this.bwrapPath!];
    // The credential-denylist base (`validateBindMount(hostPath, home)`)
    // must be an EXPLICIT trusted value, not a hidden ambient read inside this
    // pure arg generator. Prefer the caller-supplied `opts.home` (resolved once
    // from trusted config); fall back to `os.homedir()` only when omitted, so
    // existing callers are unaffected and the ambient read is a documented
    // default rather than an implicit coupling. With `opts.home` supplied the
    // generator is deterministic (the screen-vs-bind interaction is unit-testable
    // without mocking process env), matching the purity discipline the rest of
    // the bind-screening surface (getUserRoPaths(home), validateBindMount(_, home))
    // already follows.
    const home = opts.home ?? os.homedir();

    // -- System paths (read-only, cached at first call) --
    // CURATED allow-list — the vetted boundary itself; NOT screened by the
    // credential-denylist backstop (it would false-positive on /etc/resolv.conf).
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
      screenBind(opts.tempDir, home); // caller-controlled → screened.
      args.push("--bind", opts.tempDir, opts.tempDir);
    }

    // -- Workspace (read-write) --
    screenBind(opts.workspacePath, home); // caller-controlled → screened.
    args.push("--bind", opts.workspacePath, opts.workspacePath);

    // -- Shared paths (read-write) --
    for (const sp of opts.sharedPaths) {
      screenBind(sp, home); // operator/graph-supplied → screened.
      args.push("--bind", sp, sp);
    }

    // -- User config paths (read-only) --
    // CURATED allow-list (~/.gitconfig, ~/.config/git, ~/.local, ~/.nvm) — the
    // vetted boundary; NOT screened (~/.config is denylisted for CALLER binds but
    // this curated entry is intentional and scoped).
    for (const up of getUserRoPaths(home)) {
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
    const localSharePath = safePath(home, ".local", "share");
    for (const dp of getDevToolRwPaths(home)) {
      if (opts.secureCredentialHome && dp === localSharePath) continue;
      args.push("--bind", dp, dp);
    }

    // -- Read-only paths (discovery paths, custom) --
    for (const ro of opts.readOnlyPaths) {
      if (existsSync(ro)) {
        screenBind(ro, home); // discovery/operator-supplied → screened.
        args.push("--ro-bind", ro, ro);
      }
    }

    // -- Node runtime --
    // When the resolved Node mode is "bind", RO-bind the daemon's node binary so
    // surfaces 2/3 (orchestrate/CLI) have a node inside the jail. READ-ONLY only
    // — a writable interpreter binary is a host-RCE vector. "path" (node already
    // resolves on the jail PATH) and "unavailable" (caller surfaces a loud
    // doctor/boot signal) emit no execPath bind. The mode is a RESOLVED INPUT
    // (resolveJailNode), never a live fs probe inside this pure arg generator.
    if (opts.jailNode?.mode === "bind") {
      args.push("--ro-bind", opts.jailNode.execPath, opts.jailNode.execPath);
    }

    // -- comis-agent CLI binary --
    // When the resolved CLI mode is "bind", RO-bind the sha256-pinned comis-agent
    // entry so the in-jail `comis-agent` CLI resolves (the caller sets
    // COMIS_AGENT_BIN to this same path). READ-ONLY only — a writable binary is a
    // host-RCE vector (the .linux hardening suite proves a write to it from the
    // jail fails). src==dest so COMIS_AGENT_BIN/PATH resolves it in-jail. The mode is a
    // RESOLVED INPUT (resolveJailAgentCli — hash-verified), never a live fs probe.
    // "unavailable" (missing/tampered) emits NO bind — the caller degrades ONLY
    // the CLI surface (the script surface is unaffected).
    if (opts.jailAgentCli?.mode === "bind") {
      args.push("--ro-bind", opts.jailAgentCli.binPath, opts.jailAgentCli.binPath);
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
      // NOT screened: the broker socket is a DAEMON-MINTED per-run path (the
      // agent cannot influence it), conventionally under /run/comis — exactly a
      // path the denylist backstop refuses for CALLER binds. It is part of the
      // trusted allow-list, not the agent-supplied attack surface.
      args.push("--bind", brokerSocketPath, brokerSocketPath);
    } else if (networkMode === "none") {
      // none: kernel-enforced deny-all egress — --unshare-all already dropped the
      // netns; we simply do NOT re-share it (no --share-net, no socket, no proxy).
      // The skill-validation jail uses this so a synthesized script cannot reach
      // the network during dynamic validation.
      args.push("--unshare-net");
    } else if (networkMode === "cap-socket") {
      // cap-socket: kernel-enforced network namespace;
      // the capability-lease loopback endpoint's 0600 unix socket is reachable
      // via bind-mount only. Mirrors broker-only arg-order EXACTLY — --unshare-net
      // FIRST, then the socket --bind — because a netns affects IP sockets only,
      // so the bound unix path stays reachable while all general IP egress is cut.
      args.push("--unshare-net");
      const { capSocketPath } = opts.network as { mode: "cap-socket"; capSocketPath: string };
      // NOT screened: like the broker socket, the cap socket is a DAEMON-MINTED
      // per-run path (conventionally /run/comis or the data dir) — part of the
      // trusted allow-list, not the agent-supplied attack surface the denylist
      // backstop guards. The endpoint chooses this path, not the agent.
      args.push("--bind", capSocketPath, capSocketPath);
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

    // -- Seccomp profile --
    // bwrap --seccomp takes an FD to raw BPF bytecode (resolved by the caller via
    // loadSeccompProfileFd(); buildArgs stays a pure arg generator). Emit ONLY
    // when an fd is provided — a null/absent blob degrades to NO --seccomp (the
    // other hardening controls above still apply). The .linux.test.ts proves the blob
    // actually blocks the dangerous syscalls on the VPS.
    if (typeof opts.seccompFd === "number") {
      args.push("--seccomp", String(opts.seccompFd));
    }

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
