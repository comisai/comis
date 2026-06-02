// SPDX-License-Identifier: Apache-2.0
/**
 * Linux-gated live-host confirmation for the canonical-binary matcher (SEC-14).
 *
 * This file MUST compile cleanly on macOS (tsc --noEmit passes). On macOS the
 * entire describe block is silently SKIPPED via `describe.skipIf` — no false
 * failures. The pure-FS realpath/hash logic is already proven host-independently
 * in `allowlist-matcher.test.ts` (the primary macOS suite); this file is the
 * live-host confirmation that flips green on the operator VPS (`comisvps`),
 * mirroring the `bwrap-egress-integration.test.ts` Linux-gate idiom.
 *
 * On Linux it builds a real symlink on the real FS, points it at a different
 * real binary than the pinned canonical, and confirms `matchAllowEntry` rejects
 * it via `realpathSync` — a live PATH-shadow cannot impersonate the allowlisted
 * canonical.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { matchAllowEntry, type AllowEntryLike } from "./allowlist-matcher.js";

const isLinux = process.platform === "linux";

describe.skipIf(!isLinux)("allowlist matcher live PATH-shadow (Linux only)", () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "allowlist-matcher-linux-"));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("rejects a live on-disk symlink whose realpath differs from the pinned canonical", () => {
    // /bin/bash is the pinned canonical; /bin/ls is a different real target.
    const canonicalBash = realpathSync("/bin/bash");
    const otherTarget = realpathSync("/bin/ls");

    const shadow = join(work, "bash"); // a PATH-shadow named 'bash'
    symlinkSync(otherTarget, shadow);

    const entry: AllowEntryLike = { id: "bash", match: { path: canonicalBash } };
    // realpath(shadow) === /bin/ls !== /bin/bash → rejected.
    expect(matchAllowEntry(shadow, [entry])).toBeUndefined();
  });

  it("matches a live on-disk symlink that resolves to the pinned canonical", () => {
    const canonicalBash = realpathSync("/bin/bash");
    const link = join(work, "bash-link");
    symlinkSync(canonicalBash, link);

    const entry: AllowEntryLike = { id: "bash", match: { path: canonicalBash } };
    expect(matchAllowEntry(link, [entry])?.id).toBe("bash");
  });
});
