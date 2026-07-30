// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  enforcePersistentActionEvidence,
  hasTrustedRuntimeActionEvidence,
} from "./persistent-action-evidence.js";

describe("persistent action runtime evidence", () => {
  it("accepts an authenticated completion receipt as current evidence", () => {
    expect(enforcePersistentActionEvidence({
      request: "keep checking until it passes",
      response: "the operation passed",
      currentActionEvidence: true,
      honestResponse: "not verified",
    })).toEqual({
      response: "the operation passed",
      corrected: false,
    });
  });

  it("rejects the same receipt outside the internal relay identity", () => {
    const metadata = {
      runtimeActionEvidence: { kind: "background_completion" as const },
    };
    expect(hasTrustedRuntimeActionEvidence({
      channelType: "cross-session",
      senderId: "cross-session-relay",
      metadata,
    })).toBe(true);
    expect(hasTrustedRuntimeActionEvidence({
      channelType: "telegram",
      senderId: "user_a",
      metadata,
    })).toBe(false);
  });
});
