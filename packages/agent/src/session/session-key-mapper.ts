// SPDX-License-Identifier: Apache-2.0
import type { SessionKey } from "@comis/core";
import { safePath } from "@comis/core";

/**
 * Encode a single character to its `@XX` hex representation.
 * Uses `@` as the escape character to avoid conflict with safePath's
 * decodeURIComponent (which would undo `%XX` encoding).
 */
function escapeChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code > 0xff) {
    // Multi-byte: encode each UTF-8 byte
    const buf = Buffer.from(ch, "utf8");
    let result = "";
    for (const byte of buf) {
      result += `@${byte.toString(16).padStart(2, "0")}`;
    }
    return result;
  }
  return `@${code.toString(16).padStart(2, "0")}`;
}

/**
 * Encode a SessionKey field value into a filesystem-safe string.
 *
 * Safe characters `[a-zA-Z0-9._-]` pass through unchanged.
 * All other characters (including `~`, `/`, `:`, `@`, spaces, unicode)
 * are encoded as `@XX` hex sequences (per UTF-8 byte).
 *
 * This avoids the collision pitfall where e.g. "user:123" and "user_123"
 * would become identical with naive underscore replacement.
 *
 * Uses `@` instead of `%` as the escape character because safePath
 * internally calls decodeURIComponent on path segments, which would
 * undo standard percent-encoding.
 */
function encodeComponent(value: string): string {
  let result = "";
  for (const ch of value) {
    if (/^[a-zA-Z0-9._-]$/.test(ch)) {
      result += ch;
    } else {
      result += escapeChar(ch);
    }
  }
  return result;
}

/**
 * Decode an `@XX`-encoded string back to the original value.
 * Reverses encodeComponent without data loss.
 */
function decodeComponent(encoded: string): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < encoded.length) {
    if (encoded[i] === "@" && i + 2 < encoded.length) {
      const hex = encoded.substring(i + 1, i + 3);
      const byte = parseInt(hex, 16);
      if (!isNaN(byte)) {
        bytes.push(byte);
        i += 3;
        continue;
      }
    }
    // Regular ASCII character — flush any pending multi-byte sequence first
    bytes.push(encoded.charCodeAt(i));
    i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Build the filename portion of a session path from a SessionKey.
 *
 * Format: `{userId}[~peer~{peerId}][~guild~{guildId}][~thread~{threadId}].jsonl`
 *
 * Each value is encoded; the `~peer~`, `~guild~`, `~thread~` tokens are
 * literal delimiters (unambiguous because `~` inside values is encoded).
 */
function buildFilename(key: SessionKey): string {
  let name = encodeComponent(key.userId);

  if (key.peerId !== undefined) {
    name += `~peer~${encodeComponent(key.peerId)}`;
  }
  if (key.guildId !== undefined) {
    name += `~guild~${encodeComponent(key.guildId)}`;
  }
  if (key.threadId !== undefined) {
    name += `~thread~${encodeComponent(key.threadId)}`;
  }

  return `${name}.jsonl`;
}

/**
 * Convert a SessionKey to a deterministic JSONL file path.
 *
 * Directory structure: `{baseDir}/{encodedTenantId}/{encodedChannelId}/{filename}.jsonl`
 *
 * agentId is NOT included in the path — by convention, baseDir already
 * incorporates it (e.g. `~/.comis/agents/{agentId}/sessions/`).
 *
 * Uses `safePath` from `@comis/core` to prevent directory traversal
 * from untrusted SessionKey values.
 *
 * @param key - The SessionKey to convert
 * @param baseDir - Absolute base directory for session files
 * @returns Absolute path to the JSONL session file
 * @throws PathTraversalError if the resolved path escapes baseDir
 */
export function sessionKeyToPath(key: SessionKey, baseDir: string): string {
  const tenantDir = encodeComponent(key.tenantId);
  const channelDir = encodeComponent(key.channelId);
  const filename = buildFilename(key);

  return safePath(baseDir, tenantDir, channelDir, filename);
}

/**
 * Convert a JSONL file path back to a SessionKey.
 *
 * Reverses `sessionKeyToPath` by:
 * 1. Stripping the baseDir prefix
 * 2. Splitting the relative path into `[tenantId, channelId, filename]`
 * 3. Parsing the filename for userId and optional peer/guild/thread fields
 * 4. Decoding all components
 *
 * @param filePath - Absolute path to a JSONL session file
 * @param baseDir - The same baseDir used in sessionKeyToPath
 * @param agentId - Optional agentId to set on the returned SessionKey
 * @returns SessionKey if the path is valid, undefined otherwise
 */
export function pathToSessionKey(
  filePath: string,
  baseDir: string,
  agentId?: string,
): SessionKey | undefined {
  if (!filePath) return undefined;

  // Normalize both paths for consistent prefix stripping
  const normalizedBase = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
  const normalizedFile = filePath;

  if (!normalizedFile.startsWith(normalizedBase)) {
    return undefined;
  }

  const relative = normalizedFile.slice(normalizedBase.length);
  if (!relative) return undefined;

  const parts = relative.split("/");
  if (parts.length < 3) return undefined;

  const [encodedTenant, encodedChannel, rawFilename] = parts;
  if (!encodedTenant || !encodedChannel || !rawFilename) return undefined;

  // Strip .jsonl extension
  if (!rawFilename.endsWith(".jsonl")) return undefined;
  const nameWithoutExt = rawFilename.slice(0, -6); // ".jsonl".length === 6

  // Parse filename: userId[~peer~peerId][~guild~guildId][~thread~threadId]
  // Split on delimiter tokens
  const segments = nameWithoutExt.split(/~(peer|guild|thread)~/);
  // segments[0] = encoded userId
  // segments[1] = "peer", segments[2] = encoded peerId (if present)
  // segments[3] = "guild", segments[4] = encoded guildId (if present)
  // etc.

  if (!segments[0] && segments[0] !== "") return undefined;

  const key: SessionKey = {
    tenantId: decodeComponent(encodedTenant!),
    userId: decodeComponent(segments[0]),
    channelId: decodeComponent(encodedChannel!),
  };

  // Parse optional fields from delimiter-split segments
  for (let i = 1; i < segments.length; i += 2) {
    const label = segments[i];
    const value = segments[i + 1];
    if (value === undefined) continue;

    const decoded = decodeComponent(value);
    if (label === "peer") {
      key.peerId = decoded;
    } else if (label === "guild") {
      key.guildId = decoded;
    } else if (label === "thread") {
      key.threadId = decoded;
    }
  }

  if (agentId !== undefined) {
    key.agentId = agentId;
  }

  return key;
}
