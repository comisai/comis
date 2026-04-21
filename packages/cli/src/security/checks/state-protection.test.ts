// SPDX-License-Identifier: Apache-2.0
/**
 * State protection check unit tests.
 *
 * Verifies stateProtectionCheck produces correct findings for
 * missing data directories, world-writable directories, world-writable
 * database files, stat errors, and clean state paths.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { AuditContext } from "../types.js";

// Mock node:fs at module level
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const { existsSync, statSync, readdirSync } = await import("node:fs");
const { stateProtectionCheck } = await import("./state-protection.js");

/** Base audit context for testing. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

describe("stateProtectionCheck", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(statSync).mockReset();
    vi.mocked(readdirSync).mockReset();
  });

  it("returns empty findings when dataDir is empty string", async () => {
    const findings = await stateProtectionCheck.run({
      ...baseContext,
      dataDir: "",
    });

    expect(findings).toHaveLength(0);
    expect(existsSync).not.toHaveBeenCalled();
  });

  it("produces warning when data directory does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const findings = await stateProtectionCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-STATE-001");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("does not exist");
    expect(findings[0].path).toBe("/tmp/test-data");
  });

  it("produces critical when data dir is world-writable", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ mode: 0o40777 } as ReturnType<typeof statSync>);
    vi.mocked(readdirSync).mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    const findings = await stateProtectionCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-STATE-002");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("world-writable");
  });

  it("produces SEC-STATE-ERR warning when statSync throws non-ENOENT error", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const findings = await stateProtectionCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-STATE-ERR");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("Permission denied");
  });

  it("produces critical when .db file is world-writable", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    // Data dir has safe permissions
    vi.mocked(statSync).mockImplementation((filePath) => {
      if (filePath === "/tmp/test-data") {
        return { mode: 0o40700 } as ReturnType<typeof statSync>;
      }
      // DB file is world-writable (mode 666)
      return { mode: 0o100666 } as ReturnType<typeof statSync>;
    });
    vi.mocked(readdirSync).mockReturnValue(["test.db", "notes.txt"] as unknown as ReturnType<typeof readdirSync>);

    const findings = await stateProtectionCheck.run(baseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-STATE-003");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("world-writable");
    expect(findings[0].path).toBe("/tmp/test-data/test.db");
  });

  it("returns empty findings when data dir exists with mode 700 and no world-writable db files", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ mode: 0o40700 } as ReturnType<typeof statSync>);
    vi.mocked(readdirSync).mockReturnValue(["safe.db"] as unknown as ReturnType<typeof readdirSync>);

    const findings = await stateProtectionCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("skips non-database files in readdirSync results", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    // All files have world-writable perms, but only .db files should be checked
    vi.mocked(statSync).mockImplementation((filePath) => {
      if (filePath === "/tmp/test-data") {
        return { mode: 0o40700 } as ReturnType<typeof statSync>;
      }
      return { mode: 0o100666 } as ReturnType<typeof statSync>;
    });
    vi.mocked(readdirSync).mockReturnValue(["notes.txt", "readme.md", "config.json"] as unknown as ReturnType<typeof readdirSync>);

    const findings = await stateProtectionCheck.run(baseContext);

    expect(findings).toHaveLength(0);
  });

  it("handles .sqlite and .sqlite3 extensions as database files", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockImplementation((filePath) => {
      if (filePath === "/tmp/test-data") {
        return { mode: 0o40700 } as ReturnType<typeof statSync>;
      }
      return { mode: 0o100666 } as ReturnType<typeof statSync>;
    });
    vi.mocked(readdirSync).mockReturnValue(["a.sqlite", "b.sqlite3"] as unknown as ReturnType<typeof readdirSync>);

    const findings = await stateProtectionCheck.run(baseContext);

    expect(findings).toHaveLength(2);
    expect(findings[0].code).toBe("SEC-STATE-003");
    expect(findings[1].code).toBe("SEC-STATE-003");
  });
});
