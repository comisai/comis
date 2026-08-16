// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import { drainWithPreparedRecoveryAttachment } from "./announcement-dead-letter-attachment.js";

describe("dead-letter attachment preparation", () => {
  it("prepares, drains, and cleans one retained attachment", async () => {
    const cleanup = vi.fn(async () => ok(undefined));
    const prepared = {
      path: "/snapshots/report.txt",
      fileName: "report.txt",
      mimeType: "text/plain",
      contentDigest: "digest",
      sizeBytes: 12,
      cleanup,
    };
    const drainPrepared = vi.fn(async () => "receipt_committed_now" as const);

    await expect(drainWithPreparedRecoveryAttachment({
      attachment: { sourceAgentId: "worker-a", path: "report.txt" },
      runId: "run-1",
      prepareAttachment: vi.fn(async () => ok(prepared)),
      retain: vi.fn(),
      logFailure: vi.fn(),
      drainPrepared,
    })).resolves.toBe("receipt_committed_now");

    expect(drainPrepared).toHaveBeenCalledWith(prepared);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("retains an attachment when preparation is unavailable", async () => {
    const retain = vi.fn();
    const logFailure = vi.fn();
    const drainPrepared = vi.fn();

    await expect(drainWithPreparedRecoveryAttachment({
      attachment: { sourceAgentId: "worker-a", path: "report.txt" },
      runId: "run-1",
      retain,
      logFailure,
      drainPrepared,
    })).resolves.toBe("retained");

    expect(retain).toHaveBeenCalledWith("attachment_preparation_unavailable");
    expect(logFailure).toHaveBeenCalledOnce();
    expect(drainPrepared).not.toHaveBeenCalled();
  });
});
