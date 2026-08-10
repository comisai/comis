// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { narrowManagedTerminalScope } from "./terminal-managed-create.js";

describe("managed terminal scope narrowing", () => {
  it("retains operator-reviewed credential binds while forcing the leased workspace root", () => {
    expect(narrowManagedTerminalScope({
      filesystem: "home",
      network: "full",
      credentialPaths: ["/home/comis/.codex/auth.json"],
      uid: "daemon",
    })).toEqual({
      filesystem: "workspace",
      network: "full",
      credentialPaths: ["/home/comis/.codex/auth.json"],
      uid: "daemon",
    });
  });
});
