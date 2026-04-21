// SPDX-License-Identifier: Apache-2.0
/**
 * Validation error formatter -- rewrites AJV validation errors from pi-ai's
 * validateToolArguments() into concise, LLM-friendly error messages.
 *
 * The pi-ai SDK produces verbose validation errors containing AJV's generic
 * messages plus a full JSON dump of received arguments. This formatter
 * transforms those into actionable messages: naming the tool, identifying the
 * parameter, stating what was expected, and omitting the verbose argument dump.
 *
 * Pure function, no side effects, no external dependencies.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Header regex
// ---------------------------------------------------------------------------

/** Matches the pi-ai validation error header line. */
const HEADER_RE = /^Validation failed for tool "([^"]+)":/;

/** Matches an individual error line: " - path: message" */
const ERROR_LINE_RE = /^\s+-\s+(.+?):\s+(.+)$/;

/** Matches AJV "must have required property 'NAME'" */
const REQUIRED_RE = /^must have required property '([^']+)'$/;

/** Matches AJV type constraint: "must be string", "must be number", etc. */
const TYPE_RE = /^must be (string|number|boolean|array|object|integer)$/;

/** Matches AJV enum constraint: "must be equal to one of the allowed values" */
const ENUM_RE = /^must be equal to one of the allowed values$/;

/** Matches AJV additional properties rejection */
const ADDITIONAL_PROPS_RE = /^must NOT have additional properties$/;

// ---------------------------------------------------------------------------
// Path conversion
// ---------------------------------------------------------------------------

/**
 * Convert AJV instance path format to dot notation.
 *
 * - "/edits/0/oldText" -> "edits[0].oldText"
 * - "root" or simple name -> returned as-is
 */
function convertInstancePath(path: string): string {
  if (!path.startsWith("/")) return path;

  const segments = path.slice(1).split("/");
  let result = "";

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isIndex = /^\d+$/.test(seg);

    if (isIndex) {
      result += `[${seg}]`;
    } else if (i === 0) {
      result = seg;
    } else {
      result += `.${seg}`;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Message rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite a single AJV error (path + message) into LLM-friendly text.
 */
function rewriteErrorMessage(path: string, message: string): string {
  const displayPath = convertInstancePath(path);

  // "must have required property 'X'" -> "Required parameter `X` is missing"
  const requiredMatch = REQUIRED_RE.exec(message);
  if (requiredMatch) {
    const propName = requiredMatch[1]!;
    // For nested paths, prepend the path to the property name
    const fullPath = displayPath.startsWith("/") || displayPath === path
      ? propName
      : displayPath.endsWith(propName)
        ? displayPath
        : `${displayPath}.${propName}`;
    return `Required parameter \`${fullPath}\` is missing`;
  }

  // "must be {type}" -> "`path` expected {type}"
  const typeMatch = TYPE_RE.exec(message);
  if (typeMatch) {
    return `\`${displayPath}\` expected ${typeMatch[1]}`;
  }

  // "must be equal to one of the allowed values" -> simplified
  if (ENUM_RE.test(message)) {
    return `\`${displayPath}\` must be one of the allowed values`;
  }

  // "must NOT have additional properties" -> "unknown parameter"
  if (ADDITIONAL_PROPS_RE.test(message)) {
    return "unknown parameter (not accepted by this tool)";
  }

  // Everything else: pass through with path prefix
  return `\`${displayPath}\` ${message}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse raw AJV validation error text from pi-ai and rewrite it into a
 * concise, LLM-friendly format.
 *
 * @param errorText - The raw error string from a tool result
 * @returns Reformatted error string, or `null` if the text is not a
 *          validation error matching the pi-ai pattern
 */
export function formatValidationError(errorText: string): string | null {
  // Quick exit for non-validation errors
  const headerMatch = HEADER_RE.exec(errorText);
  if (!headerMatch) return null;

  const toolName = headerMatch[1]!;

  // Strip "Received arguments:" section (everything after the blank line)
  const receivedIdx = errorText.indexOf("\n\nReceived arguments:");
  const errorSection = receivedIdx >= 0
    ? errorText.slice(0, receivedIdx)
    : errorText;

  // Parse individual error lines
  const lines = errorSection.split("\n").slice(1); // skip header line
  const rewritten: string[] = [];

  for (const line of lines) {
    const match = ERROR_LINE_RE.exec(line);
    if (!match) continue;

    const path = match[1]!;
    const message = match[2]!;
    rewritten.push(rewriteErrorMessage(path, message));
  }

  if (rewritten.length === 0) return null;

  return `[${toolName}] Invalid parameters:\n${rewritten.map((r) => `- ${r}`).join("\n")}`;
}
