// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ok } from "@comis/shared";
import {
  sendGroupActivate,
  sendGroupAbandon,
} from "./capability-service-run-commands.js";

function capture() {
  const frames: unknown[] = [];
  const sendControl = async <T>(
    frame: unknown,
    _request: z.ZodType,
    _response: z.ZodType,
  ) => {
    frames.push(frame);
    return ok({} as T);
  };
  return { frames, sendControl };
}

describe("managed-run group control commands", () => {
  it("names every prepared member in one activation frame", async () => {
    const { frames, sendControl } = capture();
    await sendGroupActivate({
      operationId: "operation_a",
      serviceInstanceId: "service-instance_a",
      managedRunGroupId: "managed-run-group_a",
      registrationNonce: "group-registration-nonce_aaaa",
      members: [
        {
          managedRunId: "managed-run_a",
          externalRunRef: "external-run_a",
          registrationNonce: "registration-nonce_aaaa",
        },
        {
          managedRunId: "managed-run_b",
          externalRunRef: "external-run_b",
          registrationNonce: "registration-nonce_bbbb",
          workspaceLeaseId: "workspace-lease_b",
          executionAttachmentId: "execution-attachment_b",
          attachmentTargetName: "attachment-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock",
        },
      ],
    }, sendControl);

    const frame = frames[0] as { method: string; id: string; params: Record<string, unknown> };
    expect(frame.method).toBe("managedRunGroups.activate");
    // The envelope id and the operation id are the same value, so one operation
    // cannot be replayed under a different envelope.
    expect(frame.id).toBe("operation_a");
    expect(frame.params["operationId"]).toBe("operation_a");
    expect(frame.params["registrationNonce"]).toBe("group-registration-nonce_aaaa");
    expect(frame.params["members"]).toEqual([
      {
        managedRunId: "managed-run_a",
        externalRunRef: "external-run_a",
        registrationNonce: "registration-nonce_aaaa",
      },
      {
        managedRunId: "managed-run_b",
        externalRunRef: "external-run_b",
        registrationNonce: "registration-nonce_bbbb",
        workspaceLeaseId: "workspace-lease_b",
        executionAttachmentId: "execution-attachment_b",
        attachmentTargetName: "attachment-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.sock",
      },
    ]);
  });

  it("omits an absent workspace lease rather than sending it empty", async () => {
    const { frames, sendControl } = capture();
    await sendGroupActivate({
      operationId: "operation_a",
      serviceInstanceId: "service-instance_a",
      managedRunGroupId: "managed-run-group_a",
      registrationNonce: "group-registration-nonce_aaaa",
      members: [{
        managedRunId: "managed-run_a",
        externalRunRef: "external-run_a",
        registrationNonce: "registration-nonce_aaaa",
      }],
    }, sendControl);
    const frame = frames[0] as { params: { members: readonly Record<string, unknown>[] } };
    expect(Object.keys(frame.params.members[0] ?? {})).not.toContain("workspaceLeaseId");
  });

  it("carries the reap disposition when abandoning a group preparation", async () => {
    const { frames, sendControl } = capture();
    await sendGroupAbandon({
      operationId: "operation_b",
      serviceInstanceId: "service-instance_a",
      managedRunGroupId: "managed-run-group_a",
      registrationNonce: "group-registration-nonce_aaaa",
      members: [
        {
          managedRunId: "managed-run_a",
          externalRunRef: "external-run_a",
          registrationNonce: "registration-nonce_aaaa",
        },
        {
          managedRunId: "managed-run_b",
          externalRunRef: "external-run_b",
          registrationNonce: "registration-nonce_bbbb",
        },
      ],
      reason: "registration_expired",
      disposition: "reap_safe",
    }, sendControl);
    const frame = frames[0] as { method: string; params: Record<string, unknown> };
    expect(frame.method).toBe("managedRunGroups.abandon");
    expect(frame.params["reason"]).toBe("registration_expired");
    expect(frame.params["disposition"]).toBe("reap_safe");
    expect(frame.params["registrationNonce"]).toBe("group-registration-nonce_aaaa");
    expect(frame.params["members"]).toEqual([
      {
        managedRunId: "managed-run_a",
        externalRunRef: "external-run_a",
        registrationNonce: "registration-nonce_aaaa",
      },
      {
        managedRunId: "managed-run_b",
        externalRunRef: "external-run_b",
        registrationNonce: "registration-nonce_bbbb",
      },
    ]);
  });
});
