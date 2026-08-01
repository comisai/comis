// SPDX-License-Identifier: Apache-2.0
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const seedModelCache = vi.hoisted(() => vi.fn());

vi.mock("./model-cache.js", () => ({ seedModelCache }));

describe("Vitest worker filesystem isolation", () => {
  const originalVitest = process.env["VITEST"];
  const originalDataDir = process.env["COMIS_DATA_DIR"];
  let createdDataDir: string | undefined;

  afterEach(() => {
    if (createdDataDir) {
      rmSync(createdDataDir, { recursive: true, force: true });
      createdDataDir = undefined;
    }
    if (originalVitest === undefined) delete process.env["VITEST"];
    else process.env["VITEST"] = originalVitest;
    if (originalDataDir === undefined) delete process.env["COMIS_DATA_DIR"];
    else process.env["COMIS_DATA_DIR"] = originalDataDir;
    seedModelCache.mockReset();
  });

  it("seeds the worker data directory from the shared model cache", async () => {
    process.env["VITEST"] = "true";
    delete process.env["COMIS_DATA_DIR"];
    vi.resetModules();

    await import("./vitest-process-listeners.js");

    createdDataDir = process.env["COMIS_DATA_DIR"];
    expect(createdDataDir).toBeDefined();
    expect(seedModelCache).toHaveBeenCalledOnce();
    expect(seedModelCache).toHaveBeenCalledWith(createdDataDir);
  });
});
