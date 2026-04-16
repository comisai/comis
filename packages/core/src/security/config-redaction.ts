/**
 * Config secret redaction — deep-clones a config object and replaces
 * secret-bearing fields with "[REDACTED]".
 *
 * Used by config.read RPC handlers to prevent credential exposure.
 * Field names are matched case-insensitively against a known pattern.
 */

/** Pattern matching field names that contain secrets. */
export const SECRET_FIELD_PATTERN = /^(.*token|.*secret|.*password|.*apiKey|.*api_key|.*credential|.*private_key|botToken|appSecret|hmacSecret|webhookSecret)$/i;

/**
 * Deep-clone a config object and replace all string fields matching
 * secret field name patterns with "[REDACTED]".
 *
 * IMPORTANT: Always operates on a structuredClone -- the input is never mutated.
 *
 * @param config - The config object to redact
 * @returns A deep clone with secret fields replaced
 */
export function redactConfigSecrets<T>(config: T): T {
  const cloned = structuredClone(config);
  walk(cloned);
  return cloned;
}

function walk(obj: unknown): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) walk(item);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SECRET_FIELD_PATTERN.test(key) && typeof record[key] === "string") {
      record[key] = "[REDACTED]";
    } else {
      walk(record[key]);
    }
  }
}
