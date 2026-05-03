// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { isRemoteEnvironment } from "./oauth-env.js";

describe("isRemoteEnvironment (Phase 8 D-04 — SPEC R2)", () => {
  it("returns true when SSH_CLIENT is set, no force", () => {
    expect(isRemoteEnvironment({ env: { SSH_CLIENT: "1.2.3.4 22 22" } })).toBe(true);
  });

  it("returns true when SSH_TTY is set, no force", () => {
    expect(isRemoteEnvironment({ env: { SSH_TTY: "/dev/pts/0" } })).toBe(true);
  });

  it("returns true when DISPLAY is absent, no force", () => {
    expect(isRemoteEnvironment({ env: {} })).toBe(true);
  });

  it("returns false when DISPLAY present, no SSH, no force", () => {
    expect(isRemoteEnvironment({ env: { DISPLAY: ":0" } })).toBe(false);
  });

  it("force: 'local' overrides SSH_CLIENT presence", () => {
    expect(
      isRemoteEnvironment({ env: { SSH_CLIENT: "1.2.3.4 22 22" }, force: "local" }),
    ).toBe(false);
  });

  it("force: 'remote' overrides DISPLAY presence", () => {
    expect(
      isRemoteEnvironment({ env: { DISPLAY: ":0" }, force: "remote" }),
    ).toBe(true);
  });
});
