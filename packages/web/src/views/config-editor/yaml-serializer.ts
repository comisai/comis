/**
 * YAML serialize/parse utility functions for the config editor.
 * Pure functions, not a Lit component.
 *
 * @module config-editor/yaml-serializer
 */

/**
 * Lightweight YAML serializer for Comis config objects.
 * Handles strings, numbers, booleans, null, arrays, and nested objects.
 * No anchors, aliases, or multiline block scalars.
 */
export function serializeYaml(obj: unknown, indent = 0): string {
  const prefix = "  ".repeat(indent);

  if (obj === null || obj === undefined) {
    return "null";
  }

  if (typeof obj === "boolean") {
    return obj ? "true" : "false";
  }

  if (typeof obj === "number") {
    return String(obj);
  }

  if (typeof obj === "string") {
    if (
      obj === "" ||
      obj.includes(":") ||
      obj.includes("#") ||
      obj.includes("\n") ||
      obj.includes('"') ||
      obj.includes("'") ||
      obj.startsWith(" ") ||
      obj.endsWith(" ") ||
      obj === "true" ||
      obj === "false" ||
      obj === "null" ||
      /^\d+(\.\d+)?$/.test(obj)
    ) {
      return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    const lines: string[] = [];
    for (const item of obj) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          lines.push(`${prefix}- ${firstKey}: ${serializeYaml(firstVal, 0)}`);
          for (let i = 1; i < entries.length; i++) {
            const [key, val] = entries[i];
            lines.push(`${prefix}  ${key}: ${serializeYaml(val, indent + 2)}`);
          }
        } else {
          lines.push(`${prefix}- {}`);
        }
      } else {
        lines.push(`${prefix}- ${serializeYaml(item, 0)}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines: string[] = [];
    for (const [key, val] of entries) {
      if (typeof val === "object" && val !== null && !Array.isArray(val) && Object.keys(val).length > 0) {
        lines.push(`${prefix}${key}:`);
        lines.push(serializeYaml(val, indent + 1));
      } else if (Array.isArray(val) && val.length > 0) {
        lines.push(`${prefix}${key}:${serializeYaml(val, indent + 1)}`);
      } else {
        lines.push(`${prefix}${key}: ${serializeYaml(val, 0)}`);
      }
    }
    return lines.join("\n");
  }

  return String(obj);
}

/**
 * Lightweight YAML parser for Comis config.
 * Handles key: value, indentation nesting, arrays, quoted strings, numbers, booleans, null.
 */
export function parseYaml(text: string): { data: unknown; error: string | null } {
  try {
    const lines = text.split("\n");
    const result = parseLines(lines, 0, 0);
    return { data: result.value, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : "Parse error" };
  }
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function getIndent(line: string): number {
  const match = line.match(/^( *)/);
  return match ? match[1].length : 0;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== "") return num;

  return trimmed;
}

 
function parseLines(lines: string[], startLine: number, _baseIndent: number): ParseResult {
  let lineIdx = startLine;
  while (lineIdx < lines.length && lines[lineIdx].trim() === "") {
    lineIdx++;
  }

  if (lineIdx >= lines.length) {
    return { value: null, nextLine: lineIdx };
  }

  const firstLine = lines[lineIdx];
  const firstIndent = getIndent(firstLine);
  const firstTrimmed = firstLine.trim();

  // Array item
  if (firstTrimmed.startsWith("- ")) {
    const arr: unknown[] = [];
    while (lineIdx < lines.length) {
      const line = lines[lineIdx];
      if (line.trim() === "") {
        lineIdx++;
        continue;
      }
      const indent = getIndent(line);
      if (indent < firstIndent) break;
      if (indent !== firstIndent || !line.trim().startsWith("- ")) break;

      const afterDash = line.trim().slice(2);
      const colonMatch = afterDash.match(/^([^:]+):\s*(.*)/);
      if (colonMatch && !afterDash.startsWith('"') && !afterDash.startsWith("'")) {
        const obj: Record<string, unknown> = {};
        obj[colonMatch[1].trim()] = parseScalar(colonMatch[2]);
        lineIdx++;
        const nestedIndent = firstIndent + 2;
        while (lineIdx < lines.length) {
          const nl = lines[lineIdx];
          if (nl.trim() === "") {
            lineIdx++;
            continue;
          }
          const ni = getIndent(nl);
          if (ni < nestedIndent) break;
          if (ni === nestedIndent && !nl.trim().startsWith("- ")) {
            const nestedMatch = nl.trim().match(/^([^:]+):\s*(.*)/);
            if (nestedMatch) {
              const nKey = nestedMatch[1].trim();
              const nVal = nestedMatch[2];
              if (nVal === "" || nVal === undefined) {
                const sub = parseLines(lines, lineIdx + 1, nestedIndent + 2);
                obj[nKey] = sub.value;
                lineIdx = sub.nextLine;
              } else {
                obj[nKey] = parseScalar(nVal);
                lineIdx++;
              }
            } else {
              break;
            }
          } else {
            break;
          }
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(afterDash));
        lineIdx++;
      }
    }
    return { value: arr, nextLine: lineIdx };
  }

  // Object
  if (firstTrimmed.includes(":")) {
    const obj: Record<string, unknown> = {};
    while (lineIdx < lines.length) {
      const line = lines[lineIdx];
      if (line.trim() === "") {
        lineIdx++;
        continue;
      }
      const indent = getIndent(line);
      if (indent < firstIndent) break;
      if (indent !== firstIndent) break;

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) break;

      const key = line.slice(0, colonIdx).trim();
      const valPart = line.slice(colonIdx + 1).trim();

      if (valPart === "" || valPart === undefined) {
        lineIdx++;
        const sub = parseLines(lines, lineIdx, firstIndent + 2);
        obj[key] = sub.value;
        lineIdx = sub.nextLine;
      } else {
        obj[key] = parseScalar(valPart);
        lineIdx++;
      }
    }
    return { value: obj, nextLine: lineIdx };
  }

  // Scalar
  return { value: parseScalar(firstTrimmed), nextLine: lineIdx + 1 };
}
