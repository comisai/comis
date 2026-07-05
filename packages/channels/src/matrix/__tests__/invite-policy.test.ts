// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { decideInvite } from "../invite-policy.js";

describe("decideInvite", () => {
  it("never joins when auto-join is disabled, even for an allowlisted inviter", () => {
    // The master switch wins over every trust-set membership.
    expect(
      decideInvite({
        autoJoinOnInvite: false,
        allowMode: "allowlist",
        allowFrom: ["@a:hs"],
        inviterMxid: "@a:hs",
      }),
    ).toBe("ignore");
  });

  it("never joins when auto-join is disabled, even in open mode", () => {
    expect(
      decideInvite({
        autoJoinOnInvite: false,
        allowMode: "open",
        allowFrom: [],
        inviterMxid: "@anyone:hs",
      }),
    ).toBe("ignore");
  });

  it("joins when auto-join is enabled and the inviter MXID is in the allowlist", () => {
    expect(
      decideInvite({
        autoJoinOnInvite: true,
        allowMode: "allowlist",
        allowFrom: ["@a:hs"],
        inviterMxid: "@a:hs",
      }),
    ).toBe("join");
  });

  it("ignores an invite from an MXID that is not in the allowlist", () => {
    expect(
      decideInvite({
        autoJoinOnInvite: true,
        allowMode: "allowlist",
        allowFrom: ["@a:hs"],
        inviterMxid: "@evil:hs",
      }),
    ).toBe("ignore");
  });

  it("joins nothing when the allowlist is empty (the default-closed posture)", () => {
    // An empty allowlist admits no inviter — the bot is pulled into no room.
    expect(
      decideInvite({
        autoJoinOnInvite: true,
        allowMode: "allowlist",
        allowFrom: [],
        inviterMxid: "@a:hs",
      }),
    ).toBe("ignore");
  });

  it("joins any invite when auto-join is enabled and the mode is open", () => {
    expect(
      decideInvite({
        autoJoinOnInvite: true,
        allowMode: "open",
        allowFrom: [],
        inviterMxid: "@anyone:hs",
      }),
    ).toBe("join");
  });

  it("keys the decision on the full inviter MXID, never a display-name-like value", () => {
    // A display name is attacker-settable; only the exact full MXID may match.
    const allowFrom = ["@alice:example.org"];
    // A bare localpart / display-name-like value is not the MXID → ignore.
    expect(
      decideInvite({
        autoJoinOnInvite: true,
        allowMode: "allowlist",
        allowFrom,
        inviterMxid: "alice",
      }),
    ).toBe("ignore");
    // Same localpart but a different homeserver is a different identity → ignore.
    expect(
      decideInvite({
        autoJoinOnInvite: true,
        allowMode: "allowlist",
        allowFrom,
        inviterMxid: "@alice:evil.example",
      }),
    ).toBe("ignore");
    // The exact full MXID matches → join.
    expect(
      decideInvite({
        autoJoinOnInvite: true,
        allowMode: "allowlist",
        allowFrom,
        inviterMxid: "@alice:example.org",
      }),
    ).toBe("join");
  });
});
