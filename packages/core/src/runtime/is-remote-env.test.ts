// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `isRemoteEnvironment(input)` — VPS / headless detection.
 *
 * Mirrors the tests at packages/agent/src/model/oauth-env.test.ts verbatim
 * (the function was relocated from agent → core in Phase 35 Plan 35-02 per
 * Decision D-01 #3). After Plan 35-04 retargets CLI consumers and removes
 * the agent-side copy, this remains the only test file for the function.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { isRemoteEnvironment } from "./is-remote-env.js";

describe("isRemoteEnvironment", () => {
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
