// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadFile, mockReadWorkspaceState, mockIsIdentityFilled, mockIncrementOnboardingCount, mockWriteWorkspaceState } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReadWorkspaceState: vi.fn(),
  mockIsIdentityFilled: vi.fn(),
  mockIncrementOnboardingCount: vi.fn(),
  mockWriteWorkspaceState: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("@comis/core", () => ({
  safePath: (dir: string, file: string) => `${dir}/${file}`,
  systemNowMs: () => Date.now(),
  readWorkspaceState: mockReadWorkspaceState,
  isIdentityFilled: mockIsIdentityFilled,
  incrementOnboardingCount: mockIncrementOnboardingCount,
  writeWorkspaceState: mockWriteWorkspaceState,
}));

import { detectOnboardingState } from "./onboarding-detector.js";

describe("detectOnboardingState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("# BOOTSTRAP.md\nSome onboarding content");
    mockIsIdentityFilled.mockResolvedValue(false);
    mockIncrementOnboardingCount.mockResolvedValue(1);
    mockWriteWorkspaceState.mockResolvedValue(undefined);
  });

  it("returns true and increments count when under threshold", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("# BOOTSTRAP.md\nOnboarding content");
    mockIsIdentityFilled.mockResolvedValue(false);
    mockIncrementOnboardingCount.mockResolvedValue(1);

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(true);
    expect(mockReadFile).toHaveBeenCalledWith("/workspace/BOOTSTRAP.md", "utf-8");
    expect(mockIncrementOnboardingCount).toHaveBeenCalledWith("/workspace");
  });

  it("keeps onboarding active when BOOTSTRAP.md has pending state despite a stale completion timestamp", async () => {
    mockReadWorkspaceState.mockResolvedValue({
      version: 1,
      onboardingCompletedAt: 1710000000000,
    });
    mockReadFile.mockResolvedValue("# BOOTSTRAP.md\nContent");

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(true);
    expect(mockReadFile).toHaveBeenCalledWith("/workspace/BOOTSTRAP.md", "utf-8");
    expect(mockIncrementOnboardingCount).toHaveBeenCalledWith("/workspace");
  });

  it("returns false when BOOTSTRAP.md is missing (file absent)", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(false);
  });

  it("returns false on filesystem errors (graceful degradation)", async () => {
    // readWorkspaceState returns safe defaults on any error
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    // fs.readFile throws a permission error
    mockReadFile.mockRejectedValue(new Error("EACCES: permission denied"));

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(false);
  });

  it("returns false when BOOTSTRAP.md exists but is empty", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("");

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(false);
    // Should not proceed to identity or count checks
    expect(mockIsIdentityFilled).not.toHaveBeenCalled();
    expect(mockIncrementOnboardingCount).not.toHaveBeenCalled();
  });

  it("returns false when BOOTSTRAP.md contains only whitespace", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("   \n  \n  ");

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(false);
    expect(mockIsIdentityFilled).not.toHaveBeenCalled();
    expect(mockIncrementOnboardingCount).not.toHaveBeenCalled();
  });

  it("keeps onboarding active when identity is filled but the remaining setup is pending", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("# BOOTSTRAP.md\nContent");
    mockIsIdentityFilled.mockResolvedValue(true);

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(true);
    expect(mockIsIdentityFilled).not.toHaveBeenCalled();
  });

  it("does not use identity as an onboarding completion signal", async () => {
    mockReadWorkspaceState.mockResolvedValue({
      version: 1,
      onboardingCompletedAt: 1710000000000,
    });

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(true);
    expect(mockIsIdentityFilled).not.toHaveBeenCalled();
  });

  it("does not check identity when BOOTSTRAP.md is missing", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(false);
    expect(mockIsIdentityFilled).not.toHaveBeenCalled();
  });

  it("does not check identity when BOOTSTRAP.md is empty", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("");

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(false);
    expect(mockIsIdentityFilled).not.toHaveBeenCalled();
  });

  it("does not abandon a staged onboarding conversation after three messages", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("# BOOTSTRAP.md\nContent");
    mockIsIdentityFilled.mockResolvedValue(false);
    mockIncrementOnboardingCount.mockResolvedValue(4);

    const result = await detectOnboardingState("/workspace");

    expect(result).toBe(true);
    expect(mockWriteWorkspaceState).not.toHaveBeenCalled();
  });

  it("increments diagnostic message count when a stale completion timestamp accompanies pending setup", async () => {
    mockReadWorkspaceState.mockResolvedValue({
      version: 1,
      onboardingCompletedAt: 1710000000000,
    });

    await detectOnboardingState("/workspace");

    expect(mockIncrementOnboardingCount).toHaveBeenCalledWith("/workspace");
  });

  it("does not increment count when BOOTSTRAP.md is missing", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await detectOnboardingState("/workspace");

    expect(mockIncrementOnboardingCount).not.toHaveBeenCalled();
  });

  it("does not increment count when BOOTSTRAP.md is empty", async () => {
    mockReadWorkspaceState.mockResolvedValue({ version: 1 });
    mockReadFile.mockResolvedValue("");

    await detectOnboardingState("/workspace");

    expect(mockIncrementOnboardingCount).not.toHaveBeenCalled();
  });
});
