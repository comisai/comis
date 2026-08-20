// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { seedModelCache } = await import("./model-cache.js");

describe("seedModelCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockImplementation((path: unknown) =>
      String(path) === "/shared-home/.comis/models",
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
});
