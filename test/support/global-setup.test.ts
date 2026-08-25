// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelCacheMocks = vi.hoisted(() => ({
  ensureSharedModelCache: vi.fn(async () => undefined),
  seedModelCache: vi.fn(),
}));

vi.mock("./model-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-cache.js")>();
  return { ...actual, ...modelCacheMocks };
});

const { setup, teardown } = await import("./global-setup.js");

const TEST_MODEL_CACHE_SOURCE_ENV = "COMIS_TEST_MODEL_CACHE_SOURCE";
const originalTestModelCacheSource = process.env[TEST_MODEL_CACHE_SOURCE_ENV];

describe("global test model cache staging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[TEST_MODEL_CACHE_SOURCE_ENV];
    modelCacheMocks.seedModelCache.mockImplementation((dataDir: string) => {
      const modelsDir = join(dataDir, "models");
      mkdirSync(modelsDir, { recursive: true });
      writeFileSync(join(modelsDir, "bge-m3-Q8_0.gguf"), "fixture");
    });
  });

  afterEach(() => {
    teardown();
    if (originalTestModelCacheSource === undefined) {
      delete process.env[TEST_MODEL_CACHE_SOURCE_ENV];
    } else {
      process.env[TEST_MODEL_CACHE_SOURCE_ENV] = originalTestModelCacheSource;
    }
  });

  it("stages one suite-local model source before workers start", async () => {
    await setup();

    expect(modelCacheMocks.ensureSharedModelCache).toHaveBeenCalledOnce();
    expect(modelCacheMocks.seedModelCache).toHaveBeenCalledOnce();
    const stagedRoot = modelCacheMocks.seedModelCache.mock.calls[0]?.[0];
    expect(stagedRoot).toEqual(expect.any(String));
    expect(process.env[TEST_MODEL_CACHE_SOURCE_ENV]).toBe(
      join(stagedRoot as string, "models"),
    );
  });
});
