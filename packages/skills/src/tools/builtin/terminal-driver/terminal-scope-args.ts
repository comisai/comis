// SPDX-License-Identifier: Apache-2.0
// @allow-throw: exhaustiveness guards on the filesystem + network unions; unreachable at runtime, caught by TypeScript; equivalent to assertNever().
/**
 * buildScopeArgs -- materialize a {@link TerminalScope} into the exact bwrap argv
 * (filesystem/network/uid + credentialHome + the ~/.comis carve-out).
 *
 * This is THE central scope -> jail mapping. It is MODELED on
 * `BwrapProvider.buildArgs` (`sandbox/bwrap-provider.ts:140-224`) but is a
 * SEPARATE composer: that method is hardwired to the daemon-exec profile (it
 * binds the daemon's HOME dotfiles `~/.gitconfig`/`~/.local`/`~/.nvm`
 * unconditionally, `:168,186`) and is shared with the exec path; adding
 * terminal-scope branches there would couple two trust models and risk an exec
 * regression. This composer REUSES `SYSTEM_RO_PATHS` verbatim for the RO base and
 * emits the net-new `--uid`/`--gid` (proven on the VPS) + the
 * always-on carve-out.
 *
 * It is a PURE function (no `os`/`fs` side effects — `home`/`dataDir`/the resolved
 * `systemRoPaths` are injected), so the full scope->argv matrix is macOS-testable
 * WITHOUT spawning bwrap (the `bwrap-secure-profile.test.ts` idiom). The actual
 * jail enforcement is the VPS suite, which builds the argv via THIS
 * composer so the test proves the real mapping.
 *
 * Returns `[bwrapPath, ...args, "--"]`; the caller appends `bin, ...argv`
 * (`pty.spawn(scopeArgs[0], [...scopeArgs.slice(1), bin, ...argv])`).
 *
 * @module
 */

import { SYSTEM_RO_PATHS } from "../sandbox/bwrap-provider.js";

import type { TerminalScope } from "./allowlist-matcher.js";

// Re-export so consumers can `import { SYSTEM_RO_PATHS } from "./terminal-scope-args.js"`
// alongside the composer — but the composer itself uses it as the RO base by default.
export { SYSTEM_RO_PATHS };

/**
 * The composer input: the scope plus its jail companions (workspace/cwd/home/
 * dataDir/the resolved system RO set) and the two net-new dimensions
 * (dedicatedUid + the egress relay socket).
 */
export interface ScopeArgsInput {
  /** The operator-declared scope — sourced only from `matched.entry`. */
  scope: TerminalScope;
  /** The resolved bwrap binary path (from the provider). */
  bwrapPath: string;
  /** The session workspace — always `--bind` RW. */
  workspace: string;
  /** The `--chdir` target. */
  cwd: string;
  /** Injected `os.homedir()` — TESTABLE (the home bind + the ~/.claude/.comis roots). */
  home: string;
  /** The carve-out target — `os.homedir()/.comis` (non-configurable). */
  dataDir: string;
  /** `SYSTEM_RO_PATHS`, filtered to existing by the caller (the provider resolves them once). */
  systemRoPaths: readonly string[];
  /** The net-new uid/gid (e.g. `{uid:65534,gid:65534}` = nobody) when `scope.uid === "dedicated"`. */
  dedicatedUid?: { uid: number; gid: number };
  /** The egress relay socket to bind-mount — present ONLY when `scope.network === "listed-hosts"`. */
  relaySocketPath?: string;
  /**
   * The on-disk relay-as-init SCRIPT the in-jail `node` execs — RO-bound into the
   * jail so node can READ it (the worker spawns `bwrap [scope] -- node <this> -- bin`).
   * Present ONLY for `scope.network === "listed-hosts"` (supplied by `buildSpawnPlan`
   * from `buildEgressRelayLaunch().relayInitScriptPath`). The file exists on the HOST
   * but is NOT covered by SYSTEM_RO_PATHS or the workspace bind, so without this
   * `--ro-bind` the jail dies with `Cannot find module …/egress-relay-init.js`
   * (the last VPS scope-matrix egress-cell failure). none/full never run the
   * relay, so this is unset for them.
   */
  relayInitScriptPath?: string;
}

/** Push a `--proc /proc`, `--dev /dev`, `--dev-bind /dev/pts`, `--tmpfs /tmp` block. */
function pushSpecialFs(args: string[]): void {
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--dev-bind", "/dev/pts", "/dev/pts"); // PTY slave devices (the controlling tty)
  args.push("--tmpfs", "/tmp");
}

/**
 * Emit the filesystem binds for the scope's `filesystem` dimension.
 *
 * For `full`, after the broad host bind RE-EMIT the special filesystems
 * (`pushSpecialFs`) so the root bind cannot clobber `--proc`/`--dev`/`/tmp`.
 * The `~/.comis` carve-out is appended by the CALLER as the
 * very last mount so it wins even over `--bind / /`.
 */
function pushFilesystemBinds(args: string[], input: ScopeArgsInput): void {
  const { scope, workspace, home } = input;
  // The workspace is ALWAYS bound RW (the session's working dir).
  args.push("--bind", workspace, workspace);

  switch (scope.filesystem) {
    case "workspace":
      // workspace-only (+ the system RO base). Do NOT bind dotfiles — that is the
      // exec profile (bwrap-provider.ts:168,186), a different trust model.
      break;
    case "listed-paths":
      for (const p of scope.paths ?? []) {
        args.push("--bind", p, p);
      }
      break;
    case "home":
      args.push("--bind", home, home);
      break;
    case "full":
      // Broad host fs. `--bind / /` exposes everything incl. /proc, /dev, /tmp —
      // so re-emit the special filesystems AFTER so the root bind cannot shadow
      // them, and the caller appends the ~/.comis carve-out LAST.
      args.push("--bind", "/", "/");
      pushSpecialFs(args);
      break;
    default: {
      const _exhaustive: never = scope.filesystem;
      throw new Error(`Unhandled filesystem scope: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Emit the network flag for the scope's `network` dimension.
 *
 * - `none` (default) -> `--unshare-net` (kernel-enforced netns, NO socket, NO proxy).
 * - `listed-hosts` -> `--unshare-net` + `--bind <relaySocketPath>` (the egress
 *   proxy socket) + `--ro-bind <relayInitScriptPath>` (the in-jail relay-as-init
 *   script node execs — it must be readable INSIDE the jail; the relay launch).
 *   Mirrors the exec `broker-only` socket bind, but the socket is the egress proxy,
 *   not a broker. WITHOUT the script ro-bind the jail dies `Cannot find module
 *   …/egress-relay-init.js` (the file is on the HOST but unbound).
 * - `full` -> `--share-net` (host network, no proxy).
 */
function pushNetwork(args: string[], input: ScopeArgsInput): void {
  switch (input.scope.network) {
    case "none":
      args.push("--unshare-net");
      break;
    case "listed-hosts":
      args.push("--unshare-net");
      if (input.relaySocketPath !== undefined) {
        args.push("--bind", input.relaySocketPath, input.relaySocketPath);
      }
      // The in-jail relay-as-init script must be READABLE inside the jail (in-jail
      // node execs it). Bind it RO at the same host path. Only for listed-hosts —
      // none/full never spawn the relay (the VPS Cannot-find-module fix).
      if (input.relayInitScriptPath !== undefined) {
        args.push("--ro-bind", input.relayInitScriptPath, input.relayInitScriptPath);
      }
      break;
    case "full":
      args.push("--share-net");
      break;
    default: {
      const _exhaustive: never = input.scope.network;
      throw new Error(`Unhandled network scope: ${String(_exhaustive)}`);
    }
  }
}

/**
 * True when `child` is a STRICT subpath of `parent` (segment-aware via a trailing
 * separator, so `/a/.comis-evil` is NOT under `/a/.comis`). Deliberately false when
 * `child === parent`: re-binding the data dir onto ITSELF would re-expose the
 * secrets the carve-out exists to mask, so only a NESTED workspace is re-exposed.
 */
function isUnderDir(child: string, parent: string): boolean {
  const withSep = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(withSep);
}

/**
 * Build the bwrap argv for a {@link TerminalScope}, in the canonical order:
 *
 *   [bwrapPath, ...systemRO(--ro-bind p p), --proc, --dev, --dev-bind /dev/pts,
 *    --tmpfs /tmp, <FS binds>, <credentialHome ro-bind>, <uid>,
 *    --unshare-all, <network>, --die-with-parent, --new-session, --chdir <cwd>,
 *    <CARVE-OUT --tmpfs <dataDir>>, <workspace re-bind if under dataDir>, --]
 *
 * `--unshare-all` already supplies `--unshare-pid` + `--unshare-user` + ipc/uts/
 * cgroup — no separate `--unshare-pid`. `--new-session` is emitted
 * explicitly for the controlling tty. The `<network>` refinement comes AFTER
 * `--unshare-all` — bwrap mutates its unshare set per flag IN ARG ORDER, so a
 * `--share-net` emitted before the unshare-all would be re-clobbered and the
 * jail would get NO network even at `network:"full"` (the live-VPS T5 bug).
 */
export function buildScopeArgs(input: ScopeArgsInput): string[] {
  const args: string[] = [input.bwrapPath];

  // -- System paths (read-only, reused verbatim from BwrapProvider) --
  for (const sysPath of input.systemRoPaths) {
    args.push("--ro-bind", sysPath, sysPath);
  }

  // -- Special filesystems --
  pushSpecialFs(args);

  // -- Filesystem binds (the scope.filesystem dimension; workspace always bound) --
  pushFilesystemBinds(args, input);

  // -- credentialHome: bind ~/.claude RO only when the operator opts in --
  if (input.scope.credentialHome === "include") {
    const claudeDir = `${input.home}/.claude`;
    args.push("--ro-bind", claudeDir, claudeDir);
  }

  // -- uid: a net-new uid != the daemon at the default (dedicated) --
  if (input.scope.uid === "dedicated" && input.dedicatedUid !== undefined) {
    args.push("--uid", String(input.dedicatedUid.uid));
    args.push("--gid", String(input.dedicatedUid.gid));
  }

  // -- Isolation flags (--unshare-all => --unshare-pid/--unshare-user + ipc/uts/cgroup) --
  args.push("--unshare-all");

  // -- Network (the scope.network dimension) — MUST come AFTER --unshare-all --
  //    bwrap processes namespace flags SEQUENTIALLY (each mutates the unshare set in
  //    arg order), so a `--share-net` emitted BEFORE `--unshare-all` is re-clobbered
  //    by the later unshare-all and the jail gets NO network even at network:"full"
  //    (proven live on the VPS: curl 000 vs 404 by flag order alone). Emitting the
  //    network refinement after the namespace base makes `--share-net` retain the
  //    host netns; the `none`/`listed-hosts` `--unshare-net` is order-insensitive
  //    (unshare twice = unshare) but rides here for one coherent rule.
  pushNetwork(args, input);

  args.push("--die-with-parent");
  args.push("--new-session"); // controlling tty

  // -- Working directory --
  args.push("--chdir", input.cwd);

  // -- The ~/.comis carve-out LAST -- later bwrap mount wins (the bind-order
  //    insight); even at filesystem:full (--bind / / | --bind <home>) ~/.comis is
  //    shadowed by this tmpfs, so the master key / secret store / runtime is denied
  //    to EVERY driven child regardless of scope (non-configurable, not a scope field).
  args.push("--tmpfs", input.dataDir);

  // -- Agent-workspace persistence -- the carve-out above masks ALL of <dataDir>,
  //    which also shadows the session workspace when it IS the agent's OWN workspace
  //    (the default `<dataDir>/workspace/<agent>`, the same dir the agent's read/
  //    write/exec tools operate on). Re-bind ONLY that subpath RW on top of the
  //    tmpfs so the workspace is writable + PERSISTENT in the jail (a driven GSD
  //    milestone's work survives), while the secrets at sibling <dataDir> paths
  //    (secret.db / .env / config.yaml / memory.db) stay shadowed. A workspace
  //    OUTSIDE <dataDir> (e.g. an operator-relocated dir) needs no re-bind — its
  //    earlier `pushFilesystemBinds` mount is never masked. `isUnderDir` is strict
  //    (workspace === dataDir is NOT re-exposed → re-binding ~/.comis onto itself
  //    would defeat the carve-out).
  if (isUnderDir(input.workspace, input.dataDir)) {
    args.push("--bind", input.workspace, input.workspace);
  }

  // The caller appends `bin, ...argv` after the terminator.
  args.push("--");

  return args;
}
