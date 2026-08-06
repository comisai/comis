// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { createMockLogger } from "../../../../../test/support/mock-logger.js";
import { commitConfigVersionBestEffort } from "./config-git-commit.js";

const metadata = {
  section: "logLevel",
  summary: "Changed logLevel",
};

describe("commitConfigVersionBestEffort", () => {
  it("logs a resolved Result error as a failed config commit", async () => {
    const logger = createMockLogger();
    const manager = { commit: vi.fn().mockResolvedValue(err("git unavailable")) };

    const result = await commitConfigVersionBestEffort(
      manager,
      metadata,
      logger,
      { method: "config.patch", section: "logLevel" },
    );

    expect(result).toEqual(err("git unavailable"));
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "config.patch",
        section: "logLevel",
        outcome: "failure",
        err: "git unavailable",
      }),
      "Git commit failed (best-effort)",
    );
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "success" }),
      "Git commit recorded",
    );
  });

  it("logs a successful config commit only after an ok Result", async () => {
    const logger = createMockLogger();
    const manager = { commit: vi.fn().mockResolvedValue(ok("test-sha")) };

    const result = await commitConfigVersionBestEffort(
      manager,
      metadata,
      logger,
      { method: "persistToConfig" },
    );

    expect(result).toEqual(ok("test-sha"));
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ method: "persistToConfig", outcome: "success" }),
      "Git commit recorded",
    );
  });

  it("contains an unexpected rejected commit without failing persistence", async () => {
    const logger = createMockLogger();
    const manager = { commit: vi.fn().mockRejectedValue(new Error("runner failed")) };

    const result = await commitConfigVersionBestEffort(
      manager,
      metadata,
      logger,
      { method: "config.apply", section: "logLevel" },
    );

    expect(result).toEqual(err("runner failed"));
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ method: "config.apply", outcome: "failure", err: "runner failed" }),
      "Git commit failed (best-effort)",
    );
  });
});
