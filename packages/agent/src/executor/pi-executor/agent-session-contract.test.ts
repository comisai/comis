// SPDX-License-Identifier: Apache-2.0
/**
 * REAL-SDK contract test for the `session.agent` mutation surface.
 *
 * PiExecutor drives the agent loop by mutating properties on the live
 * AgentSession's agent (pi-executor.ts): `beforeToolCall`, `afterToolCall`,
 * `streamFn`, `transformContext`, and `state.messages`. That surface is a
 * plain-property contract with no compile-time seam on our side — a silent
 * SDK rename passes every mocked unit test and only surfaces at runtime.
 * This suite constructs a REAL AgentSession (in-memory managers, offline
 * ModelRuntime, no network/auth) and pins the exact properties the executor
 * writes, so an SDK bump that moves them fails here instead of in
 * production.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { ComisCredentialStore } from "../../model/auth-storage-adapter.js";

let scratchDir: string;
let session: AgentSession;

beforeAll(async () => {
  scratchDir = mkdtempSync(resolve(tmpdir(), "agent-session-contract-"));
  const modelRuntime = await ModelRuntime.create({
    credentials: new ComisCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  ({ session } = await createAgentSession({
    cwd: scratchDir,
    agentDir: scratchDir,
    modelRuntime,
    sessionManager: SessionManager.inMemory(scratchDir),
    settingsManager: SettingsManager.inMemory(),
  }));
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("session.agent mutation surface — REAL SDK boundary", () => {
  it("accepts the beforeToolCall and afterToolCall hook assignments and reads them back", () => {
    const before = async () => undefined;
    const after = async () => undefined;

    session.agent.beforeToolCall = before;
    session.agent.afterToolCall = after;

    expect(session.agent.beforeToolCall).toBe(before);
    expect(session.agent.afterToolCall).toBe(after);
  });

  it("accepts a streamFn override and reads it back", () => {
    const custom: StreamFn = (() => {
      throw new Error("never invoked in this contract test");
    }) as unknown as StreamFn;

    session.agent.streamFn = custom;
    expect(session.agent.streamFn).toBe(custom);
  });

  it("accepts a transformContext hook as a typed property (no cast needed)", () => {
    const transform = async (messages: AgentMessage[]) => messages;

    session.agent.transformContext = transform;
    expect(session.agent.transformContext).toBe(transform);
  });

  it("replaces state.messages contents on assignment (the SDK copies the top-level array)", () => {
    expect(Array.isArray(session.agent.state.messages)).toBe(true);

    // Documented SDK contract: "Assigning `state.tools` or `state.messages`
    // copies the provided top-level array" — the executor's session-restore
    // write (pi-executor.ts) relies on contents landing, not on identity.
    const restored = [
      { role: "user", content: "restored-marker" },
    ] as unknown as typeof session.agent.state.messages;
    session.agent.state.messages = restored;

    expect(session.agent.state.messages).not.toBe(restored);
    expect(session.agent.state.messages).toHaveLength(1);
    expect(session.agent.state.messages[0]).toMatchObject({ role: "user" });

    session.agent.state.messages = [] as unknown as typeof session.agent.state.messages;
    expect(session.agent.state.messages).toHaveLength(0);
  });
});
