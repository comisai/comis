// SPDX-License-Identifier: Apache-2.0
// @allow-throw: fail-closed control flow — JailUnavailableError signals "no jail can be materialized" (no bwrapPath / no listed-hosts egress port); the worker's dispatch boundary catches it and maps it to an ok:false create reply (the registry flips the session lost). Never an unjailed fallback.
/**
 * buildSpawnPlan -- the scope-jail COMPOSITION seam, extracted out of the worker
 * so `terminal-worker-entry.ts` stays under the 800-line architecture cap.
 *
 * It composes the three already-built primitives into the exact `pty.spawn` /
 * `spawnPipe` arguments the worker uses to run the driven child INSIDE a bwrap
 * jail (the composition: PTY-master-in-worker -> bwrap -> child):
 *
 *   1. {@link buildScopeArgs} -> `[bwrapPath, ...scopeArgs, "--"]`
 *      materializing the entry's `scope` (filesystem/network/uid + credentialPaths
 *      + the always-on ~/.comis carve-out).
 *   2. {@link scrubChildEnv} -> the child env (bwrap forwards the spawner
 *      env, no --clearenv, so the scrubbed env IS the child env). For
 *      `network: listed-hosts` the relay's `proxyEnv` (HTTPS_PROXY/HTTP_PROXY) is
 *      merged over it.
 *   3. For `network: listed-hosts`: {@link EgressControlPort.materialize} stands up
 *      the host-side allowlist proxy socket, {@link buildEgressRelayLaunch}
 *      builds the in-jail relay-as-init wrapper, the socket is bind-mounted via the
 *      composer's `relaySocketPath`, and the relay wrapper is inserted between
 *      bwrap's `--` and the child. The returned {@link EgressMaterialization} rides
 *      back so the worker disposes it on session teardown.
 *
 * Fail-closed on the REAL scope path: if `bwrapPath` is undefined (no provider
 * materialized a jail) this REJECTS — it never returns a bare/unjailed spawn. The
 * worker turns the rejection into an `ok:false` create reply (the registry flips
 * the session `lost`). There is NO dual path.
 *
 * This module is INFRA-FREE: it imports the {@link EgressControlPort} as a TYPE
 * from @comis/core and value-imports only the sibling skills composers — never
 * @comis/infra (the architecture test names the terminal scope/egress files as
 * infra-free; this is one more on that boundary).
 *
 * @module
 */

import { homedir } from "node:os";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep as pathSep } from "node:path";

import { safePath, type EgressControlPort, type EgressMaterialization } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

import type { TerminalScope } from "./allowlist-matcher.js";
import {
  buildScopeArgs as defaultBuildScopeArgs,
  MANAGED_WORKSPACE_GIT_ENVIRONMENT_KEYS,
  SYSTEM_RO_PATHS,
} from "./terminal-scope-args.js";
import { scrubChildEnv as defaultScrubChildEnv, secretEnvKeysIn } from "./terminal-env-scrub.js";
import {
  buildEgressRelayLaunch as defaultBuildEgressRelayLaunch,
  type EgressRelayLaunch,
} from "./terminal-egress-relay.js";
import {
  MANAGED_TERMINAL_ATTACHMENT_PATH_ENVIRONMENT,
  MANAGED_TERMINAL_ATTACHMENT_TARGET_ENVIRONMENT,
  managedTerminalAttachmentTargetPath,
  type ManagedTerminalExecutionAttachment,
} from "./terminal-managed-binding.js";

/**
 * The net-new uid/gid the dedicated-uid posture drops to inside the jail
 * (`nobody`/`nogroup`). Net-new vs the daemon uid — proven on the VPS. Applied
 * only when `scope.uid === "dedicated"` (the default).
 */
export const DEDICATED_UID = { uid: 65534, gid: 65534 } as const;

/**
 * The loopback TCP port the in-jail egress relay listens on for
 * `network: listed-hosts`, exposed to the child as
 * `HTTPS_PROXY=http://127.0.0.1:<port>`. The netns is isolated (`--unshare-net`),
 * so this jail-local port can never collide with a host port.
 */
export const RELAY_LOOPBACK_PORT = 13128 as const;

/**
 * The least-privilege default scope applied when a create frame carries no
 * `scope` — workspace-only fs, deny-all egress, no credential home, a net-new
 * uid. Defense-in-depth: the daemon already defaults every scope sub-field via the
 * config schema; the worker never assumes a widened scope from an absent field.
 */
export const LEAST_PRIVILEGE_SCOPE: TerminalScope = {
  filesystem: "workspace",
  network: "none",
  credentialPaths: [],
  ephemeralWritablePaths: [],
  uid: "dedicated",
};

/**
 * The composers the worker injects (defaults = the sibling module exports).
 * The egress port is injected by the daemon (a concrete {@link EgressControlPort});
 * `bwrapPath` is the resolved provider path (undefined ⇒ fail-closed).
 */
export interface SpawnPlanComposers {
  buildScopeArgs?: typeof defaultBuildScopeArgs;
  scrubChildEnv?: typeof defaultScrubChildEnv;
  buildEgressRelayLaunch?: typeof defaultBuildEgressRelayLaunch;
  /** The daemon-injected egress port (no-secret allowlist proxy). listed-hosts only. */
  egressControl?: EgressControlPort;
  /** The resolved bwrap binary path. `undefined` ⇒ {@link buildSpawnPlan} rejects (fail-closed). */
  bwrapPath?: string;
  /**
   * The operator opt-out of the jail (`skills.terminal.unsafeDisableSandbox`). When `true`,
   * {@link buildSpawnPlan} runs the driven CLI DIRECTLY (no bwrap) instead of failing closed —
   * for constrained hosts that cannot run bwrap (a container without user-namespaces, a CI box).
   * This provides NO filesystem/network/uid confinement (the scope is unenforceable without the
   * jail), so it is a genuine security downgrade — operator-only, immutable, surfaced in
   * config_posture. The env-scrub is STILL applied, so daemon secrets never reach the child. A
   * durable `backend:"tmux"` drive is PRESERVED (session persistence is a hard requirement): the
   * tmux server env stays clean without the jail's `--unsetenv` because each drive starts its OWN
   * server with this drive's scrubbed env (see terminal-tmux-backend).
   * Takes precedence over `bwrapPath` (unsandboxed even when bwrap is available — the
   * `browser.noSandbox` precedent). Default/absent ⇒ the fail-closed jail.
   */
  unsafeDisableSandbox?: boolean;
}

const EPHEMERAL_WRITABLE_PATH_CONFIG = "agents.*.skills.terminal.allow[].scope.ephemeralWritablePaths";

function validateEphemeralWritablePaths(scope: TerminalScope, home: string): Result<void, Error> {
  for (const configuredPath of scope.ephemeralWritablePaths) {
    const expanded = configuredPath === "~"
      ? home
      : configuredPath.startsWith("~/")
        ? resolvePath(home, configuredPath.slice(2))
        : configuredPath;
    const inspected = tryCatch(() => lstatSync(expanded));
    if (!inspected.ok || !inspected.value.isDirectory() || inspected.value.isSymbolicLink()) {
      return err(new EphemeralWritablePathUnavailableError(expanded));
    }
  }
  return ok(undefined);
}

/** The session geometry + identity the plan needs (off the create frame). */
export interface SpawnPlanInput {
  /** The operator-declared scope (least-privilege default applied upstream). */
  scope: TerminalScope;
  /** The driven command (daemon-canonical) — placed verbatim AFTER bwrap's `--`. */
  bin: string;
  /** The driven command argv — placed verbatim after `bin`. */
  argv: string[];
  /** The session workspace root (always --bind RW). */
  workspace: string;
  /** Host-resolved Git administration mounts for a managed linked worktree. */
  workspaceGitMounts?: ManagedWorkspaceGitMounts;
  /** The --chdir target. */
  cwd: string;
  /** `os.homedir()` (injected for testability — the home/credential roots). */
  home: string;
  /** The carve-out target `os.homedir()/.comis` (non-configurable). */
  dataDir: string;
  /** The resolved system RO paths (the caller filters {@link SYSTEM_RO_PATHS} to existing). */
  systemRoPaths: readonly string[];
  /**
   * The worker's `envSnapshot()` output — bwrap forwards this to the child (no
   * --clearenv), so it is scrubbed by {@link scrubChildEnv} and becomes the child
   * env. Passed in (not read here) so the plan stays a pure transform.
   */
  env: NodeJS.ProcessEnv;
  /** Server-resolved Unix sockets; never sourced from terminal tool parameters. */
  executionAttachments?: readonly ManagedTerminalExecutionAttachment[];
}

/** The composed spawn arguments + the egress handle to dispose on teardown. */
export interface SpawnPlan {
  /** arg0 — the bwrap binary (or, when {@link unsandboxed}, the driven CLI itself). */
  bin: string;
  /** `[...scopeArgs after bwrapPath, [relayArgv], childBin, ...childArgv]` (or just the CLI argv when {@link unsandboxed}). */
  argv: string[];
  /** The scrubbed (+ proxyEnv for listed-hosts) child env. */
  env: NodeJS.ProcessEnv;
  /**
   * The child working directory to set on a DIRECT spawn — present ONLY on the
   * {@link unsandboxed} path (the jailed path bakes cwd into the bwrap `--chdir` arg instead).
   * The worker passes it to `pty.spawn`/`spawnPipe` so the unsandboxed CLI still runs in the
   * session workspace/project dir.
   */
  cwd?: string;
  /**
   * `true` when the jail was bypassed via `unsafeDisableSandbox` — the child runs DIRECTLY with
   * no bwrap (its `cwd` is set below). A durable `backend:"tmux"` request is NOT downgraded: the
   * worker keeps the tmux server env clean by starting a session-private server with this drive's
   * scrubbed env, so no jail `--unsetenv` is needed. Surfaced in
   * `config_posture`. Absent/false ⇒ the fail-closed jail (the default).
   */
  unsandboxed?: boolean;
  /**
   * The egress materialization for `network: listed-hosts` — the worker stores it
   * on the session and calls `dispose()` once on teardown (socket cleanup). Absent
   * for `none`/`full`.
   */
  egress?: EgressMaterialization;
}

/** Raised when the jail cannot be materialized (no provider) — fail-closed. */
export class JailUnavailableError extends Error {
  readonly errorKind = "dependency" as const;
  constructor() {
    super("no sandbox provider: cannot materialize the terminal scope jail");
    this.name = "JailUnavailableError";
  }
}

/** Raised when attachment confinement is required but cannot be materialized. */
export class AttachmentSandboxUnavailableError extends Error {
  readonly errorKind = "sandbox_unavailable" as const;
  constructor() {
    super("sandbox_unavailable: execution attachments require an enforceable bubblewrap jail");
    this.name = "AttachmentSandboxUnavailableError";
  }
}

/** Raised before bubblewrap when an operator-declared writable overlay has no safe mountpoint. */
export class EphemeralWritablePathUnavailableError extends Error {
  readonly errorKind = "precondition" as const;
  constructor(target: string) {
    super(`${EPHEMERAL_WRITABLE_PATH_CONFIG} target is unavailable: ${target}; create it as a directory before starting the terminal`);
    this.name = "EphemeralWritablePathUnavailableError";
  }
}

/** Raised when an authority-backed linked worktree has unsafe or unreadable Git administration. */
export class ManagedWorkspaceGitUnavailableError extends Error {
  readonly errorKind = "precondition" as const;
  constructor() {
    super("managed workspace Git administration is unavailable; recreate the workspace lease from a valid linked Git worktree");
    this.name = "ManagedWorkspaceGitUnavailableError";
  }
}

/** Canonical host source and the exact path recorded in the worktree marker. */
export interface ManagedWorkspaceGitMounts {
  readonly common: {
    readonly sourcePath: string;
    readonly targetPath: string;
  };
  readonly worktree: {
    readonly sourcePath: string;
    readonly targetPath: string;
  };
  readonly privateCommon: {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly systemConfigPath: string;
  };
}

const MANAGED_GIT_DIRECTORY = ".comis-terminal-git";
const MANAGED_GIT_SOURCE_RECORD = "source.json";
const MAX_GIT_CONTROL_FILE_BYTES = 16 * 1024 * 1024;

function readManagedGitFile(path: string, maxBytes = MAX_GIT_CONTROL_FILE_BYTES): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error("managed workspace Git control file is unavailable");
  }
  return readFileSync(path);
}

function makeManagedGitDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o777 });
  chmodSync(path, 0o777);
}

function writeManagedGitFile(path: string, content: string | Buffer): void {
  writeFileSync(path, content, { mode: 0o666 });
  chmodSync(path, 0o666);
}

function copyManagedGitFile(source: string, target: string): void {
  writeManagedGitFile(target, readManagedGitFile(source));
}

function resolveManagedGitHead(commonDir: string, headText: string): {
  readonly oid: string;
  readonly reference?: string;
} {
  const trimmed = headText.trim();
  const referenceMatch = /^ref: (refs\/heads\/.+)$/u.exec(trimmed);
  if (referenceMatch === null) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(trimmed)) {
      throw new Error("managed workspace Git HEAD is malformed");
    }
    return { oid: trimmed };
  }
  const reference = referenceMatch[1]!;
  const referencePath = safePath(commonDir, ...reference.split("/"));
  if (existsSync(referencePath)) {
    const oid = readManagedGitFile(referencePath, 4_096).toString("utf8").trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) {
      throw new Error("managed workspace Git branch reference is malformed");
    }
    return { oid, reference };
  }
  const packedRefsPath = safePath(commonDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    throw new Error("managed workspace Git branch reference is unavailable");
  }
  const packedLine = readManagedGitFile(packedRefsPath).toString("utf8").split(/\r?\n/u)
    .find((line) => line.endsWith(` ${reference}`));
  const oid = packedLine?.slice(0, packedLine.indexOf(" "));
  if (oid === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(oid)) {
    throw new Error("managed workspace Git packed branch reference is malformed");
  }
  return { oid, reference };
}

function loadManagedWorkspaceGitMounts(
  workspace: string,
  commonDir: string,
  commonTarget: string,
  gitDir: string,
  gitDirTarget: string,
): ManagedWorkspaceGitMounts {
  const privateRootTarget = safePath(workspace, MANAGED_GIT_DIRECTORY);
  const privateRootTargetStat = lstatSync(privateRootTarget);
  if (!privateRootTargetStat.isDirectory() || privateRootTargetStat.isSymbolicLink()) {
    throw new Error("managed workspace private Git administration is unavailable");
  }
  const privateRoot = realpathSync(privateRootTarget);
  const canonicalWorkspace = realpathSync(workspace);
  if (privateRoot !== safePath(canonicalWorkspace, MANAGED_GIT_DIRECTORY)) {
    throw new Error("managed workspace private Git administration is unavailable");
  }
  const sourceRecord = JSON.parse(
    readManagedGitFile(safePath(privateRoot, MANAGED_GIT_SOURCE_RECORD), 4_096).toString("utf8"),
  ) as unknown;
  if (
    typeof sourceRecord !== "object"
    || sourceRecord === null
    || (sourceRecord as { commonDir?: unknown }).commonDir !== commonDir
    || (sourceRecord as { gitDir?: unknown }).gitDir !== gitDir
  ) {
    throw new Error("managed workspace private Git administration belongs to another worktree");
  }
  const privateWorktreeTarget = safePath(privateRootTarget, "worktree");
  const privateCommonTarget = safePath(privateRootTarget, "common");
  const privateWorktreeTargetStat = lstatSync(privateWorktreeTarget);
  const privateCommonTargetStat = lstatSync(privateCommonTarget);
  if (
    !privateWorktreeTargetStat.isDirectory()
    || privateWorktreeTargetStat.isSymbolicLink()
    || !privateCommonTargetStat.isDirectory()
    || privateCommonTargetStat.isSymbolicLink()
  ) {
    throw new Error("managed workspace private Git administration is unavailable");
  }
  const privateWorktree = realpathSync(privateWorktreeTarget);
  const privateCommon = realpathSync(privateCommonTarget);
  for (const canonicalPath of [privateWorktree, privateCommon]) {
    const descendant = relative(privateRoot, canonicalPath);
    if (descendant.length === 0 || descendant === ".." || descendant.startsWith(`..${pathSep}`) || isAbsolute(descendant)) {
      throw new Error("managed workspace private Git administration is unavailable");
    }
  }
  return {
    common: { sourcePath: commonDir, targetPath: commonTarget },
    worktree: { sourcePath: privateWorktree, targetPath: gitDirTarget },
    privateCommon: {
      sourcePath: privateCommon,
      targetPath: privateCommonTarget,
      systemConfigPath: safePath(privateCommonTarget, "system-config"),
    },
  };
}

function materializeManagedWorkspaceGitMounts(
  workspace: string,
  commonDir: string,
  commonTarget: string,
  gitDir: string,
  gitDirTarget: string,
): ManagedWorkspaceGitMounts {
  const privateRootTarget = safePath(workspace, MANAGED_GIT_DIRECTORY);
  if (existsSync(privateRootTarget)) {
    return loadManagedWorkspaceGitMounts(workspace, commonDir, commonTarget, gitDir, gitDirTarget);
  }
  if ([workspace, commonDir, commonTarget, gitDir, gitDirTarget].some((path) => /[\r\n]/u.test(path))) {
    throw new Error("managed workspace Git paths contain unsupported control characters");
  }
  const objectsPath = safePath(commonDir, "objects");
  const objectsStat = lstatSync(objectsPath);
  if (!objectsStat.isDirectory() || objectsStat.isSymbolicLink()) {
    throw new Error("managed workspace Git object database is unavailable");
  }
  const head = readManagedGitFile(safePath(gitDir, "HEAD"), 4_096).toString("utf8");
  const resolvedHead = resolveManagedGitHead(commonDir, head);
  const temporaryRoot = mkdtempSync(`${privateRootTarget}-`);
  try {
    chmodSync(temporaryRoot, 0o777);
    const privateWorktree = safePath(temporaryRoot, "worktree");
    const privateCommon = safePath(temporaryRoot, "common");
    makeManagedGitDirectory(privateWorktree);
    makeManagedGitDirectory(privateCommon);
    makeManagedGitDirectory(safePath(privateCommon, "objects"));
    makeManagedGitDirectory(safePath(privateCommon, "objects", "info"));
    makeManagedGitDirectory(safePath(privateCommon, "refs"));
    makeManagedGitDirectory(safePath(privateCommon, "info"));
    writeManagedGitFile(safePath(privateWorktree, "HEAD"), head);
    writeManagedGitFile(safePath(privateWorktree, "commondir"), `${safePath(privateRootTarget, "common")}\n`);
    writeManagedGitFile(safePath(privateWorktree, "gitdir"), `${safePath(workspace, ".git")}\n`);
    const indexPath = safePath(gitDir, "index");
    if (existsSync(indexPath)) copyManagedGitFile(indexPath, safePath(privateWorktree, "index"));
    const worktreeConfigPath = safePath(gitDir, "config.worktree");
    const hasWorktreeConfig = existsSync(worktreeConfigPath);
    if (hasWorktreeConfig) copyManagedGitFile(worktreeConfigPath, safePath(privateWorktree, "config.worktree"));
    const sparseCheckoutPath = safePath(gitDir, "info", "sparse-checkout");
    if (existsSync(sparseCheckoutPath)) {
      makeManagedGitDirectory(safePath(privateWorktree, "info"));
      copyManagedGitFile(sparseCheckoutPath, safePath(privateWorktree, "info", "sparse-checkout"));
    }
    const repositoryVersion = resolvedHead.oid.length === 64 ? "1" : "0";
    const objectFormat = resolvedHead.oid.length === 64 ? "\n[extensions]\n\tobjectFormat = sha256" : "";
    const worktreeConfig = hasWorktreeConfig
      ? `${objectFormat.length === 0 ? "\n[extensions]" : ""}\n\tworktreeConfig = true`
      : "";
    writeManagedGitFile(safePath(privateCommon, "config"), `[core]\n\trepositoryformatversion = ${repositoryVersion}\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true${objectFormat}${worktreeConfig}\n`);
    writeManagedGitFile(safePath(privateCommon, "system-config"), `[safe]\n\tdirectory = ${JSON.stringify(workspace)}\n`);
    writeManagedGitFile(safePath(privateCommon, "objects", "info", "alternates"), `${safePath(commonTarget, "objects")}\n`);
    writeManagedGitFile(safePath(privateCommon, "info", "exclude"), `/${MANAGED_GIT_DIRECTORY}/\n`);
    if (resolvedHead.reference !== undefined) {
      const privateReference = safePath(privateCommon, ...resolvedHead.reference.split("/"));
      makeManagedGitDirectory(resolvePath(privateReference, ".."));
      writeManagedGitFile(privateReference, `${resolvedHead.oid}\n`);
    }
    const shallowPath = safePath(commonDir, "shallow");
    if (existsSync(shallowPath)) copyManagedGitFile(shallowPath, safePath(privateCommon, "shallow"));
    writeManagedGitFile(
      safePath(temporaryRoot, MANAGED_GIT_SOURCE_RECORD),
      `${JSON.stringify({ schemaVersion: 1, commonDir, gitDir })}\n`,
    );
    renameSync(temporaryRoot, privateRootTarget);
  } catch (cause) {
    if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
    throw cause;
  }
  return loadManagedWorkspaceGitMounts(workspace, commonDir, commonTarget, gitDir, gitDirTarget);
}

/**
 * Raised when the resolved `cwd` (the jail `--chdir` target) is NOT contained by any
 * path the scope binds into the jail — a typed, operator-actionable fail-closed at the
 * composition seam (§4.8), instead of an opaque `bwrap: Can't chdir` spawn crash. `cwd`
 * is an agent-supplied, prompt-injectable input governed by the OPERATOR scope, so a
 * mismatch must fail CLEAN + EARLY (before any bwrap spawn). NOT a sandbox escape (bwrap
 * already contains chdir within its mount namespace) — a fail-clean/observability rule.
 */
export class CwdOutsideScopeError extends Error {
  readonly errorKind = "permission_denied" as const;
  constructor(cwd: string) {
    super(
      `cwd ${cwd} is outside the paths bound by this scope: the --chdir target must sit ` +
        `within the session workspace or a path the scope.filesystem binds`,
    );
    this.name = "CwdOutsideScopeError";
  }
}

/**
 * The absolute paths a {@link TerminalScope} binds into the jail that a `cwd` may sit
 * under: the always-bound `workspace`, plus whatever `scope.filesystem` adds
 * (`listed-paths` → `scope.paths`; `home` → `home`; `workspace` → nothing extra). For
 * `filesystem: full` the whole host fs is bound, so ANY cwd is in-bounds (returns
 * `undefined` to signal "no containment check"). Pure — no fs.
 */
function scopeCwdBases(scope: TerminalScope, workspace: string, home: string): string[] | undefined {
  if (scope.filesystem === "full") return undefined; // everything bound — any cwd ok
  const bases = [workspace]; // the workspace is ALWAYS bound RW
  switch (scope.filesystem) {
    case "workspace":
      break; // workspace-only
    case "listed-paths":
      bases.push(...(scope.paths ?? []));
      break;
    case "home":
      bases.push(home);
      break;
    default: {
      const _exhaustive: never = scope.filesystem;
      throw new Error(`Unhandled filesystem scope: ${String(_exhaustive)}`);
    }
  }
  return bases;
}

/**
 * Lexical containment check: is `cwd` within `base`? Resolves both (collapsing `..`),
 * then `cwd === base || cwd.startsWith(base + sep)` — the sep boundary defeats a
 * prefix-spoof sibling (`/ws-evil` is NOT under `/ws`). Pure + fs-free (the live chdir
 * proof is the VPS scope matrix); mirrors `safePath`'s prefix logic without its fs
 * symlink walk, because this composer runs against not-yet-existing jail paths.
 */
function isCwdWithinBase(cwd: string, base: string): boolean {
  const rc = resolvePath(cwd);
  const rb = resolvePath(base);
  return rc === rb || rc.startsWith(rb.endsWith(pathSep) ? rb : rb + pathSep);
}

/**
 * Resolve the shared Git directory for an authority-backed linked worktree.
 * A normal in-workspace `.git` directory and a non-Git workspace need no extra
 * mount. A linked marker is accepted only when its canonical per-worktree
 * directory is a strict child of both the canonical and marker-addressed common
 * directory's `worktrees` subtree; malformed or escaped markers fail closed.
 */
export function resolveManagedWorkspaceGitMounts(
  workspace: string,
): Result<ManagedWorkspaceGitMounts | undefined, Error> {
  const resolved = tryCatch(() => {
    const marker = safePath(workspace, ".git");
    if (!existsSync(marker)) return undefined;
    const markerStat = lstatSync(marker);
    if (markerStat.isDirectory()) return undefined;
    if (!markerStat.isFile()) throw new Error("managed workspace Git marker is not a regular file");

    const markerText = readFileSync(marker, "utf8");
    if (markerText.length > 4_096) throw new Error("managed workspace Git marker exceeds the bounded size");
    const markerMatch = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(markerText);
    if (markerMatch === null) throw new Error("managed workspace Git marker is malformed");
    const gitDirCandidate = isAbsolute(markerMatch[1]!)
      ? resolvePath(markerMatch[1]!)
      : resolvePath(workspace, markerMatch[1]!);
    const gitDir = realpathSync(gitDirCandidate);

    const commonMarker = safePath(gitDir, "commondir");
    const commonText = readFileSync(commonMarker, "utf8");
    if (commonText.length > 4_096) throw new Error("managed workspace Git common marker exceeds the bounded size");
    const commonRelative = commonText.replace(/\r?\n$/u, "");
    if (commonRelative.length === 0 || commonRelative.includes("\n") || commonRelative.includes("\r")) {
      throw new Error("managed workspace Git common marker is malformed");
    }
    const commonTarget = isAbsolute(commonRelative)
      ? resolvePath(commonRelative)
      : resolvePath(gitDirCandidate, commonRelative);
    const commonDir = realpathSync(commonTarget);
    const worktreesRoot = safePath(commonDir, "worktrees");
    const targetWorktreesRoot = resolvePath(commonTarget, "worktrees");
    if (
      gitDir === worktreesRoot
      || !isCwdWithinBase(gitDir, worktreesRoot)
      || gitDirCandidate === targetWorktreesRoot
      || !isCwdWithinBase(gitDirCandidate, targetWorktreesRoot)
    ) {
      throw new Error("managed workspace Git directory is outside the common worktree administration root");
    }
    return isCwdWithinBase(commonTarget, workspace)
      ? undefined
      : materializeManagedWorkspaceGitMounts(
        workspace,
        commonDir,
        commonTarget,
        gitDir,
        gitDirCandidate,
      );
  });
  return resolved.ok ? ok(resolved.value) : err(resolved.error);
}

/**
 * Fail-closed (typed) when `cwd` is not contained by the scope's bound paths. `full`
 * binds everything → no check. Throws {@link CwdOutsideScopeError} (errorKind
 * `permission_denied`, message names `cwd`) so the worker maps it to an `ok:false`
 * create reply (the registry flips the session `lost`) — never an opaque chdir crash.
 */
function assertCwdWithinScope(cwd: string, scope: TerminalScope, workspace: string, home: string): void {
  const bases = scopeCwdBases(scope, workspace, home);
  if (bases === undefined) return; // filesystem:full — any cwd is in-bounds
  if (!bases.some((b) => isCwdWithinBase(cwd, b))) {
    throw new CwdOutsideScopeError(cwd);
  }
}

/**
 * Compose the bwrap-wrapping spawn for one session.
 *
 * For `network: listed-hosts` this AWAITS `egressControl.materialize(hosts)` (the
 * only async step) and threads the socket + relay wrapper + proxy env through the
 * composer. For `none`/`full` the egress port is never touched.
 *
 * @throws JailUnavailableError when `bwrapPath` is undefined (never an unjailed
 * fallback) or when `network: listed-hosts` has no injected egress port.
 * @throws CwdOutsideScopeError when the resolved `cwd` is not contained by the scope's
 * bound paths (fail-clean before any spawn), instead of an opaque chdir crash.
 */
export async function buildSpawnPlan(
  input: SpawnPlanInput,
  composers: SpawnPlanComposers,
): Promise<SpawnPlan> {
  const scrubChildEnv = composers.scrubChildEnv ?? defaultScrubChildEnv;
  if ((input.executionAttachments?.length ?? 0) > 0 && (composers.unsafeDisableSandbox === true || composers.bwrapPath === undefined)) {
    throw new AttachmentSandboxUnavailableError();
  }
  const childEnv = scrubChildEnv(input.env);
  const terminalType = childEnv.TERM?.trim();
  if (terminalType === undefined || terminalType.length === 0 || terminalType === "dumb" || terminalType === "unknown") {
    childEnv.TERM = "xterm-256color";
  }
  if (input.workspaceGitMounts !== undefined) {
    for (const key of MANAGED_WORKSPACE_GIT_ENVIRONMENT_KEYS) delete childEnv[key];
    childEnv.GIT_COMMON_DIR = input.workspaceGitMounts.privateCommon.targetPath;
    childEnv.GIT_CONFIG_SYSTEM = input.workspaceGitMounts.privateCommon.systemConfigPath;
  }

  // Operator opt-out of the jail (`skills.terminal.unsafeDisableSandbox`). For constrained hosts
  // that cannot run bwrap: run the driven CLI DIRECTLY. NO filesystem/network/uid confinement (the
  // scope is unenforceable without the jail) — a genuine security downgrade, surfaced in
  // config_posture. But the env-scrub STILL runs, so daemon secrets (gateway token / master key)
  // never reach the child. A durable `backend:"tmux"` drive is preserved under `unsandboxed:true`
  // (session persistence is required): the worker starts a session-private tmux server with this
  // scrubbed env, so the server env is clean without the jail's `--unsetenv`.
  // Takes precedence over `bwrapPath` (unsandboxed even when bwrap is available — the
  // `browser.noSandbox` precedent). Do NOT inject CLAUDE_CODE_BUBBLEWRAP: we are NOT bubblewrapped,
  // so a sandbox-aware CLI must stay free to nest its own sandbox.
  if (composers.unsafeDisableSandbox === true) {
    return {
      bin: input.bin,
      argv: input.argv,
      env: childEnv,
      cwd: input.cwd,
      unsandboxed: true,
    };
  }

  // No provider => no jail => no spawn. Reject BEFORE any materialization.
  if (composers.bwrapPath === undefined) {
    throw new JailUnavailableError();
  }
  const buildScopeArgs = composers.buildScopeArgs ?? defaultBuildScopeArgs;
  const buildEgressRelayLaunch =
    composers.buildEgressRelayLaunch ?? defaultBuildEgressRelayLaunch;

  const { scope } = input;
  const writablePaths = validateEphemeralWritablePaths(scope, input.home);
  if (!writablePaths.ok) throw writablePaths.error;
  // Fail-closed: the agent-supplied cwd (the jail --chdir target) MUST sit within a
  // path the scope binds — reject typed + EARLY (before any egress socket / spawn), not
  // as an opaque `bwrap: Can't chdir`. filesystem:full binds everything → no check.
  assertCwdWithinScope(input.cwd, scope, input.workspace, input.home);
  const dedicatedUid = scope.uid === "dedicated" ? DEDICATED_UID : undefined;

  // listed-hosts: stand up the egress relay + bind its socket + add the proxy env.
  let egress: EgressMaterialization | undefined;
  let relay: EgressRelayLaunch | undefined;
  let relaySocketPath: string | undefined;
  if (scope.network === "listed-hosts") {
    if (composers.egressControl === undefined) {
      // listed-hosts demands an egress port; absent ⇒ fail-closed (no open net).
      throw new JailUnavailableError();
    }
    egress = await composers.egressControl.materialize(scope.hosts ?? []);
    relaySocketPath = egress.socketPath;
    relay = buildEgressRelayLaunch({
      socketPath: egress.socketPath,
      relayPort: RELAY_LOOPBACK_PORT,
      // The relay-init owns the uid drop for listed-hosts (it must run as
      // userns-root to bring `lo` up first), so hand it the net-new uid.
      dedicatedUid,
    });
  }

  // For listed-hosts the relay-init (above) performs the uid drop AFTER bringing
  // `lo` up as userns-root, so the bwrap jail itself must NOT pre-drop via `--uid`
  // (that would strip CAP_NET_ADMIN and break the loopback-up). For every other
  // network mode bwrap drops the uid directly (no relay in the path).
  const bwrapUid = scope.network === "listed-hosts" ? undefined : dedicatedUid;

  const scopeArgs = buildScopeArgs({
    scope,
    bwrapPath: composers.bwrapPath,
    workspace: input.workspace,
    workspaceGitMounts: input.workspaceGitMounts,
    cwd: input.cwd,
    executablePath: input.bin,
    home: input.home,
    dataDir: input.dataDir,
    systemRoPaths: input.systemRoPaths,
    dedicatedUid: bwrapUid,
    relaySocketPath,
    // listed-hosts: the relay-init runs INSIDE the jail, so its script must be
    // --ro-bound in (node can't load a host path that isn't bound).
    relayInitScriptPath: relay?.relayInitScriptPath,
    // The concrete daemon-secret keys present in the live env (gateway-token family /
    // master key) → emitted as `--unsetenv <name>` so the DEFAULT tmux/durable backend
    // (which inherits the tmux SERVER env, bypassing the scrubbed `env` object below)
    // also strips them. The PTY backend is covered by the scrubChildEnv(input.env) below;
    // this is the backend-independent half (TERM-ENV-GATEWAY-TOKEN-LEAK).
    extraUnsetEnvKeys: secretEnvKeysIn(input.env),
    executionAttachments: input.executionAttachments,
  });

  // scopeArgs = [bwrapPath, ...args, "--"]. The child (and, for listed-hosts, the
  // relay-as-init wrapper) go AFTER that `--`.
  const afterSeparator: string[] = [
    ...scopeArgs.slice(1),
    ...(relay?.relayArgv ?? []),
    input.bin,
    ...input.argv,
  ];

  // bwrap forwards the spawner env to the child (no --clearenv): scrub it, then for
  // listed-hosts merge the relay's HTTPS_PROXY/HTTP_PROXY over the scrubbed env.
  delete childEnv[MANAGED_TERMINAL_ATTACHMENT_PATH_ENVIRONMENT];
  delete childEnv[MANAGED_TERMINAL_ATTACHMENT_TARGET_ENVIRONMENT];
  const soleAttachment = input.executionAttachments?.length === 1
    ? input.executionAttachments[0]
    : undefined;
  const env: NodeJS.ProcessEnv = {
    ...childEnv,
    ...(relay?.proxyEnv ?? {}),
    // We ALWAYS run the CLI inside THIS bwrap jail (the spawn throws JailUnavailableError
    // otherwise), so tell a sandbox-aware CLI it is already bubblewrapped → it skips nesting
    // its OWN sandbox. claude reads CLAUDE_CODE_BUBBLEWRAP; absent it, its Bash tool nests a
    // second bubblewrap that remounts $HOME ro and then EROFSes on `mkdir ~/.claude/session-env`
    // (real-VPS 2026-06-16, session a7c44a66: claude authored files but every Bash command was
    // dead) — a redundant layer, since OUR jail is already the security boundary. Injected
    // POST-scrub: scrubChildEnv blanket-strips CLAUDE_CODE_* (so it would erase this otherwise —
    // which is exactly why the jailed claude never detected the outer jail and nested).
    CLAUDE_CODE_BUBBLEWRAP: "1",
    ...(soleAttachment === undefined ? {} : {
      [MANAGED_TERMINAL_ATTACHMENT_PATH_ENVIRONMENT]: managedTerminalAttachmentTargetPath(soleAttachment.targetName),
      [MANAGED_TERMINAL_ATTACHMENT_TARGET_ENVIRONMENT]: soleAttachment.targetName,
    }),
  };

  return {
    bin: scopeArgs[0],
    argv: afterSeparator,
    env,
    egress,
  };
}

/** The create-frame fields {@link planSpawnFromCreateFrame} reads. */
export interface CreateFrameSpawnParams {
  /** The driven command (daemon-canonical). */
  bin: string;
  /** The driven command argv. */
  argv: string[];
  /** The operator scope; least-privilege default when absent. */
  scope?: TerminalScope;
  /** The session workspace root (always --bind RW). */
  workspace?: string;
  /** The --chdir target. */
  cwd?: string;
  /** Server-stamped authority signal; never accepted from terminal tool parameters. */
  managedWorkspace?: boolean;
  executionAttachments?: readonly ManagedTerminalExecutionAttachment[];
}

/**
 * Resolve the host-side jail companions (home, the `~/.comis` carve-out dataDir,
 * the existing system RO paths) and {@link buildSpawnPlan} for a create frame —
 * the single seam the worker calls so `terminal-worker-entry.ts` stays a thin
 * backend-wiring file (<=800). Reads `os.homedir()` + filters {@link SYSTEM_RO_PATHS}
 * by `existsSync` HERE (the worker stays free of those fs/os reads). `env` is the
 * worker's `envSnapshot()` (passed in — bwrap forwards it to the child).
 *
 * @throws JailUnavailableError (via {@link buildSpawnPlan}) on the fail-closed path.
 */
export async function planSpawnFromCreateFrame(
  params: CreateFrameSpawnParams,
  env: NodeJS.ProcessEnv,
  composers: SpawnPlanComposers,
): Promise<SpawnPlan> {
  const home = homedir();
  const scope = params.scope ?? LEAST_PRIVILEGE_SCOPE;
  const workspace = params.workspace ?? home;
  const gitCommon = params.managedWorkspace === true
    ? resolveManagedWorkspaceGitMounts(workspace)
    : ok<ManagedWorkspaceGitMounts | undefined>(undefined);
  if (!gitCommon.ok) throw new ManagedWorkspaceGitUnavailableError();
  return buildSpawnPlan(
    {
      scope,
      bin: params.bin,
      argv: params.argv,
      workspace,
      workspaceGitMounts: gitCommon.value,
      cwd: params.cwd ?? workspace,
      home,
      dataDir: safePath(home, ".comis"),
      systemRoPaths: SYSTEM_RO_PATHS.filter((sp) => existsSync(sp)),
      env,
      executionAttachments: params.executionAttachments,
    },
    composers,
  );
}

export { SYSTEM_RO_PATHS };
