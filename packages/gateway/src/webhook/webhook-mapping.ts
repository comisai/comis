import { ok, type Result } from "@comis/shared";
import type { WebhookMappingConfig } from "@comis/core";

/**
 * Context available to template expressions during webhook processing.
 */
export interface WebhookMappingContext {
  /** Parsed JSON payload from the webhook request body */
  readonly payload: unknown;
  /** HTTP headers from the webhook request (lowercased keys) */
  readonly headers: Record<string, string>;
  /** URL query parameters */
  readonly query: Record<string, string>;
  /** URL path segment (after base webhook path) */
  readonly path: string;
  /** Current ISO 8601 timestamp */
  readonly now: string;
}

/**
 * Normalize a webhook match path by stripping leading/trailing slashes
 * and converting to lowercase.
 *
 * @example
 * normalizeMatchPath("/gmail/")  // "gmail"
 * normalizeMatchPath("GitHub")   // "github"
 * normalizeMatchPath("")         // ""
 */
export function normalizeMatchPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").toLowerCase();
}

/**
 * Resolve a template expression against the webhook context.
 *
 * Supports:
 * - `payload.field.nested` — dot-path traversal into payload
 * - `payload.items[0].name` — array index notation
 * - `headers.x-github-event` — header access
 * - `query.key` — query parameter access
 * - `path` — request path
 * - `now` — current ISO timestamp
 * - Top-level fields without prefix (e.g., `repository.full_name` resolves from payload)
 *
 * @returns The resolved value, or undefined if the path cannot be resolved
 */
export function resolveTemplateExpr(expr: string, ctx: WebhookMappingContext): unknown {
  const trimmed = expr.trim();

  // Direct context properties
  if (trimmed === "path") return ctx.path;
  if (trimmed === "now") return ctx.now;

  // Determine the root object and remaining path
  let root: unknown;
  let remaining: string;

  if (trimmed.startsWith("payload.") || trimmed.startsWith("payload[")) {
    root = ctx.payload;
    remaining = trimmed.slice("payload".length + (trimmed[7] === "." ? 1 : 0));
  } else if (trimmed.startsWith("headers.")) {
    root = ctx.headers;
    remaining = trimmed.slice("headers.".length);
  } else if (trimmed.startsWith("query.")) {
    root = ctx.query;
    remaining = trimmed.slice("query.".length);
  } else {
    // No recognized prefix -- resolve against payload (allows {{repository.full_name}})
    root = ctx.payload;
    remaining = trimmed;
  }

  if (!remaining) return root;

  return traverseDotPath(root, remaining);
}

/**
 * Traverse an object using a dot-separated path with optional array index notation.
 *
 * @example
 * traverseDotPath({ a: { b: [{ c: 1 }] } }, "a.b[0].c") // 1
 */
function traverseDotPath(obj: unknown, path: string): unknown {
  // Split on dots, but also handle bracket notation like "items[0]"
  const segments = path.split(".");
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    // Check for array index notation: fieldName[N]
    const bracketMatch = /^([^[]*)\[(\d+)\]$/.exec(segment);
    if (bracketMatch) {
      const [, field, indexStr] = bracketMatch;
      const index = Number(indexStr);

      // First resolve the field (if present), then index into the array
      if (field) {
        current = (current as Record<string, unknown>)[field];
        if (!Array.isArray(current)) return undefined;
        current = current[index];
      } else {
        // Pure index like [0] (after a field that returned an array)
        if (!Array.isArray(current)) return undefined;
        current = current[index];
      }
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

/**
 * Render a template string by replacing `{{expression}}` placeholders
 * with values resolved from the webhook context.
 *
 * Unresolved expressions are replaced with empty strings.
 *
 * @param template - Template string with `{{expr}}` placeholders
 * @param ctx - Webhook mapping context (payload, headers, query, path, now)
 * @returns Result containing the rendered string
 */
export function renderTemplate(template: string, ctx: WebhookMappingContext): Result<string, Error> {
  const rendered = template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expr: string) => {
    const value = resolveTemplateExpr(expr.trim(), ctx);
    return value !== undefined && value !== null ? String(value) : "";
  });
  return ok(rendered);
}

/**
 * Find the first webhook mapping that matches the given request path and source.
 *
 * Match logic:
 * - If a mapping has `match.path`, the normalized request path must equal it
 * - If a mapping has `match.source`, the request source must equal it
 * - If both are present, both must match (AND logic)
 * - If neither is present, the mapping matches all requests (catch-all)
 * - First match wins (mappings are evaluated in order)
 *
 * @param mappings - Array of webhook mapping configurations
 * @param reqPath - The request path (will be normalized)
 * @param reqSource - Optional source identifier from the request
 * @returns The first matching mapping, or undefined if none match
 */
export function resolveWebhookMapping(
  mappings: WebhookMappingConfig[],
  reqPath: string,
  reqSource?: string,
): WebhookMappingConfig | undefined {
  const normalizedReqPath = normalizeMatchPath(reqPath);

  for (const mapping of mappings) {
    const match = mapping.match;

    // No match conditions = catch-all
    if (!match) return mapping;

    let pathMatches = true;
    let sourceMatches = true;

    if (match.path !== undefined) {
      pathMatches = normalizeMatchPath(match.path) === normalizedReqPath;
    }

    if (match.source !== undefined) {
      sourceMatches = match.source === reqSource;
    }

    if (pathMatches && sourceMatches) return mapping;
  }

  return undefined;
}
