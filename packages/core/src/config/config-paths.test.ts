// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseConfigPaths } from "./config-paths.js";

describe("parseConfigPaths", () => {
  it("parses the documented comma-separated path list and removes blank entries", () => {
    expect(parseConfigPaths(" /cfg/base.yaml, ,/cfg/local.yaml ")).toEqual([
      "/cfg/base.yaml",
      "/cfg/local.yaml",
    ]);
  });

  it("returns an empty list when the environment value is absent or blank", () => {
    expect(parseConfigPaths(undefined)).toEqual([]);
    expect(parseConfigPaths("   ")).toEqual([]);
  });
});
