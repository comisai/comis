// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { collectHostSnapshot } from "./host-snapshot.js";
import { HostSnapshotSchema } from "./types.js";
import { readCliVersion } from "../util/cli-version.js";

/**
 * The complete set of keys a content-free HostSnapshot may carry. Anything
 * outside this set — a hostname, an environment value, a git field — is a
 * host-enumeration leak the bundle must never introduce (T-3: omission beats
 * hashing).
 */
const ALLOWED_HOST_KEYS = new Set([
  "cliVersion",
  "daemonVersion",
  "nodeVersion",
  "platform",
  "arch",
]);

/** A stub that reports the daemon as down so the content-free path never probes. */
const daemonDown = { isDaemonRunning: async (): Promise<boolean> => false };

describe("collectHostSnapshot content-free fields", () => {
  it("reports cliVersion from the shared reader and node/platform/arch from process", async () => {
    const snapshot = await collectHostSnapshot(daemonDown);

    expect(snapshot.cliVersion).toBe(readCliVersion());
    expect(snapshot.nodeVersion).toBe(process.version);
    expect(snapshot.platform).toBe(process.platform);
    expect(snapshot.arch).toBe(process.arch);
  });

  it("carries only the allowed host keys — no hostname, environment, or git fields", async () => {
    const snapshot = await collectHostSnapshot(daemonDown);

    for (const key of Object.keys(snapshot)) {
      expect(ALLOWED_HOST_KEYS.has(key)).toBe(true);
    }
    expect("hostname" in snapshot).toBe(false);
    expect("env" in snapshot).toBe(false);
    expect("git" in snapshot).toBe(false);

    // strictObject rejects any unknown key, so a content-free snapshot
    // round-trips through the schema — a host-enumerating field would fail here.
    expect(HostSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});
