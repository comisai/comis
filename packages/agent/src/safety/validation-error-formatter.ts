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

/**
 * Resolves the accepted values for a failing parameter, given its dot-notation
 * path. Returns undefined when the parameter is not a known enum.
 */
export type AllowedValuesResolver = (parameterPath: string) => string[] | undefined;

/** Matches the pi-ai validation error header line. */
const HEADER_RE = /^Validation failed for tool "([^"]+)":/;

/** Matches an individual error line: " - path: message" */
const ERROR_LINE_RE = /^\s+-\s+(.+?):\s+(.+)$/;

/** Matches AJV "must have required property 'NAME'" */
const REQUIRED_RE = /^must have required property '([^']+)'$/;

/**
 * Matches the PLURAL, unquoted required-properties form (TypeBox), e.g.
 * `must have required properties body` or `must have required properties from, to`.
 *
 * Unmatched, such a line passed through verbatim and rendered as the path followed by its own
 * message — "`body` must have required properties body" — which names the missing field as its own
 * requirement. Live: a model read exactly that and burned four calls guessing at the shape.
 */
const REQUIRED_PLURAL_RE = /^must have required propert(?:y|ies)\s+(.+)$/;

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
function rewriteErrorMessage(
  path: string,
  message: string,
  allowedValuesFor?: AllowedValuesResolver,
): string {
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

  // The plural/unquoted form. Handled AFTER the singular quoted rule so AJV's shape keeps its
  // existing path arithmetic untouched.
  const pluralMatch = REQUIRED_PLURAL_RE.exec(message);
  if (pluralMatch) {
    const names = pluralMatch[1]!
      .split(",")
      .map((n) => n.trim().replace(/^['"`]|['"`]$/g, ""))
      .filter((n) => n.length > 0);
    if (names.length > 0) {
      // A container path qualifies the field so the caller knows WHERE it belongs; but when the
      // path is already that field (or is the document root) qualifying it would produce
      // "body.body", which is the tautology this rule exists to remove.
      const container = displayPath === "root" || displayPath === "" ? "" : displayPath;
      const qualified = names.map((name) => {
        const full = container === "" || container === name ? name : `${container}.${name}`;
        return `\`${full}\``;
      });
      return names.length === 1
        ? `Required parameter ${qualified[0]!} is missing`
        : `Required parameters ${qualified.join(", ")} are missing`;
    }
  }

  // "must be {type}" -> "`path` expected {type}"
  const typeMatch = TYPE_RE.exec(message);
  if (typeMatch) {
    return `\`${displayPath}\` expected ${typeMatch[1]}`;
  }

  // "must be equal to one of the allowed values" -> name the values when the
  // caller can resolve them from the tool's own schema. AJV's wording omits
  // them, which leaves a model retrying the same rejected argument.
  if (ENUM_RE.test(message)) {
    const allowed = allowedValuesFor?.(displayPath);
    if (allowed !== undefined && allowed.length > 0) {
      return `\`${displayPath}\` must be one of: ${allowed.join(", ")}`;
    }
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
 * @param allowedValuesFor - Optional resolver returning the accepted values for
 *        a failing parameter, so an enum rejection can name them. Omitting it
 *        keeps the previous generic wording byte-identical.
 * @returns Reformatted error string, or `null` if the text is not a
 *          validation error matching the pi-ai pattern
 */
export function formatValidationError(
  errorText: string,
  allowedValuesFor?: AllowedValuesResolver,
): string | null {
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
    rewritten.push(rewriteErrorMessage(path, message, allowedValuesFor));
  }

  if (rewritten.length === 0) return null;

  return `[${toolName}] Invalid parameters:\n${rewritten.map((r) => `- ${r}`).join("\n")}`;
}
