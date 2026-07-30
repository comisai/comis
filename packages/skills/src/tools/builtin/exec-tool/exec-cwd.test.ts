// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExistsSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ existsSync: mockExistsSync }));

import { resolveCwd } from "./exec-cwd.js";

describe("exec working-directory resolution", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  it("returns an existing workspace-relative directory", () => {
    mockExistsSync.mockReturnValue(true);

    expect(resolveCwd("/workspace", "project")).toBe("/workspace/project");
  });

  it("rejects a missing working directory with its supplied path", () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => resolveCwd("/workspace", "missing"))
      .toThrow("Working directory does not exist: missing");
  });

  it("rejects a working directory outside workspace bounds", () => {
    mockExistsSync.mockReturnValue(true);

    expect(() => resolveCwd("/workspace", "../outside"))
      .toThrow("Working directory outside workspace bounds: ../outside");
  });
});
