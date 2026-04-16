/**
 * Git-backed config versioning module.
 *
 * Provides init, commit, history, diff, rollback, and conflict detection
 * for config YAML files. All git CLI interactions are encapsulated behind
 * a testable factory interface with injectable execGit dependency.
 *
 * Git failures never block config operations — all methods return Result,
 * never throw (best-effort versioning).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured metadata stored in git commit messages.
 *
 * Encoded as `[key] value` lines in the commit body for later parsing.
 */
export interface GitCommitMetadata {
  /** Config section that was changed (e.g., "agent", "gateway") */
  section: string;
  /** Specific config key path within the section */
  key?: string;
  /** Agent ID that initiated the change */
  agent?: string;
  /** User/operator who initiated the change */
  user?: string;
  /** Request trace ID for correlation */
  traceId?: string;
  /** Human-readable summary of the change */
  summary: string;
}

/**
 * Parsed history entry from git log output.
 */
export interface HistoryEntry {
  /** Full commit SHA */
  sha: string;
  /** ISO 8601 timestamp of the commit */
  timestamp: string;
  /** Parsed structured metadata from commit message */
  metadata: GitCommitMetadata;
  /** Full commit message (first line) */
  message: string;
}

/**
 * Injectable git command executor for testability.
 *
 * Accepts git arguments and a working directory, returns stdout on success
 * or an error message on failure.
 */
export type ExecGitFn = (
  args: string[],
  cwd: string,
) => Promise<Result<string, string>>;

/**
 * Injectable dependencies for the git manager factory.
 *
 * Follows the same pattern as BackupDeps — injectable for deterministic testing.
 */
export interface GitManagerDeps {
  /** Absolute path to the config directory where .git will live */
  configDir: string;
  /** Injectable git command executor */
  execGit: ExecGitFn;
  /** Write a file to the config directory (for .gitignore creation) */
  writeFile: (relativePath: string, content: string) => Promise<Result<void, string>>;
  /** Remove a directory recursively (for auto-reinit .git cleanup) */
  removeDir?: (relativePath: string) => Promise<Result<void, string>>;
  /** Optional logger for debug/warning messages */
  logger?: {
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

/**
 * Config git versioning interface.
 *
 * All methods return Result — git failures are reported but never thrown.
 */
export interface ConfigGitManager {
  /** Initialize git repo in config directory (idempotent) */
  init(): Promise<Result<void, string>>;
  /** Commit current YAML state with structured metadata */
  commit(metadata: GitCommitMetadata): Promise<Result<string, string>>;
  /** Query commit history with optional limit and section filter */
  history(opts?: {
    limit?: number;
    section?: string;
  }): Promise<Result<HistoryEntry[], string>>;
  /** Get unified diff between commits */
  diff(sha?: string): Promise<Result<string, string>>;
  /** Restore config from a historical commit (forward rollback) */
  rollback(sha: string): Promise<Result<string, string>>;
  /** Check for uncommitted YAML changes */
  checkDirty(): Promise<Result<boolean, string>>;
  /** Run git garbage collection to reclaim disk space */
  gc(): Promise<Result<{ prunedObjects: boolean }, string>>;
  /** Squash all commits older than the given ISO timestamp into a single commit */
  squash(olderThan: string): Promise<Result<{ squashedCount: number; newRootSha: string }, string>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** YAML-only whitelist .gitignore content */
export const GITIGNORE_CONTENT = `# Track only YAML config files
*
!*.yaml
!*.yml
!.gitignore
`;

const METADATA_PREFIX = "config: ";
const SECTION_TAG = "[section]";
const KEY_TAG = "[key]";
const AGENT_TAG = "[agent]";
const USER_TAG = "[user]";
const TRACE_TAG = "[trace]";

const CORRUPTION_PATTERNS = [
  "not a git repository",
  "corrupt",
  "fatal: bad object",
  "fatal: reference is not a tree",
];

// ---------------------------------------------------------------------------
// Commit message encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Sanitize a metadata field value for safe embedding in git commit messages.
 * Strips newlines (prevents multi-line injection) and leading `[` characters
 * (prevents confusion with metadata tag parsing in parseCommitMessage).
 */
function sanitizeMetadataField(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/^\[+/, "");
}

/**
 * Encode structured metadata into a git commit message body.
 *
 * Format:
 * ```
 * config: {summary}
 *
 * [section] {section}
 * [key] {key}
 * [agent] {agent}
 * [user] {user}
 * [trace] {traceId}
 * ```
 *
 * Lines with undefined values are omitted.
 */
export function encodeCommitMessage(metadata: GitCommitMetadata): string {
  const lines: string[] = [`${METADATA_PREFIX}${sanitizeMetadataField(metadata.summary)}`, ""];

  lines.push(`${SECTION_TAG} ${sanitizeMetadataField(metadata.section)}`);
  if (metadata.key !== undefined) {
    lines.push(`${KEY_TAG} ${sanitizeMetadataField(metadata.key)}`);
  }
  if (metadata.agent !== undefined) {
    lines.push(`${AGENT_TAG} ${sanitizeMetadataField(metadata.agent)}`);
  }
  if (metadata.user !== undefined) {
    lines.push(`${USER_TAG} ${sanitizeMetadataField(metadata.user)}`);
  }
  if (metadata.traceId !== undefined) {
    lines.push(`${TRACE_TAG} ${sanitizeMetadataField(metadata.traceId)}`);
  }

  return lines.join("\n");
}

/**
 * Parse structured metadata from a git commit message body.
 *
 * Extracts the summary from the first line (after "config: " prefix)
 * and metadata tags from subsequent lines.
 */
export function parseCommitMessage(body: string): GitCommitMetadata {
  const lines = body.split("\n");
  const firstLine = lines[0] ?? "";

  const summary = firstLine.startsWith(METADATA_PREFIX)
    ? firstLine.slice(METADATA_PREFIX.length)
    : firstLine;

  let section = "unknown";
  let key: string | undefined;
  let agent: string | undefined;
  let user: string | undefined;
  let traceId: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(SECTION_TAG)) {
      section = trimmed.slice(SECTION_TAG.length).trim();
    } else if (trimmed.startsWith(KEY_TAG)) {
      key = trimmed.slice(KEY_TAG.length).trim();
    } else if (trimmed.startsWith(AGENT_TAG)) {
      agent = trimmed.slice(AGENT_TAG.length).trim();
    } else if (trimmed.startsWith(USER_TAG)) {
      user = trimmed.slice(USER_TAG.length).trim();
    } else if (trimmed.startsWith(TRACE_TAG)) {
      traceId = trimmed.slice(TRACE_TAG.length).trim();
    }
  }

  return { section, summary, key, agent, user, traceId };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ConfigGitManager instance with injectable dependencies.
 *
 * The git repo is initialized lazily inside the config directory on first
 * commit call. All git failures are caught and returned as err() Results.
 *
 * @example
 * ```ts
 * const gitManager = createConfigGitManager({
 *   configDir: "/etc/comis",
 *   execGit: createExecGit(),
 *   writeFile: async (rel, content) => { ... },
 * });
 * await gitManager.commit({ section: "agent", summary: "Updated model" });
 * ```
 */
export function createConfigGitManager(deps: GitManagerDeps): ConfigGitManager {
  const { configDir, execGit, writeFile, removeDir, logger } = deps;

  /** Track whether init has succeeded at least once this session */
  let initialized = false;

  /**
   * Execute a git command with auto-reinitialize on corruption.
   *
   * If the command fails with a corruption indicator, wipes .git and
   * re-initializes, then retries the command once.
   */
  async function execWithReinit(
    args: string[],
  ): Promise<Result<string, string>> {
    const result = await execGit(args, configDir);

    if (!result.ok) {
      const errorLower = result.error.toLowerCase();
      const isCorruption = CORRUPTION_PATTERNS.some((p) =>
        errorLower.includes(p),
      );

      if (isCorruption) {
        logger?.warn(
          {
            hint: "Config git repo was corrupted or missing, re-initialized",
            errorKind: "internal",
          },
          "Auto-reinitializing config git repo",
        );

        // Wipe and re-initialize
        initialized = false;
        if (removeDir) {
          const rmResult = await removeDir(".git");
          if (!rmResult.ok) {
            return err(`Failed to clean corrupted repo: ${rmResult.error}`);
          }
        }

        const reinitResult = await initRepo();
        if (!reinitResult.ok) {
          return err(reinitResult.error);
        }

        // Retry the original command
        return execGit(args, configDir);
      }
    }

    return result;
  }

  /**
   * Core init logic — creates .git, writes .gitignore, makes initial commit.
   */
  async function initRepo(): Promise<Result<void, string>> {
    if (initialized) {
      return ok(undefined);
    }

    // Check if .git already exists by running git status
    const statusResult = await execGit(["status", "--porcelain"], configDir);
    if (statusResult.ok) {
      // Repo already exists and is functional
      initialized = true;
      return ok(undefined);
    }

    // Initialize new repo
    const gitInitResult = await execGit(["init"], configDir);
    if (!gitInitResult.ok) {
      return err(`git init failed: ${gitInitResult.error}`);
    }

    // Write .gitignore with strict YAML whitelist
    const writeResult = await writeFile(".gitignore", GITIGNORE_CONTENT);
    if (!writeResult.ok) {
      return err(`Failed to write .gitignore: ${writeResult.error}`);
    }

    // Stage .gitignore and any existing YAML files.
    // Run *.yaml and *.yml as separate git-add calls because combining them
    // in one invocation causes a fatal pathspec error when one glob matches
    // no files, aborting the entire add (including the matching glob).
    await execGit(["add", ".gitignore"], configDir);
    await execGit(["add", "*.yaml"], configDir);
    await execGit(["add", "*.yml"], configDir);

    // Create initial commit (allow-empty in case no YAML files exist)
    const commitResult = await execGit(
      ["commit", "--allow-empty", "-m", "Initial config snapshot"],
      configDir,
    );
    if (!commitResult.ok) {
      return err(`Initial commit failed: ${commitResult.error}`);
    }

    initialized = true;
    return ok(undefined);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const manager: ConfigGitManager = {
    async init(): Promise<Result<void, string>> {
      return initRepo();
    },

    async commit(
      metadata: GitCommitMetadata,
    ): Promise<Result<string, string>> {
      // Lazy initialization
      const initResult = await initRepo();
      if (!initResult.ok) {
        return err(initResult.error);
      }

      // Stage all YAML changes (separate calls to avoid fatal pathspec
      // error when one glob matches no files — see initRepo comment).
      await execWithReinit(["add", "*.yaml"]);
      await execWithReinit(["add", "*.yml"]);

      // Build structured commit message
      const message = encodeCommitMessage(metadata);

      // Commit
      const commitResult = await execWithReinit(["commit", "-m", message]);

      if (!commitResult.ok) {
        // "nothing to commit" is not an error — return ok with empty string
        if (commitResult.error.includes("nothing to commit")) {
          return ok("");
        }
        return err(commitResult.error);
      }

      // Get the commit SHA
      const shaResult = await execGit(["rev-parse", "HEAD"], configDir);
      if (!shaResult.ok) {
        // Commit succeeded but SHA retrieval failed — return partial success
        return ok("unknown");
      }

      return ok(shaResult.value.trim());
    },

    async history(
      opts?: { limit?: number; section?: string },
    ): Promise<Result<HistoryEntry[], string>> {
      const initResult = await initRepo();
      if (!initResult.ok) {
        return err(initResult.error);
      }

      const limit = opts?.limit ?? 10;
      const separator = "---END---";

      // When section filter is specified, fetch more to account for filtered-out entries
      const fetchLimit = opts?.section ? limit * 3 : limit;

      const logResult = await execWithReinit([
        "log",
        `--format=%H%n%aI%n%B${separator}`,
        `--max-count=${fetchLimit}`,
      ]);

      if (!logResult.ok) {
        // No commits yet — return empty
        if (logResult.error.includes("does not have any commits")) {
          return ok([]);
        }
        return err(logResult.error);
      }

      const output = logResult.value.trim();
      if (!output) {
        return ok([]);
      }

      // Split by separator and parse each commit
      const rawEntries = output.split(separator);
      const entries: HistoryEntry[] = [];

      for (const raw of rawEntries) {
        const trimmed = raw.trim();
        if (!trimmed) continue;

        const lines = trimmed.split("\n");
        if (lines.length < 2) continue;

        const sha = lines[0]!.trim();
        const timestamp = lines[1]!.trim();
        const bodyLines = lines.slice(2);
        const body = bodyLines.join("\n").trim();
        const firstLine = bodyLines[0]?.trim() ?? "";

        const metadata = parseCommitMessage(body);

        // Apply section filter if specified
        if (opts?.section && metadata.section !== opts.section) {
          continue;
        }

        entries.push({
          sha,
          timestamp,
          metadata,
          message: firstLine,
        });

        // Stop once we have enough entries
        if (entries.length >= limit) {
          break;
        }
      }

      return ok(entries);
    },

    async diff(sha?: string): Promise<Result<string, string>> {
      const initResult = await initRepo();
      if (!initResult.ok) {
        return err(initResult.error);
      }

      let diffArgs: string[];

      if (sha) {
        // Compare specified SHA to HEAD
        diffArgs = ["diff", "-U3", `${sha}..HEAD`, "--", "*.yaml", "*.yml"];
      } else {
        // Compare HEAD~1 to HEAD (current vs previous)
        // First check if HEAD~1 exists
        const parentResult = await execGit(
          ["rev-parse", "--verify", "HEAD~1"],
          configDir,
        );
        if (!parentResult.ok) {
          // Only one commit — no previous version to diff against
          return ok("");
        }
        diffArgs = ["diff", "-U3", "HEAD~1..HEAD", "--", "*.yaml", "*.yml"];
      }

      const diffResult = await execWithReinit(diffArgs);

      if (!diffResult.ok) {
        return err(diffResult.error);
      }

      return ok(diffResult.value);
    },

    async rollback(sha: string): Promise<Result<string, string>> {
      const initResult = await initRepo();
      if (!initResult.ok) {
        return err(initResult.error);
      }

      // Validate SHA exists and is a commit
      const catResult = await execWithReinit(["cat-file", "-t", sha]);
      if (!catResult.ok) {
        return err(`Invalid SHA: ${sha}`);
      }
      if (catResult.value.trim() !== "commit") {
        return err(
          `SHA ${sha} is not a commit (type: ${catResult.value.trim()})`,
        );
      }

      // Restore YAML files from target commit (separate calls to avoid
      // fatal pathspec error when one glob matches no files).
      const checkoutYaml = await execWithReinit([
        "checkout",
        sha,
        "--",
        "*.yaml",
      ]);
      const checkoutYml = await execWithReinit([
        "checkout",
        sha,
        "--",
        "*.yml",
      ]);
      // At least one must succeed for rollback to be meaningful
      if (!checkoutYaml.ok && !checkoutYml.ok) {
        return err(
          `Failed to checkout files from ${sha}: ${checkoutYaml.error}`,
        );
      }

      // Stage restored files (separate calls — same reason as above)
      await execWithReinit(["add", "*.yaml"]);
      await execWithReinit(["add", "*.yml"]);

      // Create forward rollback commit
      const shortSha = sha.slice(0, 7);
      const message = [
        `config: rollback to ${shortSha}`,
        "",
        `${SECTION_TAG} *`,
      ].join("\n");

      const commitResult = await execWithReinit(["commit", "-m", message]);
      if (!commitResult.ok) {
        // Nothing to commit means target state === current state
        if (commitResult.error.includes("nothing to commit")) {
          return ok("");
        }
        return err(`Rollback commit failed: ${commitResult.error}`);
      }

      // Get the new commit SHA
      const newShaResult = await execGit(["rev-parse", "HEAD"], configDir);
      if (!newShaResult.ok) {
        return ok("unknown");
      }

      return ok(newShaResult.value.trim());
    },

    async checkDirty(): Promise<Result<boolean, string>> {
      const initResult = await initRepo();
      if (!initResult.ok) {
        return err(initResult.error);
      }

      const statusResult = await execWithReinit(["status", "--porcelain"]);
      if (!statusResult.ok) {
        return err(statusResult.error);
      }

      return ok(statusResult.value.trim().length > 0);
    },

    async gc(): Promise<Result<{ prunedObjects: boolean }, string>> {
      const initResult = await initRepo();
      if (!initResult.ok) return err(initResult.error);

      const gcResult = await execWithReinit(["gc", "--aggressive", "--prune=now"]);
      if (!gcResult.ok) return err(`git gc failed: ${gcResult.error}`);

      return ok({ prunedObjects: true });
    },

    async squash(olderThan: string): Promise<Result<{ squashedCount: number; newRootSha: string }, string>> {
      const initResult = await initRepo();
      if (!initResult.ok) return err(initResult.error);

      const thresholdMs = new Date(olderThan).getTime();
      if (isNaN(thresholdMs)) return err(`Invalid date: ${olderThan}`);

      // Get all commits oldest-first
      const logResult = await execWithReinit(["log", "--format=%H %aI", "--reverse"]);
      if (!logResult.ok) return err(`Failed to read history: ${logResult.error}`);

      const lines = logResult.value.trim().split("\n").filter(Boolean);
      if (lines.length < 2) return ok({ squashedCount: 0, newRootSha: "" });

      const commits = lines.map((line) => {
        const spaceIdx = line.indexOf(" ");
        return { sha: line.slice(0, spaceIdx), timestamp: new Date(line.slice(spaceIdx + 1)).getTime() };
      });

      const oldCommits = commits.filter((c) => c.timestamp < thresholdMs);
      if (oldCommits.length < 2) return ok({ squashedCount: 0, newRootSha: "" });

      // Newest old commit becomes the squash boundary
      const squashTarget = oldCommits[oldCommits.length - 1]!;

      // Get the tree object of the squash target
      const treeResult = await execWithReinit(["rev-parse", `${squashTarget.sha}^{tree}`]);
      if (!treeResult.ok) return err(`Failed to get tree: ${treeResult.error}`);
      const treeSha = treeResult.value.trim();

      // Create new orphan root commit with squash target's tree state
      const squashMessage = `config: squashed ${oldCommits.length} history entries\n\n[section] *`;
      const newRootResult = await execWithReinit(["commit-tree", treeSha, "-m", squashMessage]);
      if (!newRootResult.ok) return err(`Failed to create squash commit: ${newRootResult.error}`);
      const newRootSha = newRootResult.value.trim();

      // Get current branch name
      const branchResult = await execGit(["symbolic-ref", "--short", "HEAD"], configDir);
      const branch = branchResult.ok ? branchResult.value.trim() : "master";

      // Check if there are newer commits after the squash boundary
      const squashTargetIdx = commits.findIndex((c) => c.sha === squashTarget.sha);
      const newerCommits = commits.slice(squashTargetIdx + 1);

      if (newerCommits.length === 0) {
        // All commits were old -- point HEAD to the new squashed root
        await execWithReinit(["update-ref", `refs/heads/${branch}`, newRootSha]);
        await execWithReinit(["reset", "--hard", newRootSha]);
        return ok({ squashedCount: oldCommits.length, newRootSha });
      }

      // Rebase newer commits onto the new root
      const rebaseResult = await execWithReinit(["rebase", "--onto", newRootSha, squashTarget.sha, branch]);
      if (!rebaseResult.ok) {
        await execWithReinit(["rebase", "--abort"]);
        return err(`Squash rebase failed: ${rebaseResult.error}`);
      }

      return ok({ squashedCount: oldCommits.length, newRootSha });
    },
  };

  return manager;
}
