// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./loopback-host.js";

describe("isLoopbackHost — the shared TLS-off-is-benign-on-loopback judgment", () => {
  it("treats 127.0.0.1 / ::1 / localhost / 127.x addresses as loopback binds", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("  LOCALHOST  ")).toBe(true);
  });

  it("treats 0.0.0.0 / a routable IP / undefined as NON-loopback (never suppress on doubt)", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.244.129.35")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});
