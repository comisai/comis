// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openSqliteDatabase } from "./sqlite-adapter-base.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shared SQLite adapter lifecycle", () => {
  it("rejects unsafe busy timeouts before creating database directories", () => {
    const invalidValues = [0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER];
    for (const [index, busyTimeoutMs] of invalidValues.entries()) {
      const root = mkdtempSync(join(tmpdir(), "comis-sqlite-option-"));
      tempDirs.push(root);
      const parent = join(root, `nested-${index}`);

      expect(() => openSqliteDatabase({
        dbPath: join(parent, "store.db"),
        busyTimeoutMs,
      })).toThrow("SQLite busy timeout must be a positive 32-bit integer");
      expect(existsSync(parent)).toBe(false);
    }
  });

  it("applies a valid busy timeout before schema initialization", () => {
    let observedTimeout: unknown;
    const db = openSqliteDatabase({
      dbPath: ":memory:",
      busyTimeoutMs: 123,
      initSchema: (opened) => {
        observedTimeout = opened.pragma("busy_timeout", { simple: true });
      },
    });

    expect(observedTimeout).toBe(123);
    db.close();
  });
});
