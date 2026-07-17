// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  classifySessionMessageOrigin,
  resolveMessageLimit,
  trustedSessionSender,
} from "./session-message-acceptance.js";

describe("session message acceptance", () => {
  it("defaults only an absent direct-library limit", () => {
    expect(resolveMessageLimit({}, 10_000)).toEqual({
      requested: 10_000,
      effective: 10_000,
      rejected: false,
    });
    expect(resolveMessageLimit({ limit: 0 }, 10_000)).toEqual({
      requested: 0,
      effective: 0,
      rejected: true,
    });
  });

  it("trusts a session sender only when peer and user agree", () => {
    expect(trustedSessionSender({ userId: "user_a", peerId: "user_a" })).toBe("user_a");
    expect(trustedSessionSender({ userId: "user_a", peerId: "user_b" })).toBeUndefined();
    expect(trustedSessionSender({ userId: "main" })).toBeUndefined();
  });

  it("classifies reserved dispatch identities as internal", () => {
    expect(classifySessionMessageOrigin("cron:job_a", "telegram", "user_a"))
      .toBe("internal");
    expect(classifySessionMessageOrigin("chat_a", "cross-session", "user_a"))
      .toBe("internal");
    expect(classifySessionMessageOrigin("chat_a", "telegram", "user_a"))
      .toBe("user");
  });
});
