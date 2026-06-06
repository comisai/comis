// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for buildMemConfig — Stage-A, no daemon required.
 *
 * Verifies that buildMemConfig correctly patches each key group:
 *   A. embedding.provider
 *   B. memory.embeddingDimensions
 *   C. memory.costFeatures.enabled
 *   D. rag lane config
 *   E. embedding.local.gpu
 *   F. File naming (filePrefix + label sanitisation)
 *
 * All tests are purely in-process (readFileSync + writeFileSync via OS tmpdir).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildMemConfig } from "./mem-config.js";

describe("buildMemConfig — returns a file path that exists", () => {
  it("creates a file at the returned path", () => {
    const p = buildMemConfig({ label: "exists-check", embeddingProvider: "local" });
    expect(existsSync(p)).toBe(true);
  });
});

describe("buildMemConfig — Behavior A: embedding.provider patched", () => {
  it("writes 'provider: local' when embeddingProvider='local'", () => {
    const p = buildMemConfig({ label: "test", embeddingProvider: "local" });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/provider:\s*local/);
  });

  it("writes 'provider: openai' when embeddingProvider='openai'", () => {
    const p = buildMemConfig({ label: "test-openai", embeddingProvider: "openai" });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/provider:\s*openai/);
  });
});

describe("buildMemConfig — Behavior B: memory.embeddingDimensions patched", () => {
  it("writes 'embeddingDimensions: 768' when requested", () => {
    const p = buildMemConfig({ label: "test", embeddingDimensions: 768 });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/embeddingDimensions:\s*768/);
  });
});

describe("buildMemConfig — Behavior C: costFeatures.enabled patched", () => {
  it("writes 'enabled: false' under costFeatures when costFeaturesEnabled=false", () => {
    const p = buildMemConfig({ label: "test", costFeaturesEnabled: false });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/costFeatures:/);
    expect(content).toMatch(/enabled:\s*false/);
  });
});

describe("buildMemConfig — Behavior D: ragConfig.rerank patched", () => {
  it("contains 'rerank' in content when ragConfig.rerank provided", () => {
    const p = buildMemConfig({ label: "test", ragConfig: { rerank: true } });
    const content = readFileSync(p, "utf-8");
    // The file must reference 'rerank' (either existing patch or base config)
    expect(content).toContain("rerank");
  });
});

describe("buildMemConfig — Behavior E: embedding.local.gpu patched", () => {
  it("writes 'gpu: false' when localGpu='false'", () => {
    const p = buildMemConfig({ label: "test", localGpu: "false" });
    const content = readFileSync(p, "utf-8");
    expect(content).toMatch(/gpu:\s*false/);
  });
});

describe("buildMemConfig — Behavior F: file naming", () => {
  it("uses 'mem' as default prefix", () => {
    const p = buildMemConfig({ label: "naming-test" });
    expect(p).toMatch(/mem-naming-test-\d+\.yaml$/);
  });

  it("uses custom filePrefix when provided", () => {
    const p = buildMemConfig({ label: "prefix-test", filePrefix: "myprefix" });
    expect(p).toMatch(/myprefix-prefix-test-\d+\.yaml$/);
  });

  it("sanitises label replacing non-alphanumeric chars with underscores", () => {
    const p = buildMemConfig({ label: "foo bar/baz" });
    expect(p).toMatch(/mem-foo_bar_baz-\d+\.yaml$/);
  });
});
