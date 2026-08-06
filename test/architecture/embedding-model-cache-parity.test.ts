// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function requiredMatch(source: string, pattern: RegExp, description: string): string {
  const match = source.match(pattern);
  expect(match, description).not.toBeNull();
  return match?.[1] ?? "";
}

describe("embedding model test-cache parity", () => {
  it("keeps test seeding and CI caches aligned with the configured default model", () => {
    const schema = read("packages/core/src/config/schema-embedding.ts");
    const cache = read("test/support/model-cache.ts");
    const workflow = read(".github/workflows/ci.yml");

    const schemaUri = requiredMatch(
      schema,
      /modelUri:[\s\S]*?\.default\("([^"]+\.gguf)"\)/,
      "embedding.local.modelUri must have a literal GGUF default",
    );
    const cacheUri = requiredMatch(
      cache,
      /const DEFAULT_EMBEDDING_MODEL_URI\s*=\s*"([^"]+\.gguf)"/,
      "the shared test cache must declare its seeded embedding model",
    );

    expect(cacheUri).toBe(schemaUri);
    // One restore + one save, in `integration` — the only job that boots a
    // daemon and therefore the only one that needs the GGUF. `e2e` used to hold
    // a second pair, back when it re-ran the whole integration suite; it is now
    // the static flow-matrix gate and loads no model at all.
    expect(workflow.match(/key: embedding-models-bge-m3-Q8_0/g)).toHaveLength(2);
    expect(workflow.match(/\.comis\/models\/\*bge-m3\*\.gguf/g)).toHaveLength(1);
    expect(workflow).not.toContain("embedding-models-nomic-embed-text");
  });
});
