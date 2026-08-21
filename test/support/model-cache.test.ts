// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_MODEL_CACHE_SOURCE_ENV = "COMIS_TEST_MODEL_CACHE_SOURCE";
const originalTestModelCacheSource = process.env[TEST_MODEL_CACHE_SOURCE_ENV];

const fsMocks = vi.hoisted(() => ({
  copyFileSync: vi.fn(),
  existsSync: vi.fn(),
  linkSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, ...fsMocks };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/shared-home" };
});

// Global setup imports this helper before project tests start. Reload it after
// registering the filesystem mocks so this test never reaches the real disk.
vi.resetModules();
const { seedModelCache } = await import("./model-cache.js");

describe("seedModelCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.linkSync.mockImplementation(() => undefined);
    delete process.env[TEST_MODEL_CACHE_SOURCE_ENV];
    fsMocks.existsSync.mockImplementation((path: unknown) =>
      ["/shared-home/.comis/models", "/suite-model-cache"].includes(String(path)),
    );
    fsMocks.readdirSync.mockReturnValue([
      "bge-m3-Q8_0.gguf",
      "bge-m3-Q8_0.gguf.ipull",
    ]);
  });

  it("copies a completed model when hard linking crosses filesystems", () => {
    fsMocks.linkSync.mockImplementation(() => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    });

    seedModelCache("/throwaway-data");

    expect(fsMocks.copyFileSync).toHaveBeenCalledOnce();
    expect(fsMocks.copyFileSync).toHaveBeenCalledWith(
      "/shared-home/.comis/models/bge-m3-Q8_0.gguf",
      "/throwaway-data/models/bge-m3-Q8_0.gguf",
    );
  });

  it("surfaces hard-link failures that are not cross-filesystem errors", () => {
    fsMocks.linkSync.mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(() => seedModelCache("/throwaway-data")).toThrow("permission denied");
    expect(fsMocks.copyFileSync).not.toHaveBeenCalled();
  });

  it("links worker models from the suite-local staged cache", () => {
    process.env[TEST_MODEL_CACHE_SOURCE_ENV] = "/suite-model-cache";

    seedModelCache("/throwaway-data");

    expect(fsMocks.readdirSync).toHaveBeenCalledWith("/suite-model-cache");
    expect(fsMocks.linkSync).toHaveBeenCalledWith(
      "/suite-model-cache/bge-m3-Q8_0.gguf",
      "/throwaway-data/models/bge-m3-Q8_0.gguf",
    );
    expect(fsMocks.copyFileSync).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  if (originalTestModelCacheSource === undefined) {
    delete process.env[TEST_MODEL_CACHE_SOURCE_ENV];
  } else {
    process.env[TEST_MODEL_CACHE_SOURCE_ENV] = originalTestModelCacheSource;
  }
});
