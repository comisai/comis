// SPDX-License-Identifier: Apache-2.0
/**
 * resolveRecallTraceFilePath tests — mirror cache-trace/paths.test.ts.
 *
 * The resolver follows the same precedence as resolveCacheTraceFilePath:
 *   1. explicit filePath (with `~` expansion)
 *   2. confinedBaseDir/logs/recall-trace.jsonl
 *   3. homedir()/.comis/logs/recall-trace.jsonl
 *
 * `~`-expansion uses os.homedir() at call-time (HOME override testability).
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveRecallTraceFilePath } from "./paths.js";

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
});

describe("resolveRecallTraceFilePath", () => {
  it("returns confinedBaseDir/logs/recall-trace.jsonl when given a confinedBaseDir", () => {
    const result = resolveRecallTraceFilePath({ confinedBaseDir: "/srv/data/.comis" });
    expect(result).toBe(join("/srv/data/.comis", "logs", "recall-trace.jsonl"));
  });

  it("expands a leading ~ in an explicit path to homedir()", () => {
    const result = resolveRecallTraceFilePath({ filePath: "~/foo.jsonl" });
    expect(result).toBe(join(homedir(), "foo.jsonl"));
  });

  it("passes an explicit absolute path through unchanged", () => {
    const result = resolveRecallTraceFilePath({ filePath: "/var/log/recall.jsonl" });
    expect(result).toBe("/var/log/recall.jsonl");
  });

  it("defaults under homedir()/.comis/logs/recall-trace.jsonl with no inputs", () => {
    const result = resolveRecallTraceFilePath({});
    expect(result).toBe(join(homedir(), ".comis", "logs", "recall-trace.jsonl"));
  });
});
