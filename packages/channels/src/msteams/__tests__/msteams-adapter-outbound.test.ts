// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { SendMessageOptions } from "@comis/core";
import {
  resolveReplyToId,
  resolveTypingServiceUrl,
  withTrailingSlash,
} from "../msteams-adapter-outbound.js";

describe("withTrailingSlash", () => {
  it("appends a single trailing slash to a bare service base url", () => {
    expect(withTrailingSlash("https://smba.trafficmanager.net/teams")).toBe(
      "https://smba.trafficmanager.net/teams/",
    );
  });

  it("is idempotent when the base url already ends in a slash", () => {
    expect(withTrailingSlash("https://smba.trafficmanager.net/teams/")).toBe(
      "https://smba.trafficmanager.net/teams/",
    );
  });
});

describe("resolveReplyToId", () => {
  it("forces a DM top-level (undefined) even when a replyTo is supplied", () => {
    const options: SendMessageOptions = {
      replyTo: "parent-activity-id",
      extra: { chatType: "dm" },
    };
    expect(resolveReplyToId(options, "thread-root")).toBeUndefined();
  });

  it("returns the explicit replyTo for a channel or group reply", () => {
    const options: SendMessageOptions = { replyTo: "parent-activity-id" };
    expect(resolveReplyToId(options)).toBe("parent-activity-id");
  });

  it("falls back to extra.replyToId when no top-level replyTo is set", () => {
    const options: SendMessageOptions = { extra: { replyToId: "from-extra" } };
    expect(resolveReplyToId(options)).toBe("from-extra");
  });

  it("threads under the fallback thread root when neither reply target is present", () => {
    expect(resolveReplyToId(undefined, "thread-root")).toBe("thread-root");
  });

  it("returns undefined when there is no reply target and no fallback thread", () => {
    expect(resolveReplyToId(undefined, undefined)).toBeUndefined();
  });
});

describe("resolveTypingServiceUrl", () => {
  it("reads a serviceUrl passed directly in the action params", () => {
    expect(resolveTypingServiceUrl({ serviceUrl: "https://direct/" })).toBe(
      "https://direct/",
    );
  });

  it("reads a serviceUrl nested under the extra params object", () => {
    expect(
      resolveTypingServiceUrl({ extra: { serviceUrl: "https://from-extra/" } }),
    ).toBe("https://from-extra/");
  });

  it("prefers the direct serviceUrl over the one nested under extra", () => {
    expect(
      resolveTypingServiceUrl({
        serviceUrl: "https://direct/",
        extra: { serviceUrl: "https://from-extra/" },
      }),
    ).toBe("https://direct/");
  });

  it("returns undefined when no serviceUrl is present at either location", () => {
    expect(resolveTypingServiceUrl({ chatId: "19:convo" })).toBeUndefined();
  });
});
