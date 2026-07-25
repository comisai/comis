// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safePath } from "@comis/core";
import { createGraphReportTargetStore } from "./graph-report-target-store.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "comis-graph-report-targets-"));
  roots.push(root);
  return root;
}

const registration = {
  graphId: "11111111-2222-4333-8444-555555555555",
  tenantId: "tenant-a",
  userId: "user-a",
  sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
  agentId: "agent-1",
  channelType: "telegram",
  channelKey: "chat-1",
  expiresAt: 1_300_000,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable graph report target store", () => {
  it("atomically restores owner-only targets with mode 0600 after restart", () => {
    const root = makeRoot();
    const store = createGraphReportTargetStore({ dataDir: root });

    expect(store.load()).toEqual({ ok: true, value: [] });
    expect(store.replace([registration])).toEqual({ ok: true, value: undefined });

    const target = safePath(root, "graph-report-targets.json");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual([registration]);
    expect(createGraphReportTargetStore({ dataDir: root }).load()).toEqual({
      ok: true,
      value: [registration],
    });
  });

  it("fails closed when the durable target snapshot is malformed", () => {
    const root = makeRoot();
    writeFileSync(safePath(root, "graph-report-targets.json"), "{not-json", { mode: 0o600 });

    const loaded = createGraphReportTargetStore({ dataDir: root }).load();

    expect(loaded.ok).toBe(false);
  });

  it("refuses to follow a symlink while loading a target snapshot", () => {
    const root = makeRoot();
    const store = createGraphReportTargetStore({ dataDir: root });
    const outside = safePath(root, "outside.json");
    writeFileSync(outside, JSON.stringify([registration]), { mode: 0o600 });
    symlinkSync(outside, safePath(root, "graph-report-targets.json"));

    const loaded = store.load();

    expect(loaded.ok).toBe(false);
  });
});
