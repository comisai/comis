// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../client/rpc-client.js", () => {
  return {
    callTyped: vi.fn(),
    withClient: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn({})),
  };
});

import { callTyped } from "../../client/rpc-client.js";
import { repairConfigAudit } from "./repair-config-audit.js";

describe("repairConfigAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls config.audit.scrub with dryRun:false and reports rewritten records", async () => {
    const mock = vi.mocked(callTyped);
    mock.mockResolvedValueOnce({ rewrittenRecords: 7, skippedMalformed: 0, aborted: false });

    const result = await repairConfigAudit();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatch(/rewrote 7 record/i);
    }
    const [, , params] = mock.mock.calls[0]!;
    expect(params).toMatchObject({ dryRun: false });
  });

  it("reports 'log already clean' when no records needed rewriting", async () => {
    vi.mocked(callTyped).mockResolvedValueOnce({
      rewrittenRecords: 0,
      skippedMalformed: 0,
      aborted: false,
    });

    const result = await repairConfigAudit();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatch(/already clean/i);
    }
  });

  it("reports concurrent-append abort as an action", async () => {
    vi.mocked(callTyped).mockResolvedValueOnce({
      rewrittenRecords: 0,
      skippedMalformed: 0,
      aborted: true,
    });

    const result = await repairConfigAudit();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toMatch(/aborted/i);
    }
  });

  it("surfaces daemon-not-running (callTyped throws) as Err", async () => {
    vi.mocked(callTyped).mockRejectedValueOnce(
      new Error("Daemon not running on ws://localhost:4766/ws"),
    );

    const result = await repairConfigAudit();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Daemon not running/i);
    }
  });
});
