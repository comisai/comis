/**
 * Tests for getGitDiffStat helper.
 *
 * Uses vitest mock to test the execFile-based implementation without
 * requiring an actual git repository.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process before importing
vi.mock("node:child_process", () => {
  return {
    execFile: vi.fn(),
  };
});

import { execFile } from "node:child_process";
import { getGitDiffStat } from "./git-diff.js";

const mockExecFile = vi.mocked(execFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getGitDiffStat", () => {
  it("returns trimmed stdout when git diff succeeds with output", async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          " file.ts | 5 ++---\n 1 file changed\n",
          "",
        );
        return { on: vi.fn() } as unknown as ReturnType<typeof execFile>;
      },
    );

    const result = await getGitDiffStat("file.ts", "/repo");
    expect(result).toBe("file.ts | 5 ++---\n 1 file changed");
  });

  it("returns null when git diff returns empty stdout", async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          "",
          "",
        );
        return { on: vi.fn() } as unknown as ReturnType<typeof execFile>;
      },
    );

    const result = await getGitDiffStat("untracked.ts", "/repo");
    expect(result).toBeNull();
  });

  it("returns null when git diff errors (not a repo)", async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error, stdout: string, stderr: string) => void)(
          new Error("not a git repository"),
          "",
          "fatal: not a git repository",
        );
        return { on: vi.fn() } as unknown as ReturnType<typeof execFile>;
      },
    );

    const result = await getGitDiffStat("file.ts", "/not-a-repo");
    expect(result).toBeNull();
  });

  it("passes correct arguments to execFile", async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          "",
          "",
        );
        return { on: vi.fn() } as unknown as ReturnType<typeof execFile>;
      },
    );

    await getGitDiffStat("src/index.ts", "/my/repo");

    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["diff", "--stat", "--", "src/index.ts"],
      expect.objectContaining({ cwd: "/my/repo", timeout: 500 }),
      expect.any(Function),
    );
  });
});
