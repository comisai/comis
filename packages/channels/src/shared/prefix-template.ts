/**
 * Tokenizer-based template engine for response prefix/suffix.
 *
 * Resolves templates like `{agent.emoji} {model|short}{?thinking: | think}`
 * using a single-pass tokenizer and linear resolver. No String.replace() is
 * used for template variable substitution -- values are concatenated directly
 * to prevent injection via adversarial variable content.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

/** Token produced by the template tokenizer. */
export type TemplateToken =
  | { type: "literal"; value: string }
  | { type: "variable"; name: string; formatter?: string }
  | { type: "conditional"; variable: string; text: string };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a template string into an array of tokens.
 * Single-pass character scan -- no regex on the overall template.
 *
 * Syntax:
 *   {varName}           -> variable token
 *   {varName|formatter} -> variable with pipe formatter token
 *   {?varName:text}     -> conditional token (renders text when varName is truthy)
 *   literal text        -> literal token
 *   unclosed {          -> treated as literal (rest of string)
 */
export function tokenizeTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let i = 0;
  let literalStart = 0;

  while (i < template.length) {
    if (template[i] === "{") {
      // Flush preceding literal
      if (i > literalStart) {
        tokens.push({ type: "literal", value: template.slice(literalStart, i) });
      }

      const closeIdx = template.indexOf("}", i + 1);
      if (closeIdx === -1) {
        // Unclosed brace -- treat rest of string as literal
        tokens.push({ type: "literal", value: template.slice(i) });
        return tokens;
      }

      const inner = template.slice(i + 1, closeIdx);

      if (inner.startsWith("?")) {
        // Conditional: {?var:text}
        const colonIdx = inner.indexOf(":");
        if (colonIdx > 1) {
          tokens.push({
            type: "conditional",
            variable: inner.slice(1, colonIdx),
            text: inner.slice(colonIdx + 1),
          });
        }
      } else if (inner.includes("|")) {
        // Variable with formatter: {var|fmt}
        const pipeIdx = inner.indexOf("|");
        tokens.push({
          type: "variable",
          name: inner.slice(0, pipeIdx),
          formatter: inner.slice(pipeIdx + 1),
        });
      } else {
        // Plain variable: {var}
        tokens.push({ type: "variable", name: inner });
      }

      i = closeIdx + 1;
      literalStart = i;
    } else {
      i++;
    }
  }

  // Trailing literal
  if (literalStart < template.length) {
    tokens.push({ type: "literal", value: template.slice(literalStart) });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Known provider/model name to emoji mapping for the "emoji" formatter. */
const EMOJI_MAP: Record<string, string> = {
  anthropic: "\u{1F9E0}",  // brain
  openai: "\u{1F916}",     // robot
  google: "\u{1F48E}",     // gem
  meta: "\u{1F30D}",       // globe
  mistral: "\u{1F32C}\uFE0F", // wind
};

/** Built-in formatters for pipe syntax ({var|formatter}). */
export const FORMATTERS: Record<string, (v: string) => string> = {
  /** Split on `-`, take first 2 segments. e.g. "claude-sonnet-4-5-20250929" -> "claude-sonnet" */
  short: (v) => v.split("-").slice(0, 2).join("-"),
  /** UPPERCASE */
  upper: (v) => v.toUpperCase(),
  /** lowercase */
  lower: (v) => v.toLowerCase(),
  /** Map known provider/model names to emoji. Unknown -> empty string. */
  emoji: (v) => EMOJI_MAP[v.toLowerCase()] ?? "",
  /** First character uppercased. */
  initial: (v) => (v.length > 0 ? v.charAt(0).toUpperCase() : ""),
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve tokens against a context. Single-pass, no recursion.
 *
 * Variable values are NEVER re-parsed as template syntax -- they are
 * concatenated directly into the output string.
 */
export function resolveTokens(
  tokens: TemplateToken[],
  ctx: Record<string, string>,
  formatters: Record<string, (v: string) => string>,
): string {
  const parts: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "literal":
        parts.push(token.value);
        break;
      case "variable": {
        let value = ctx[token.name] ?? "";
        if (value && token.formatter && formatters[token.formatter]) {
          value = formatters[token.formatter](value);
        }
        parts.push(value);
        break;
      }
      case "conditional": {
        const value = ctx[token.variable] ?? "";
        // Truthy: non-empty and not "off"
        if (value && value !== "off") {
          parts.push(token.text);
        }
        break;
      }
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Public convenience function
// ---------------------------------------------------------------------------

/**
 * Apply a prefix (or suffix) template to response text.
 *
 * If the template is empty or resolves to whitespace-only, returns text unchanged.
 */
export function applyPrefix(
  text: string,
  config: { template: string; position: "prepend" | "append" },
  ctx: Record<string, string>,
): string {
  if (!config.template) return text;

  const tokens = tokenizeTemplate(config.template);
  const resolved = resolveTokens(tokens, ctx, FORMATTERS);

  if (!resolved.trim()) return text;

  return config.position === "prepend"
    ? `${resolved}\n${text}`
    : `${text}\n${resolved}`;
}
