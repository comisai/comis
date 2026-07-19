// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseHistoryColumn } from "./sqlite-memory-adapter-support.js";

describe("memory correction history parsing", () => {
  it("treats malformed JSON history as absent", () => {
    expect(parseHistoryColumn("{")).toBeUndefined();
  });
});
