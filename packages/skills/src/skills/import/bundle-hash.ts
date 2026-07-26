// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical content hash for a skill bundle.
 *
 * The hash is the anchor for tamper detection on re-import: a bundle whose
 * hash differs from a higher-trust incumbent is refused. That only works if
 * the canonicalization is source-independent — the same skill fetched as an
 * archive (bytes), as a per-file well-known bundle (strings), or through the
 * GitHub Contents walk (strings) must produce the same digest.
 *
 * Canonicalization:
 *   1. Encode every member's content to UTF-8 bytes (a `string` member and its
 *      byte encoding are the same content).
 *   2. Sort members by path (sources enumerate in different orders).
 *   3. Feed `path-bytes || 0x00 || content-bytes` per member.
 *
 * The NUL separator is load-bearing: without it, `{path:"ab", content:"c"}`
 * and `{path:"a", content:"bc"}` would feed an identical byte stream. NUL
 * cannot appear in a member path (rejected by the path rules in
 * `./bundle-structure.ts`), so it is an unambiguous delimiter.
 *
 * Metadata (`mode`, `type`) is deliberately excluded — it is provenance about
 * the transport, not content.
 *
 * Pure: no fs, no net, no clock, and no mutation of the caller's array.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { SkillBundleFile } from "./bundle-types.js";

/** Digest algorithm prefix, so the value is self-describing in a lockfile. */
const HASH_PREFIX = "sha256:";

/** Coerce a member's content to bytes without copying when it is already bytes. */
function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/**
 * Compute the canonical content hash of a skill bundle.
 *
 * @param files The bundle's members. Order is irrelevant; the input array is
 *   NOT mutated (the sort runs on a shallow copy).
 * @returns `"sha256:<64 lowercase hex chars>"`.
 */
export function hashSkillBundle(files: readonly SkillBundleFile[]): string {
  const hash = createHash("sha256");
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const file of ordered) {
    hash.update(new TextEncoder().encode(file.path));
    hash.update(Uint8Array.of(0x00));
    hash.update(contentBytes(file.content));
  }

  return `${HASH_PREFIX}${hash.digest("hex")}`;
}
