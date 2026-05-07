// SPDX-License-Identifier: Apache-2.0
//
// Composite-key BackgroundSessionResolver tests.
//
// The `BackgroundSessionResolver` factory at
// `packages/agent/src/background/session-resolver.ts` wraps
// `ActiveRunRegistry` and exposes composite-key (agentId, channelType,
// channelId) lookups. The resolver replaces single-arg `.has(sessionKey)`
// / `.get(sessionKey)` calls across production source files.
//
// We use dynamic-import-with-undefined so the suite reaches assertions
// and fails meaningfully (not via module-not-found).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createActiveRunRegistry, type RunHandle } from "../executor/active-run-registry.js";
import { formatSessionKey } from "@comis/core";
import type { Result } from "@comis/shared";

function makeRunHandle(name = "run"): RunHandle {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    isStreaming: vi.fn().mockReturnValue(false),
    isCompacting: vi.fn().mockReturnValue(false),
    // Tag the handle so we can prove resolveActiveSession returns the right one.
    _name: name,
  } as RunHandle & { _name: string };
}

interface CompositeKey {
  agentId: string;
  channelType: string;
  channelId: string;
}

interface ResolverModule {
  createBackgroundSessionResolver: (deps: {
    activeRunRegistry: ReturnType<typeof createActiveRunRegistry>;
  }) => {
    resolveActiveSession: (key: CompositeKey) => RunHandle | undefined;
    hasActiveSession: (key: CompositeKey) => boolean;
  };
}

async function loadResolver(): Promise<ResolverModule | undefined> {
  try {
    const mod = (await import("./session-resolver.js")) as Record<string, unknown>;
    if (typeof mod.createBackgroundSessionResolver !== "function") return undefined;
    return mod as unknown as ResolverModule;
  } catch {
    return undefined;
  }
}

describe("BackgroundSessionResolver", () => {
  let registry: ReturnType<typeof createActiveRunRegistry>;

  beforeEach(() => {
    registry = createActiveRunRegistry();
  });

  it("resolveActiveSession returns the RunHandle when a matching formatted-key is registered", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    const handle = makeRunHandle("h1");
    const composite = { agentId: "default", channelType: "telegram", channelId: "678" };
    const formatted = formatSessionKey({
      tenantId: composite.agentId,
      channelId: `${composite.channelType}:${composite.channelId}`,
      userId: composite.channelId,
    });
    registry.register(formatted, handle);
    const resolver = mod.createBackgroundSessionResolver({ activeRunRegistry: registry });
    expect(resolver.resolveActiveSession(composite)).toBe(handle);
  });

  it("resolveActiveSession returns undefined when no session is registered", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    const resolver = mod.createBackgroundSessionResolver({ activeRunRegistry: registry });
    expect(
      resolver.resolveActiveSession({ agentId: "default", channelType: "telegram", channelId: "999" }),
    ).toBeUndefined();
  });

  it("distinguishes the same channelId across different agents", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    const handleDefault = makeRunHandle("default");
    const handleAlice = makeRunHandle("alice");
    const compositeDefault = { agentId: "default", channelType: "telegram", channelId: "123" };
    const compositeAlice = { agentId: "alice", channelType: "telegram", channelId: "123" };
    registry.register(
      formatSessionKey({
        tenantId: compositeDefault.agentId,
        channelId: `${compositeDefault.channelType}:${compositeDefault.channelId}`,
        userId: compositeDefault.channelId,
      }),
      handleDefault,
    );
    registry.register(
      formatSessionKey({
        tenantId: compositeAlice.agentId,
        channelId: `${compositeAlice.channelType}:${compositeAlice.channelId}`,
        userId: compositeAlice.channelId,
      }),
      handleAlice,
    );
    const resolver = mod.createBackgroundSessionResolver({ activeRunRegistry: registry });
    expect(resolver.resolveActiveSession(compositeDefault)).toBe(handleDefault);
    expect(resolver.resolveActiveSession(compositeAlice)).toBe(handleAlice);
  });

  it("distinguishes the same agentId+channelId across different channels", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    const handleTelegram = makeRunHandle("telegram");
    const handleDiscord = makeRunHandle("discord");
    const compositeTg = { agentId: "default", channelType: "telegram", channelId: "abc" };
    const compositeDc = { agentId: "default", channelType: "discord", channelId: "abc" };
    registry.register(
      formatSessionKey({
        tenantId: compositeTg.agentId,
        channelId: `${compositeTg.channelType}:${compositeTg.channelId}`,
        userId: compositeTg.channelId,
      }),
      handleTelegram,
    );
    registry.register(
      formatSessionKey({
        tenantId: compositeDc.agentId,
        channelId: `${compositeDc.channelType}:${compositeDc.channelId}`,
        userId: compositeDc.channelId,
      }),
      handleDiscord,
    );
    const resolver = mod.createBackgroundSessionResolver({ activeRunRegistry: registry });
    expect(resolver.resolveActiveSession(compositeTg)).toBe(handleTelegram);
    expect(resolver.resolveActiveSession(compositeDc)).toBe(handleDiscord);
  });

  it("hasActiveSession returns boolean, never throws on missing", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    const resolver = mod.createBackgroundSessionResolver({ activeRunRegistry: registry });
    expect(typeof resolver.hasActiveSession({ agentId: "x", channelType: "y", channelId: "z" })).toBe("boolean");
    expect(resolver.hasActiveSession({ agentId: "x", channelType: "y", channelId: "z" })).toBe(false);

    // Now register and verify true.
    const handle = makeRunHandle();
    const formatted = formatSessionKey({ tenantId: "x", channelId: "y:z", userId: "z" });
    registry.register(formatted, handle);
    expect(resolver.hasActiveSession({ agentId: "x", channelType: "y", channelId: "z" })).toBe(true);
  });

  it("resolver uses formatSessionKey internally — does NOT accept a raw single-arg sessionKey from external callers", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    const resolver = mod.createBackgroundSessionResolver({
      activeRunRegistry: registry,
    });
    // Type-level: only resolveActiveSession({agentId, channelType, channelId})
    // is exposed. There is NO single-arg signature like
    // resolveActiveSession("default:tg:123:peer:678"). We probe at runtime
    // by ensuring resolveActiveSession is a unary function (one argument)
    // that accepts the composite key.
    expect(resolver.resolveActiveSession.length).toBeLessThanOrEqual(1);

    // And calling it with the composite returns either undefined or a
    // RunHandle — never throws on missing.
    expect(() =>
      resolver.resolveActiveSession({
        agentId: "missing",
        channelType: "tg",
        channelId: "0",
      }),
    ).not.toThrow();
  });

  it("empty / falsy agentId / channelType / channelId raises a typed Result.err (no silent fallback)", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    // The contract: empty composite-key fields are a programming error and
    // must be surfaced. Two acceptable shapes: (a) the resolver returns a
    // Result<RunHandle | undefined, Error> when given empty fields, or
    // (b) it throws — either way, the silent-fallback path is forbidden
    // (parity with manager.promote's empty-string guards in
    // background-task-manager.ts:96-107).
    const resolver = mod.createBackgroundSessionResolver({ activeRunRegistry: registry }) as unknown as {
      resolveActiveSession: (
        key: CompositeKey,
      ) => RunHandle | undefined | Result<RunHandle | undefined, Error>;
    };

    let observedError = false;
    try {
      const out = resolver.resolveActiveSession({
        agentId: "",
        channelType: "telegram",
        channelId: "1",
      });
      // Result<T,E> shape: ok=false signals a typed error (acceptable contract).
      if (out && typeof out === "object" && "ok" in out && (out as { ok: boolean }).ok === false) {
        observedError = true;
      }
    } catch {
      observedError = true;
    }
    expect(observedError).toBe(true);
  });

  it("register-via-pi-executor-shape → resolve-via-resolver returns the same handle", async () => {
    const mod = await loadResolver();
    expect(mod).toBeDefined();
    if (!mod) return;
    const handle = makeRunHandle("h-rc1");
    const triple = { agentId: "default", channelType: "telegram", channelId: "678" };
    // Mirror the EXACT key formula pi-executor.ts uses to register handles.
    // If this drifts away from formatComposite, multi-agent isolation
    // re-opens; the equality assertion below catches drift on either side.
    const executorRegisterKey = formatSessionKey({
      tenantId: triple.agentId,
      channelId: `${triple.channelType}:${triple.channelId}`,
      userId: triple.channelId,
    });
    registry.register(executorRegisterKey, handle);
    const resolver = mod.createBackgroundSessionResolver({ activeRunRegistry: registry });
    expect(resolver.resolveActiveSession(triple)).toBe(handle);
    expect(resolver.hasActiveSession(triple)).toBe(true);
    // Multi-agent isolation: a different agentId for the same (channelType, channelId)
    // must NOT find this handle.
    expect(resolver.hasActiveSession({ ...triple, agentId: "other" })).toBe(false);
    expect(resolver.resolveActiveSession({ ...triple, agentId: "other" })).toBeUndefined();
  });
});
