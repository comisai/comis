/**
 * Prompt Skill Command Matcher: Pure function to match /skill:name [args] syntax.
 *
 * Designed as a second-pass parser after parseSlashCommand(). The system command
 * parser runs first; if it returns found: false, this matcher checks for the
 * /skill:name colon-namespace pattern.
 *
 * Also provides collision detection for skill names that shadow reserved command names.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

/**
 * Regex for /skill:name [optional args] syntax.
 *
 * - Anchored to start of (trimmed) string
 * - `/skill:` literal prefix (colon namespace)
 * - Name: starts with word char, allows word chars and hyphens
 * - Optional whitespace + rest captured as args
 * - `i` flag: case-insensitive prefix (/Skill:name, /SKILL:name)
 * - `s` flag: `.` matches newlines in args (consistent with parseSlashCommand)
 */
const SKILL_COMMAND_RE = /^\/skill:([\w][\w-]*)(?:\s+(.*))?$/si;

// ---------------------------------------------------------------------------
// Match types
// ---------------------------------------------------------------------------

/** Result of a successful skill command match. */
export interface PromptSkillMatch {
  /** Canonical skill name (from the registry, not the user input). */
  name: string;
  /** Raw user arguments trimmed. Empty string if none. */
  args: string;
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/**
 * Match a `/skill:name [args]` command in message text.
 *
 * Must be called AFTER parseSlashCommand() returns found: false.
 * Returns null if:
 * - Text doesn't match /skill:name pattern
 * - Matched name is not in the known skill names set
 *
 * @param text - The raw message text
 * @param skillNames - Set of user-invocable skill names (from getUserInvocableSkillNames)
 * @returns Match with canonical name and args, or null
 */
export function matchPromptSkillCommand(
  text: string,
  skillNames: Set<string>,
): PromptSkillMatch | null {
  const trimmed = text.trim();

  // Reset lastIndex in case of prior stateful usage (defensive)
  SKILL_COMMAND_RE.lastIndex = 0;

  const match = SKILL_COMMAND_RE.exec(trimmed);
  if (!match) return null;

  const rawName = match[1]!;
  const args = (match[2] ?? "").trim();

  // Case-insensitive lookup for canonical name
  const lowerName = rawName.toLowerCase();
  let canonicalName: string | undefined;
  for (const name of skillNames) {
    if (name.toLowerCase() === lowerName) {
      canonicalName = name;
      break;
    }
  }

  // Unknown skill: pass through as regular text
  if (!canonicalName) return null;

  return { name: canonicalName, args };
}

// ---------------------------------------------------------------------------
// Reserved command names
// ---------------------------------------------------------------------------

/** Reserved command names that skill names should not shadow. */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set<string>([
  // Current system commands (mirrors KNOWN_COMMANDS in command-parser.ts)
  "think", "verbose", "reasoning",
  "context", "status", "usage",
  "model", "new", "reset", "compact",
  // Anticipated future commands (prevents retroactive collisions)
  "help", "skills", "config", "debug", "version", "whoami", "stop", "continue",
  // The namespace prefix itself
  "skill",
]);

// ---------------------------------------------------------------------------
// Collision detection types
// ---------------------------------------------------------------------------

/** Warning for a skill name that collides with a reserved command name. */
export interface CollisionWarning {
  /** The skill name that collides. */
  skillName: string;
  /** The reserved command name it collides with (lowercased). */
  collidesWithCommand: string;
  /** Human-readable warning message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

/**
 * Detect skill names that shadow reserved command names.
 *
 * Called at discovery/init time, not at parse time. Returns structured
 * warnings for logging.
 *
 * @param skillNames - Set of discovered skill names
 * @param reservedNames - Set of reserved names (defaults to RESERVED_COMMAND_NAMES)
 * @returns Array of collision warnings (empty if no collisions)
 */
export function detectSkillCollisions(
  skillNames: Set<string>,
  reservedNames: ReadonlySet<string> = RESERVED_COMMAND_NAMES,
): CollisionWarning[] {
  const warnings: CollisionWarning[] = [];
  for (const name of skillNames) {
    const lower = name.toLowerCase();
    if (reservedNames.has(lower)) {
      warnings.push({
        skillName: name,
        collidesWithCommand: lower,
        message: `Skill "${name}" shadows reserved command "/${lower}". Users must use /skill:${name} to invoke it.`,
      });
    }
  }
  return warnings;
}
