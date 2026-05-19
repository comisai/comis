// SPDX-License-Identifier: Apache-2.0
/**
 * `resolveCacheTraceFilePath` behavior tests.
 *
 * Three cases:
 *   - explicit `filePath` honored verbatim (no tilde)
 *   - `~`-prefix expanded to `homedir()`
 *   - default fall-through to `~/.comis/logs/cache-trace.jsonl`
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveCacheTraceFilePath } from "./paths.js";

describe("resolveCacheTraceFilePath", () => {
  it("honors an explicit absolute filePath verbatim", () => {
    const result = resolveCacheTraceFilePath({
      filePath: "/var/log/comis/custom-cache-trace.jsonl",
    });
    expect(result).toBe("/var/log/comis/custom-cache-trace.jsonl");
  });

  it("expands a leading tilde in filePath to homedir()", () => {
    const result = resolveCacheTraceFilePath({
      filePath: "~/custom/cache.jsonl",
    });
    expect(result).toBe(join(homedir(), "custom/cache.jsonl"));
  });

  it("defaults to ${homedir}/.comis/logs/cache-trace.jsonl when no filePath set", () => {
    const result = resolveCacheTraceFilePath({});
    expect(result).toBe(join(homedir(), ".comis", "logs", "cache-trace.jsonl"));
  });

  it("respects confinedBaseDir for the default path", () => {
    const result = resolveCacheTraceFilePath({ confinedBaseDir: "/tmp/data" });
    expect(result).toBe(join("/tmp/data", "logs", "cache-trace.jsonl"));
  });
});
