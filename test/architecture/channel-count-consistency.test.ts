// SPDX-License-Identifier: Apache-2.0
/**
 * Website channel-count consistency — the static guard against silent count
 * drift in the single-source facts module.
 *
 * `website/src/data/facts.ts` is the one place the site states how many channels
 * Comis ships. Multiple pages consume `FACTS.channels` and `FACTS.channelList`
 * dynamically, so a mismatch between the headline number and the enumerated
 * list would propagate identically across the whole site. `pnpm docs:check`
 * only compiles MDX syntax, and the `website/` tree is not a vitest project, so
 * nothing else verifies the count is honest and internally consistent — a stale
 * number fails silently.
 *
 * This is a STATIC, cross-platform invariant (no module resolution — the file
 * is read as text) that keeps the headline channel count, the enumerated
 * channel list, and the doc-comment example number reconciled with one another.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const FACTS_SRC = readFileSync(resolve(REPO_ROOT, "website/src/data/facts.ts"), "utf8");

/** The `channels: N` headline literal. */
function headlineChannelCount(src: string): number {
  const m = src.match(/channels:\s*(\d+)/);
  if (!m) throw new Error("facts.ts: could not find a `channels: N` literal");
  return Number(m[1]);
}

/** The quoted entries inside the `channelList: [ ... ]` block. */
function channelList(src: string): string[] {
  const block = src.match(/channelList:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("facts.ts: could not find the `channelList: [ ... ]` block");
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** The number in the doc-comment "N channels" example string. */
function docCommentChannelCount(src: string): number {
  const m = src.match(/"(\d+)\s+channels"/);
  if (!m) throw new Error('facts.ts: could not find the "N channels" doc-comment example');
  return Number(m[1]);
}

describe("website channel count is internally consistent", () => {
  const channels = headlineChannelCount(FACTS_SRC);
  const list = channelList(FACTS_SRC);

  it("states 10 channels in the headline count", () => {
    expect(channels).toBe(10);
  });

  it("enumerates exactly 10 channels in channelList", () => {
    expect(list).toHaveLength(10);
  });

  it("reconciles the headline count with the enumerated list", () => {
    expect(channels).toBe(list.length);
  });

  it("includes Microsoft Teams in the channel list", () => {
    expect(list).toContain("Microsoft Teams");
  });

  it("keeps the doc-comment example number equal to the headline count", () => {
    expect(docCommentChannelCount(FACTS_SRC)).toBe(channels);
  });
});
