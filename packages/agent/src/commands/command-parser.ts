/**
 * Slash Command Parser: Pure function to parse slash commands from message text.
 *
 * Parses commands at the START of a message only. Never matches mid-text slashes.
 * Directives (/think, /verbose, /reasoning) can be followed by body text that
 * becomes the cleaned message. Standalone commands occupy the entire message.
 *
 * @module
 */

import type { CommandType, ParsedCommand } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Set of all recognized command names */
const KNOWN_COMMANDS = new Set<string>([
  "think", "verbose", "reasoning",
  "context", "status", "usage", "config",
  "model",
  "new", "reset",
  "compact", "export",
  "stop",
  "fork", "branch",
  "budget",
]);

/** Commands that are directives (stripped from text, modify execution state) */
const DIRECTIVE_COMMANDS = new Set<string>(["think", "verbose", "reasoning", "budget"]);

/** Valid level arguments for /think */
const THINK_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Valid toggle arguments for /verbose and /reasoning */
const TOGGLE_ARGS = new Set<string>(["on", "off"]);

/** Pattern matching budget amount arguments: digits followed by k or m suffix */
const BUDGET_ARG_PATTERN = /^\d+(k|m)$/i;

// ---------------------------------------------------------------------------
// Not-found result
// ---------------------------------------------------------------------------

function notFound(text: string): ParsedCommand {
  return {
    found: false,
    args: [],
    cleanedText: text,
    isDirective: false,
    isStandalone: false,
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a message text string for slash commands.
 *
 * Rules:
 * 1. Only matches when the message starts with a known `/command`
 * 2. The regex anchors to `^` to prevent mid-text matching
 * 3. Directives can have body text (e.g., `/think What about X?`)
 * 4. Standalone commands have no remaining text for the LLM
 * 5. Unknown commands (e.g., `/unknown`) return `found: false`
 *
 * @param text - The raw message text
 * @returns ParsedCommand with command info and cleaned text
 */
export function parseSlashCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  // Must start with /
  if (!trimmed.startsWith("/")) {
    return notFound(trimmed);
  }

  // Match: /command [optional rest]
  // The `s` flag makes `.` match newlines in the rest
  const match = /^\/(\w+)(?:\s+(.*))?$/s.exec(trimmed);
  if (!match) {
    return notFound(trimmed);
  }

  const commandName = match[1]!;
  const restOfText = match[2] ?? "";

  // Must be a known command
  if (!KNOWN_COMMANDS.has(commandName)) {
    return notFound(trimmed);
  }

  const command = commandName as CommandType;
  const isDirective = DIRECTIVE_COMMANDS.has(commandName);

  // Handle directive commands with potential body text
  if (isDirective) {
    return parseDirective(command, restOfText);
  }

  // Non-directive commands: always standalone
  const args = restOfText ? splitArgs(restOfText) : [];
  return {
    found: true,
    command,
    args,
    cleanedText: "",
    isDirective: false,
    isStandalone: true,
  };
}

// ---------------------------------------------------------------------------
// Directive parsing
// ---------------------------------------------------------------------------

/**
 * Parse a directive command, distinguishing between arguments and body text.
 *
 * - `/think` alone -> standalone toggle
 * - `/think high` -> standalone with level arg
 * - `/think What about X?` -> directive with body text
 * - `/verbose on` -> standalone with toggle arg
 * - `/verbose Tell me more` -> directive with body text
 */
function parseDirective(command: CommandType, restOfText: string): ParsedCommand {
  // No rest = standalone directive
  if (!restOfText) {
    return {
      found: true,
      command,
      args: [],
      cleanedText: "",
      isDirective: true,
      isStandalone: true,
    };
  }

  const firstWord = restOfText.split(/\s+/)[0]!.toLowerCase();

  // Check if first word is a recognized argument for this directive
  if (command === "think" && THINK_LEVELS.has(firstWord)) {
    return {
      found: true,
      command,
      args: [firstWord],
      cleanedText: "",
      isDirective: true,
      isStandalone: true,
    };
  }

  if ((command === "verbose" || command === "reasoning") && TOGGLE_ARGS.has(firstWord)) {
    return {
      found: true,
      command,
      args: [firstWord],
      cleanedText: "",
      isDirective: true,
      isStandalone: true,
    };
  }

  // Budget directive: extract budget amount (e.g., "500k", "2m") into args[0]
  if (command === "budget" && BUDGET_ARG_PATTERN.test(firstWord)) {
    const remaining = restOfText.slice(firstWord.length).trim();
    if (remaining) {
      return {
        found: true,
        command,
        args: [firstWord],
        cleanedText: remaining,
        isDirective: true,
        isStandalone: false,
      };
    }
    return {
      found: true,
      command,
      args: [firstWord],
      cleanedText: "",
      isDirective: true,
      isStandalone: true,
    };
  }

  // Otherwise, everything after the directive is body text
  return {
    found: true,
    command,
    args: [],
    cleanedText: restOfText,
    isDirective: true,
    isStandalone: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split text into arguments (first 10 whitespace-separated tokens).
 */
function splitArgs(text: string): string[] {
  return text.trim().split(/\s+/).slice(0, 10);
}
