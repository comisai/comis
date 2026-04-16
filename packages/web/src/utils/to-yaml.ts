/**
 * Simple YAML serializer for config preview.
 *
 * Handles strings, numbers, booleans, arrays, and nested objects.
 * Skips undefined, null, and empty-string values.
 * Uses 2-space indentation. No external library.
 */
export function toYaml(obj: Record<string, unknown>, indent = 0): string {
  const lines: string[] = [];
  const pad = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${pad}${key}:`);
      for (const item of value) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const nested = toYaml(item as Record<string, unknown>, indent + 2);
          const nestedLines = nested.split("\n").filter(Boolean);
          if (nestedLines.length > 0) {
            lines.push(`${pad}  - ${nestedLines[0].trimStart()}`);
            for (let i = 1; i < nestedLines.length; i++) {
              lines.push(`${pad}    ${nestedLines[i].trimStart()}`);
            }
          }
        } else {
          lines.push(`${pad}  - ${formatScalar(item)}`);
        }
      }
    } else if (typeof value === "object") {
      const nested = toYaml(value as Record<string, unknown>, indent + 1);
      if (nested.trim()) {
        lines.push(`${pad}${key}:`);
        lines.push(nested);
      }
    } else {
      lines.push(`${pad}${key}: ${formatScalar(value)}`);
    }
  }

  return lines.join("\n");
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") {
    // Quote strings that contain special YAML characters
    if (/[:#{}[\],&*?|>!%@`'"]/.test(value) || value.includes("\n")) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return String(value);
}
