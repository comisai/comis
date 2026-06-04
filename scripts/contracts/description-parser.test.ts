// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the `findMissingSections` pure function.
 *
 * RED baseline: all tests fail before description-parser.ts exists.
 * GREEN after: all five cases pass.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { findMissingSections } from "./description-parser.js";

describe("findMissingSections — PR/issue body section checker", () => {
  it("returns all sections when body is empty string", () => {
    expect(findMissingSections("", ["Description", "Checklist"])).toEqual([
      "Description",
      "Checklist",
    ]);
  });

  it("returns empty array when all required sections present", () => {
    const body = "## Description\nfoo\n## Checklist\nbar";
    expect(findMissingSections(body, ["Description", "Checklist"])).toEqual(
      []
    );
  });

  it("returns only missing section names from partial body", () => {
    const body = "## Description\nfoo";
    expect(
      findMissingSections(body, ["Description", "Checklist"])
    ).toEqual(["Checklist"]);
  });

  it("matches section headings case-insensitively", () => {
    const body = "## description\nfoo";
    expect(findMissingSections(body, ["Description"])).toEqual([]);
  });

  it("requires H2 headings — H3 and inline text do not match", () => {
    const body = "### Description\nfoo bar Description baz";
    expect(findMissingSections(body, ["Description"])).toEqual([
      "Description",
    ]);
  });
});
