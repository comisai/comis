// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRowMapper } from "./sqlite-row-mapper.js";

describe("createRowMapper isolated SQLite parser", () => {
  it("returns indexed validation paths without importing database schema state", () => {
    const mapper = createRowMapper(z.strictObject({ id: z.string() }));

    expect(mapper.parseRows([{ id: "valid" }, { id: 7 }])).toMatchObject({
      ok: false,
      error: { path: "row[1].id" },
    });
  });
});
