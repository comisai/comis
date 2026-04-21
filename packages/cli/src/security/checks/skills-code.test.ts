// SPDX-License-Identifier: Apache-2.0
/**
 * Skills code scanning check unit tests.
 *
 * Verifies skillsCodeCheck produces correct findings for fetch() calls,
 * process.exit, atob() obfuscation, Buffer.from base64, clean files,
 * non-JS file skipping, unreadable file handling, and nonexistent dirs.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { AuditContext } from "../types.js";

// Mock node:fs at module level
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const { readdirSync, readFileSync } = await import("node:fs");
const { skillsCodeCheck } = await import("./skills-code.js");

/** Base audit context for testing. */
const baseContext: AuditContext = {
  configPaths: [],
  dataDir: "/tmp/test-data",
  skillsPaths: [],
};

/** Helper to create a mock Dirent-like object for a file. */
function mockFileDirent(name: string, parentPath: string) {
  return { isFile: () => true, name, parentPath };
}

/** Helper to create a mock Dirent-like object for a directory. */
function mockDirDirent(name: string, parentPath: string) {
  return { isFile: () => false, name, parentPath };
}

describe("skillsCodeCheck", () => {
  beforeEach(() => {
    vi.mocked(readdirSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  it("returns empty findings when skillsPaths is empty", async () => {
    const findings = await skillsCodeCheck.run(baseContext);

    expect(findings).toHaveLength(0);
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("detects fetch() call in JS file", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("skill.js", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue("const data = fetch('https://evil.com')");

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SKILL-001");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("fetch()");
  });

  it("detects process.exit in JS file", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("bad.js", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue("process.exit(1)");

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SKILL-002");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("process.exit");
  });

  it("detects atob() call in JS file", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("obfuscated.js", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue("const decoded = atob('aGVsbG8=')");

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SKILL-003");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("atob()");
  });

  it("detects Buffer.from(x, 'base64') in JS file", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("decode.js", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue("const buf = Buffer.from(encoded, 'base64')");

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("SEC-SKILL-003");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("Buffer.from()");
  });

  it("returns empty findings for clean JS file", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("clean.js", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue("function greet(name) { return 'Hello ' + name; }");

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    expect(findings).toHaveLength(0);
  });

  it("skips non-.js files in directory listing", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("readme.md", "/skills"),
      mockFileDirent("data.json", "/skills"),
      mockDirDirent("subdir", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    expect(findings).toHaveLength(0);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("skips files that throw on readFileSync (unreadable files)", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("locked.js", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    expect(findings).toHaveLength(0);
  });

  it("handles directory that throws on readdirSync (nonexistent skills dir)", async () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/nonexistent/skills"],
    });

    expect(findings).toHaveLength(0);
  });

  it("detects multiple patterns in a single file", async () => {
    vi.mocked(readdirSync).mockReturnValue([
      mockFileDirent("multi.js", "/skills"),
    ] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockReturnValue(
      "fetch('https://api.com');\nprocess.exit(0);\natob('secret');",
    );

    const findings = await skillsCodeCheck.run({
      ...baseContext,
      skillsPaths: ["/skills"],
    });

    // Each dangerous pattern produces a distinct finding code
    expect(findings).toHaveLength(3);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("SEC-SKILL-001");
    expect(codes).toContain("SEC-SKILL-002");
    expect(codes).toContain("SEC-SKILL-003");
  });
});
