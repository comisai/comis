// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeStaleCapabilityServiceSocket,
  verifyCapabilityServiceSocketPath,
  verifyCapabilityServiceSocketRoot,
} from "./capability-service-unix-socket.js";

describe("capability-service Unix socket boundary", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cpsocket-")));
    roots.push(root);
    chmodSync(root, 0o700);
    return root;
  }

  it("accepts an owner-only root and its confined socket path", () => {
    const root = makeRoot();
    expect(verifyCapabilityServiceSocketRoot(root)).toEqual({ ok: true, value: undefined });
    expect(verifyCapabilityServiceSocketPath(root, join(root, "service.sock"))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects permissive roots and paths outside their authority", () => {
    const root = makeRoot();
    chmodSync(root, 0o755);
    expect(verifyCapabilityServiceSocketRoot(root)).toMatchObject({ ok: false });
    chmodSync(root, 0o700);
    expect(verifyCapabilityServiceSocketPath(root, join(root, "..", "service.sock"))).toMatchObject({ ok: false });
  });

  it("refuses to remove a non-socket filesystem entry", () => {
    const root = makeRoot();
    const occupied = join(root, "service.sock");
    writeFileSync(occupied, "not a socket", { mode: 0o600 });
    expect(removeStaleCapabilityServiceSocket(occupied)).toMatchObject({ ok: false });
  });
});
