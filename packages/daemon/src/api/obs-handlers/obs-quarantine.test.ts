// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { bindObsQuarantineHandlers } from "./obs-quarantine.js";
import type { ObsHandlerDeps } from "./obs-helpers.js";

function listHandler(listQuarantined: () => Promise<unknown>) {
  const deps = {
    deadLetterQueue: {
      listQuarantined,
    },
  } as unknown as ObsHandlerDeps;
  return bindObsQuarantineHandlers(deps)["obs.quarantine.list"];
}

describe("obs.quarantine.list handler", () => {
  it("propagates an unreadable durable quarantine", async () => {
    const handler = listHandler(vi.fn(async () => err(new Error("quarantine unreadable"))));

    await expect(handler({ _trustLevel: "admin" })).rejects.toThrow("quarantine unreadable");
  });

  it("returns the content-free durable projection", async () => {
    const handler = listHandler(vi.fn(async () => ok([{
      id: "entry-1",
      kind: "entry" as const,
      runId: "run-1",
      channelType: "telegram",
      channelId: "chat-1",
      failedAt: 100,
      attemptCount: 1,
      announcementChars: 24,
    }])));

    await expect(handler({ _trustLevel: "admin" })).resolves.toMatchObject({
      total: 1,
      rows: [{ id: "entry-1", announcementChars: 24 }],
    });
  });
});
