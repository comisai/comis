// SPDX-License-Identifier: Apache-2.0
import { err, ok, tryCatch, type Result } from "@comis/shared";

interface Cursor {
  readonly text: string;
  index: number;
}

function skipWhitespace(cursor: Cursor): void {
  while (/\s/u.test(cursor.text[cursor.index] ?? "")) cursor.index += 1;
}

function scanString(cursor: Cursor): Result<string> {
  const start = cursor.index;
  if (cursor.text[cursor.index] !== '"') return err(new Error("JSON string is required"));
  cursor.index += 1;
  while (cursor.index < cursor.text.length) {
    const character = cursor.text[cursor.index];
    if (character === "\\") {
      cursor.index += 2;
      continue;
    }
    cursor.index += 1;
    if (character !== '"') continue;
    const decoded = tryCatch(() => JSON.parse(cursor.text.slice(start, cursor.index)) as unknown);
    if (!decoded.ok) return decoded;
    return typeof decoded.value === "string"
      ? ok(decoded.value)
      : err(new Error("JSON object name is not a string"));
  }
  return err(new Error("JSON string is unterminated"));
}

function scanObject(cursor: Cursor): Result<void> {
  cursor.index += 1;
  skipWhitespace(cursor);
  const names = new Set<string>();
  if (cursor.text[cursor.index] === "}") {
    cursor.index += 1;
    return ok(undefined);
  }
  while (cursor.index < cursor.text.length) {
    const name = scanString(cursor);
    if (!name.ok) return name;
    if (names.has(name.value)) return err(new Error("JSON object contains a duplicate name"));
    names.add(name.value);
    skipWhitespace(cursor);
    if (cursor.text[cursor.index] !== ":") return err(new Error("JSON object name lacks a value"));
    cursor.index += 1;
    const value = scanValue(cursor);
    if (!value.ok) return value;
    skipWhitespace(cursor);
    const separator = cursor.text[cursor.index];
    cursor.index += 1;
    if (separator === "}") return ok(undefined);
    if (separator !== ",") return err(new Error("JSON object has an invalid separator"));
    skipWhitespace(cursor);
  }
  return err(new Error("JSON object is unterminated"));
}

function scanArray(cursor: Cursor): Result<void> {
  cursor.index += 1;
  skipWhitespace(cursor);
  if (cursor.text[cursor.index] === "]") {
    cursor.index += 1;
    return ok(undefined);
  }
  while (cursor.index < cursor.text.length) {
    const value = scanValue(cursor);
    if (!value.ok) return value;
    skipWhitespace(cursor);
    const separator = cursor.text[cursor.index];
    cursor.index += 1;
    if (separator === "]") return ok(undefined);
    if (separator !== ",") return err(new Error("JSON array has an invalid separator"));
    skipWhitespace(cursor);
  }
  return err(new Error("JSON array is unterminated"));
}

function scanPrimitive(cursor: Cursor): Result<void> {
  const start = cursor.index;
  while (cursor.index < cursor.text.length) {
    const character = cursor.text[cursor.index];
    if (character === "," || character === "]" || character === "}" || /\s/u.test(character ?? "")) {
      break;
    }
    cursor.index += 1;
  }
  return cursor.index > start
    ? ok(undefined)
    : err(new Error("JSON value is missing"));
}

function scanValue(cursor: Cursor): Result<void> {
  skipWhitespace(cursor);
  switch (cursor.text[cursor.index]) {
    case "{":
      return scanObject(cursor);
    case "[":
      return scanArray(cursor);
    case '"': {
      const value = scanString(cursor);
      return value.ok ? ok(undefined) : value;
    }
    default:
      return scanPrimitive(cursor);
  }
}

/** Parse one complete protocol JSON value while rejecting duplicate names at every depth. */
export function parseStrictJson(text: string): Result<unknown> {
  const cursor: Cursor = { text, index: 0 };
  const scanned = scanValue(cursor);
  if (!scanned.ok) return scanned;
  skipWhitespace(cursor);
  if (cursor.index !== text.length) return err(new Error("JSON has a trailing value"));
  return tryCatch(() => JSON.parse(text) as unknown);
}
