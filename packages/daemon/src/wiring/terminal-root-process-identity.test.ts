// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import {
  createTerminalRootProcessIdentityResolver,
  createTerminalRootProcessIdentitySyncResolver,
  parseLinuxProcessStartIdentity,
} from "./terminal-root-process-identity.js";

describe("terminal root process identity", () => {
  it("parses Linux proc start ticks after a command name containing spaces and parentheses", () => {
    const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "991"];
    expect(parseLinuxProcessStartIdentity(`6200 (bash (worker)) ${fields.join(" ")}`)).toBe("linux:991");
  });

  it("resolves a positive Linux PID from the exact proc stat file", async () => {
    const readText = vi.fn(async () => {
      const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "44221"];
      return `6200 (bwrap) ${fields.join(" ")}`;
    });
    const resolveIdentity = createTerminalRootProcessIdentityResolver({ platform: "linux", readText });

    await expect(resolveIdentity(6200)).resolves.toEqual({ pid: 6200, startIdentity: "linux:44221" });
    expect(readText).toHaveBeenCalledWith("/proc/6200/stat");
  });

  it("fails closed when the process identity cannot be proven", async () => {
    const resolveIdentity = createTerminalRootProcessIdentityResolver({
      platform: "linux",
      readText: vi.fn(async () => "malformed"),
    });
    await expect(resolveIdentity(6200)).resolves.toBeUndefined();
  });

  it("resolves the same exact Linux start identity during synchronous boot recovery", () => {
    const readText = vi.fn(() => {
      const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "44221"];
      return `6200 (bwrap) ${fields.join(" ")}`;
    });
    const resolveIdentity = createTerminalRootProcessIdentitySyncResolver({ platform: "linux", readText });

    expect(resolveIdentity(6200)).toEqual({ pid: 6200, startIdentity: "linux:44221" });
    expect(readText).toHaveBeenCalledWith("/proc/6200/stat");
  });
});
