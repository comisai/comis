// SPDX-License-Identifier: Apache-2.0
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { safePath } from "@comis/core";
import {
  persistBackgroundRecoveryAuthority,
  recoverBackgroundRecoveryAuthorities,
  removeBackgroundRecoveryAuthority,
  type BackgroundRecoveryAuthority,
} from "./background-recovery-authority.js";

function makeAuthority(): BackgroundRecoveryAuthority {
  return {
    agentId: "agent-a",
    taskId: "task-a",
    toolName: "report",
    sessionKey: "default:agent:agent-a:user_a:conversation-a",
    projectedSessionKey: {
      tenantId: "default",
      agentId: "agent-a",
      userId: "user_a",
      channelId: "conversation-a",
    },
    traceId: null,
    timestamp: 10,
    source: "scan",
    requiredDisposition: "accepted",
    resolutionRequested: false,
  };
}

describe("background recovery authority persistence", () => {
  it("persists bounded protected authority across restart and removes it after resolution", () => {
    const dataDir = safePath(tmpdir(), `comis-recovery-authority-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const authority = makeAuthority();

    const persisted = persistBackgroundRecoveryAuthority(dataDir, authority);
    const recovered = recoverBackgroundRecoveryAuthorities(dataDir);
    const incidentDir = safePath(
      safePath(dataDir, authority.agentId),
      ".recovery-incidents",
    );
    expect(persisted.ok).toBe(true);
    expect(recovered).toEqual({ ok: true, value: [authority] });
    expect(statSync(incidentDir).mode & 0o777).toBe(0o700);
    expect(
      statSync(safePath(incidentDir, readdirSync(incidentDir)[0]!)).mode & 0o777,
    ).toBe(0o600);

    const removed = removeBackgroundRecoveryAuthority(dataDir, authority);
    const afterRemoval = recoverBackgroundRecoveryAuthorities(dataDir);

    expect(removed.ok).toBe(true);
    expect(afterRemoval).toEqual({ ok: true, value: [] });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
