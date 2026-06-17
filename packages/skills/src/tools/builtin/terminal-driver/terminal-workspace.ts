// SPDX-License-Identifier: Apache-2.0
/**
 * terminal-workspace -- the per-session jail workspace allocator. Extracted from
 * `terminal-session-registry.ts` so that file stays under the 800-line architecture cap.
 *
 * THE GAP IT CLOSES. The terminal worker spawns the driven child INSIDE a bwrap jail
 * with `--chdir <cwd>` under `--uid 65534` (nobody). The create frame must therefore
 * carry a real, per-session `workspace`/`cwd` the jail can `--bind` RW and chdir into.
 * Before this, the create path threaded NOTHING, so `buildSpawnPlan` defaulted both to
 * the daemon HOME — which nobody (65534) cannot use as a working directory (the jailed
 * `cat` failed to spawn → session lost), and which at `filesystem:workspace` would bind
 * HOME (far too broad). This allocator gives each session a throwaway directory the
 * jail actually needs to function; the FULL origin-keyed per-session resource lifecycle
 * is a later concern — this is just the minimum the jail requires.
 *
 * WHY WORLD-RWX (0o777). The dir is bind-mounted RW into the jail and the child runs as
 * the net-new uid 65534, NOT the daemon uid that created the dir. The `mkdtemp` default
 * (0o700, daemon-owned) would deny the child chdir + create-file, so the jailed program
 * cannot run. The directory is a per-session throwaway under the data dir / os.tmpdir(),
 * isolated (its own mkdtemp suffix) and removed on `kill`/teardown, so world-rwx here is
 * acceptable — it is the bound working dir for a single confined session, never a shared
 * or persistent surface. (The ~/.comis carve-out + the rest of the host fs remain off
 * limits via the jail; this dir is the ONLY writable surface the child is handed.)
 *
 * INFRA-FREE: this module imports ONLY node builtins (`node:fs`/`node:os`/`node:path`)
 * — never `@comis/infra` (it lives under `packages/skills/src/`, governed by the
 * infra-runtime-scope architecture guard). All side-effecting ops are injectable so the
 * registry's allocate/cleanup lifecycle is unit-testable, but the production defaults
 * perform the real `mkdtemp`/`chmod`/`rm`.
 *
 * @module
 */

import { mkdtempSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The per-session workspace permission bits. World-rwx so the jailed child (uid
 * 65534, NOT the daemon uid that created the dir) can chdir into + create files in
 * the bound working dir. See the module doc for why this is safe (throwaway,
 * isolated, per-session, removed on teardown).
 */
const WORKSPACE_MODE = 0o777;

/** The directory-name prefix (operator-greppable; session-tagged below). */
const WORKSPACE_PREFIX = "comis-terminal-";

/** Injectable FS/path seams (default = the real node builtins). */
export interface WorkspaceDeps {
  /**
   * The base directory to allocate the per-session workspace under. Default:
   * `os.tmpdir()`. The daemon may thread its data dir (e.g. `<dataDir>/run`) so the
   * session workspaces live beside the rest of the runtime state; either way the dir
   * is a throwaway removed on teardown.
   */
  baseDir?: string;
  /** `mkdtempSync` (default). Injected for unit tests. */
  mkdtemp?: (prefix: string) => string;
  /** `chmodSync` (default). Injected for unit tests. */
  chmod?: (path: string, mode: number) => void;
  /** `rmSync(path,{recursive,force})` (default). Injected for unit tests. */
  rm?: (path: string) => void;
  /** `mkdirSync(path,{recursive})` (default). Injected for unit tests; used by the durable agent-workspace allocator. */
  mkdir?: (path: string) => void;
}

/** The allocated workspace + its derived cwd (the jail `--chdir` target). */
export interface AllocatedWorkspace {
  /** The real per-session directory — `--bind` RW into the jail. */
  workspace: string;
}

/** The resolved create-time jail workspace + cwd + whether the registry owns its cleanup. */
export interface ResolvedCreateWorkspace {
  /** The jail workspace (`--bind` RW). */
  workspace: string;
  /** The jail `--chdir` target (defaults to `workspace`). */
  cwd: string;
  /**
   * The directory the registry must rm on kill — set ONLY when WE allocated it. A
   * caller-supplied workspace is the caller's to clean, so this is `undefined` then.
   */
  ownedWorkspace?: string;
}

/** Expand a leading `~`/`~/` to `home` (the jail cannot --chdir to a literal tilde). */
function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** True when `child` is `parent` or nested under it (segment-aware; inputs are pre-`resolve`d). */
function isWithinDir(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(withSep);
}

/**
 * Resolve the jail workspace+cwd for one create (gap 2): honor a caller-supplied
 * `workspace`/`cwd` (an injected daemon/test override) if present, else `allocate` a
 * fresh per-session dir. Returns `ownedWorkspace` set ONLY when the registry allocated
 * it, so the registry rm's exactly what it owns on kill (never a caller's dir).
 *
 * `cwd` defaults to the workspace. An explicit `req.cwd` is honored ONLY after a
 * leading `~` is expanded AND only if it `resolve`s to a path WITHIN the workspace
 * tree — otherwise it is CLAMPED to the workspace. This makes an agent-supplied
 * literal-tilde path (`"~/.comis/workspace"`, which bwrap cannot --chdir to), a
 * parent/out-of-tree path, or a `../` escape harmless: the session always opens in
 * the writable, re-bound workspace instead of failing the spawn or escaping the jail.
 */
export function resolveCreateWorkspace(
  req: { workspace?: string; cwd?: string; project?: string },
  allocate: (sessionId: string) => string,
  sessionId: string,
  home: string = homedir(),
  ensureDir: (path: string) => void = defaultEnsureDir,
): ResolvedCreateWorkspace {
  const allocated = req.workspace === undefined;
  const workspace = req.workspace ?? allocate(sessionId);
  let cwd = workspace;
  // A `project` SLUG wins: the driver OWNS the in-workspace path so the agent never has to guess
  // one the jail-escape clamp would reject (real-VPS 2026-06-17: the agent passed a SIBLING-of-the-
  // workspace path → clamped → projects collided). The injected `workspace` IS the agent's projects
  // root (`<agentWorkspaceDir>/projects`, see prepareAgentTerminalWorkspace), so the slug lands
  // DIRECTLY in it — `<workspace>/<slug>` = `<agentWorkspaceDir>/projects/<slug>` (slug sanitized to
  // defeat `../`/absolute-path traversal), auto-created (ensureDir) so the jail `--chdir` always
  // succeeds and each project gets its own operator-legible folder under the agent's workspace.
  if (req.project !== undefined && req.project !== "") {
    cwd = join(resolve(workspace), sanitizeProjectSlug(req.project));
    ensureDir(cwd);
  } else if (req.cwd !== undefined) {
    const candidate = resolve(expandHome(req.cwd, home));
    if (isWithinDir(candidate, resolve(workspace))) cwd = candidate;
  }
  return { workspace, cwd, ownedWorkspace: allocated ? workspace : undefined };
}

/**
 * Default {@link resolveCreateWorkspace} dir-ensurer: recursive `mkdir` + world-rwx
 * ({@link WORKSPACE_MODE}) so a jail uid that is NOT the daemon (the `dedicated` default) can
 * chdir into + write the bound project folder. The per-project twin of
 * {@link prepareAgentTerminalWorkspace}; security rests on the jail (the folder is under the
 * agent's re-bound workspace subtree, with `~/.comis` masked), not the mode.
 */
function defaultEnsureDir(path: string): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, WORKSPACE_MODE);
}

/**
 * Reduce a `project` arg to a SINGLE safe path segment for `<workspace>/<slug>` (the workspace is
 * the agent's projects root): every char outside `[A-Za-z0-9_-]` (so `/`, `.`, `~`, whitespace —
 * anything that could form `../` or an absolute path) becomes `-`, dash-runs collapse, edges trim,
 * and the result is truncated. A scrubbed-to-empty slug falls back to `project` so a session always
 * gets a valid folder. The sanitized slug can never escape the workspace (it has no separators), so
 * an injectable workspace is never a traversal surface.
 */
function sanitizeProjectSlug(project: string): string {
  const slug = project
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "project";
}

/**
 * Allocate a real per-session workspace directory for a terminal session, keyed to
 * `sessionId`, and make it accessible to the net-new jail uid (world-rwx). Returns
 * the absolute path the create frame threads as `workspace`+`cwd`.
 *
 * The `mkdtemp` suffix guarantees uniqueness even if two sessions share a prefix, so
 * concurrent allocations never collide. The session id is embedded in the directory
 * name (truncated — a UUID is long) so an operator can correlate a stray dir to its
 * session; the mkdtemp random suffix still owns the uniqueness.
 */
export function allocateSessionWorkspace(
  sessionId: string,
  deps: WorkspaceDeps = {},
): AllocatedWorkspace {
  const base = deps.baseDir ?? tmpdir();
  const mkdtemp = deps.mkdtemp ?? mkdtempSync;
  const chmod = deps.chmod ?? chmodSync;
  // Embed a short, filesystem-safe session tag for operator correlation; the
  // mkdtemp `XXXXXX` suffix is what actually guarantees uniqueness.
  const tag = sanitizeSessionTag(sessionId);
  const workspace = mkdtemp(join(base, `${WORKSPACE_PREFIX}${tag}-`));
  // The jail child runs as uid 65534 (nobody), not the daemon uid — grant world-rwx
  // so it can chdir into + write the bound workspace (the mkdtemp 0o700 default
  // would deny it). Safe: throwaway, isolated, per-session, removed on teardown.
  chmod(workspace, WORKSPACE_MODE);
  return { workspace };
}

/**
 * The stable per-agent terminal projects root, a subdir of the agent's OWN workspace dir.
 *
 * PROJECTS-MOVE (live VPS 2026-06-17): renamed `terminal` → `projects` so a driven project lands
 * at the operator-legible `<agentWorkspaceDir>/projects/<slug>` rather than the redundant
 * `<agentWorkspaceDir>/terminal/projects/<slug>`. This subtree IS the jail's bind-root (the
 * registry threads it as the session `workspace`, which `buildScopeArgs` always binds + re-binds),
 * so the agent's SIBLING `sessions/` (conversation trajectories), `memory.db`, and secrets stay
 * masked by the `~/.comis` carve-out — least-privilege is preserved by the move, not weakened.
 */
export const AGENT_PROJECTS_SUBDIR = "projects";

/**
 * Prepare the PERSISTENT, agent-scoped terminal projects root: `<agentWorkspaceDir>/projects`
 * (a stable subdir of the agent's OWN workspace — the same dir the agent's read/write/exec
 * tools operate on). Unlike {@link allocateSessionWorkspace} (a throwaway `mkdtemp` removed
 * on kill), the daemon injects THIS as `allocateWorkspace` together with a NO-OP
 * `cleanupWorkspace`, so a driven session's work (e.g. a full GSD milestone's TODO app)
 * PERSISTS across session end and the agent can see it under its workspace.
 *
 * Created idempotently (recursive) so reuse across the agent's sessions is safe, and still
 * world-rwx ({@link WORKSPACE_MODE}) so a jailed child running as a net-new uid (the
 * `dedicated` default) is not denied write to the daemon-owned dir. Security rests on the
 * jail, not the dir mode: `buildScopeArgs` re-binds ONLY this subtree RW after the
 * `~/.comis` carve-out, so the agent's secrets + its other workspace files (sessions/skills/
 * memory) stay masked — the child is confined to its projects subtree (least-privilege).
 */
export function prepareAgentTerminalWorkspace(agentWorkspaceDir: string, deps: WorkspaceDeps = {}): string {
  const mkdir = deps.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  const chmod = deps.chmod ?? chmodSync;
  const workspace = join(agentWorkspaceDir, AGENT_PROJECTS_SUBDIR);
  mkdir(workspace);
  chmod(workspace, WORKSPACE_MODE);
  return workspace;
}

/**
 * Best-effort remove a per-session workspace directory on `kill`/teardown. Idempotent
 * (a missing dir is fine, via `force`) and never throws — a cleanup failure must not
 * crash the kill path; the dir is a throwaway under a tmp/runtime base that the OS or
 * a later sweep can reclaim.
 */
export function cleanupSessionWorkspace(workspace: string, deps: WorkspaceDeps = {}): void {
  const rm = deps.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  try {
    rm(workspace);
  } catch {
    // Best-effort — a failed rm of a throwaway session dir is non-fatal (the kill
    // path must always complete); the OS / a later sweep reclaims it.
  }
}

/**
 * Reduce a session id to a short, filesystem-safe tag for the workspace dir name.
 * Strips anything outside `[A-Za-z0-9_-]` (a UUID is already safe; this guards a
 * non-UUID id) and truncates so the path stays bounded. Purely cosmetic — operator
 * correlation only; uniqueness comes from the mkdtemp suffix.
 */
function sanitizeSessionTag(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12);
}
