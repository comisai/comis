import { safePath } from "@comis/core";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import { DEFAULT_TEMPLATES, WORKSPACE_FILE_NAMES, type WorkspaceFileName } from "./templates.js";
import { readWorkspaceState, writeWorkspaceState, isIdentityFilled } from "./workspace-state.js";
import type { WorkspaceState } from "./workspace-state.js";

const execFile = promisify(execFileCb);

export const WORKSPACE_SUBDIRS = [
  "projects",
  "scripts",
  "documents",
  "media",
  "data",
  "output",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceFiles {
  dir: string;
  files: Map<WorkspaceFileName, string>; // fileName -> absolutePath
}

/**
 * Structural subset of `FileStateTracker` from `@comis/skills`.
 *
 * Defined here to avoid an agent→skills dependency (reverses the layer direction).
 * Any object implementing `recordRead` with this signature satisfies the shape;
 * the real `FileStateTracker` structurally conforms.
 */
export interface WorkspaceSeedTracker {
  recordRead(
    path: string,
    mtime: number,
    offset?: number,
    limit?: number,
    contentSample?: Buffer,
  ): void;
}

export interface EnsureWorkspaceOptions {
  /** Absolute path to workspace directory */
  dir: string;
  /** Whether to write bootstrap template files (default: true) */
  ensureBootstrapFiles?: boolean;
  /** Whether to initialize a git repo (default: true) */
  initGit?: boolean;
  /**
   * Optional per-session file-state tracker. When provided, each template
   * file successfully seeded by `writeIfMissing` is registered as "read"
   * with the correct mtime and known content, so the caller session's
   * `write` tool can overwrite the seed without tripping the read-before-write
   * (`[not_read]`) gate.
   *
   * Left undefined at daemon startup (no session yet) — the seeded files will
   * be registered lazily on first read, same as before.
   */
  tracker?: WorkspaceSeedTracker;
}

export interface WorkspaceStatus {
  dir: string;
  exists: boolean;
  files: { name: string; present: boolean; sizeBytes?: number }[];
  hasGitRepo: boolean;
  /** false = BOOTSTRAP.md still present (agent has not completed onboarding) */
  isBootstrapped: boolean;
  /** Workspace lifecycle state (timestamps, version). */
  state?: WorkspaceState;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Write content to filePath only if the file does not already exist.
 * Uses the `wx` (exclusive create) flag for atomic check-and-create.
 *
 * @returns true if written, false if file already existed.
 */
async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Ensure a git repository exists in the given directory.
 * Best-effort: silently skips if git is unavailable.
 */
async function ensureGitRepo(dir: string): Promise<void> {
  try {
    await fs.access(safePath(dir, ".git"));
    return; // already initialized
  } catch {
    /* needs init */
  }

  try {
    await execFile("git", ["init"], { cwd: dir });
  } catch {
    // Git not available -- skip silently
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the workspace directory exists and is populated with default
 * template files using write-if-missing semantics.
 *
 * - Creates directory tree with `recursive: true` (idempotent)
 * - Writes each template file with `wx` flag (never overwrites)
 * - Optionally initializes a git repo (best-effort)
 */
export async function ensureWorkspace(options: EnsureWorkspaceOptions): Promise<WorkspaceFiles> {
  const { dir, ensureBootstrapFiles = true, initGit = true, tracker } = options;

  await fs.mkdir(dir, { recursive: true });

  // Structural directories -- created unconditionally (like the root dir itself).
  // .cache/ and .comis-tmp/ are created by the sandbox, not here.
  for (const subdir of WORKSPACE_SUBDIRS) {
    await fs.mkdir(safePath(dir, subdir), { recursive: true });
  }

  const files = new Map<WorkspaceFileName, string>();

  if (ensureBootstrapFiles) {
    let bootstrapNewlyWritten = false;
    for (const name of WORKSPACE_FILE_NAMES) {
      const filePath = safePath(dir, name);
      const template = DEFAULT_TEMPLATES[name];
      const written = await writeIfMissing(filePath, template);
      files.set(name, filePath);
      if (name === "BOOTSTRAP.md" && written) {
        bootstrapNewlyWritten = true;
      }
      // Register the seeded file in the caller's tracker so its `write` tool
      // can overwrite the template without hitting the read-before-write gate.
      // Only register when we actually wrote (new seed) -- pre-existing files
      // weren't touched here, so their mtime/content is whatever the caller
      // saw before this call.
      if (written && tracker) {
        try {
          const stat = await fs.stat(filePath);
          tracker.recordRead(filePath, stat.mtimeMs, 0, undefined, Buffer.from(template, "utf-8"));
        } catch {
          // stat failure is non-fatal: skip registration, fall back to
          // pre-fix behavior (caller will need to read before overwriting).
        }
      }
    }
    if (bootstrapNewlyWritten) {
      await writeWorkspaceState(dir, { bootstrapSeededAt: Date.now() });
    }
  }

  if (initGit) {
    await ensureGitRepo(dir);
  }

  return { dir, files };
}

/**
 * Check the status of a workspace directory.
 *
 * Reports existence, file presence/size, git repo presence,
 * and bootstrap state (BOOTSTRAP.md absent = onboarding complete).
 */
export async function getWorkspaceStatus(dir: string): Promise<WorkspaceStatus> {
  let exists = true;
  try {
    await fs.access(dir);
  } catch {
    exists = false;
  }

  const fileStatuses: { name: string; present: boolean; sizeBytes?: number }[] = [];
  let bootstrapPresent = false;

  for (const name of WORKSPACE_FILE_NAMES) {
    if (!exists) {
      fileStatuses.push({ name, present: false });
      continue;
    }
    try {
      const stat = await fs.stat(safePath(dir, name));
      fileStatuses.push({ name, present: true, sizeBytes: stat.size });
      if (name === "BOOTSTRAP.md") {
        bootstrapPresent = true;
      }
    } catch {
      fileStatuses.push({ name, present: false });
    }
  }

  let hasGitRepo = false;
  if (exists) {
    try {
      await fs.access(safePath(dir, ".git"));
      hasGitRepo = true;
    } catch {
      /* no git repo */
    }
  }

  // Read workspace lifecycle state
  const state = exists ? await readWorkspaceState(dir) : { version: 1 as const };

  // Check identity-filled as an alternative completion signal
  let identityFilled = false;
  if (exists) {
    const identityPath = safePath(dir, "IDENTITY.md");
    identityFilled = await isIdentityFilled(identityPath);
  }

  // Detect and record onboarding completion (fires once)
  const isComplete = !bootstrapPresent || identityFilled;
  if (isComplete && state.bootstrapSeededAt && !state.onboardingCompletedAt) {
    const now = Date.now();
    await writeWorkspaceState(dir, { onboardingCompletedAt: now });
    state.onboardingCompletedAt = now;
  }

  return {
    dir,
    exists,
    files: fileStatuses,
    hasGitRepo,
    isBootstrapped: isComplete,
    state,
  };
}
