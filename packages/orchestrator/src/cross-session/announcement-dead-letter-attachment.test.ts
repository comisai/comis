// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { drainWithPreparedRecoveryAttachment } from "./announcement-dead-letter-attachment.js";

describe("dead-letter attachment recovery", () => {
  it("drains the immutable snapshot retained at admission", async () => {
    const snapshot = {
      kind: "snapshot" as const,
      sourceAgentId: "worker-a",
      sourcePath: "report.txt",
      path: "/snapshots/report.txt",
      fileName: "report.txt",
      mimeType: "text/plain",
      contentDigest: "a".repeat(64),
      sizeBytes: 12,
    };
    const drainPrepared = vi.fn(async () => "receipt_committed_now" as const);

    await expect(drainWithPreparedRecoveryAttachment({
      attachment: snapshot,
      drainPrepared,
    })).resolves.toBe("receipt_committed_now");

    expect(drainPrepared).toHaveBeenCalledWith(snapshot);
  });

  it("drains a text operation without attachment state", async () => {
    const drainPrepared = vi.fn(async () => "receipt_committed_now" as const);

    await expect(drainWithPreparedRecoveryAttachment({
      attachment: undefined,
      drainPrepared,
    })).resolves.toBe("receipt_committed_now");

    expect(drainPrepared).toHaveBeenCalledWith(undefined);
  });
});
