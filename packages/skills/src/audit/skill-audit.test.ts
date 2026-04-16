import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { emitSkillAudit } from "./skill-audit.js";

describe("emitSkillAudit", () => {
  let eventBus: TypedEventBus;

  beforeEach(() => {
    eventBus = new TypedEventBus();
  });

  it("emits audit:event with correct fields", () => {
    const handler = vi.fn();
    eventBus.on("audit:event", handler);

    emitSkillAudit(eventBus, {
      agentId: "agent-1",
      tenantId: "tenant-1",
      userId: "user-1",
      skillName: "web-search",
      action: "skill.prompt.load",
      outcome: "success",
      metadata: { source: "bundled" },
    });

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]![0];
    expect(payload.agentId).toBe("agent-1");
    expect(payload.tenantId).toBe("tenant-1");
    expect(payload.actionType).toBe("skill.prompt.load");
    expect(payload.classification).toBe("read");
    expect(payload.outcome).toBe("success");
    expect(payload.metadata).toEqual({ skillName: "web-search", source: "bundled" });
    expect(typeof payload.timestamp).toBe("number");
  });

  it("emits audit:event AND skill:prompt_loaded for skill.prompt.load", () => {
    const auditHandler = vi.fn();
    const loadedHandler = vi.fn();
    eventBus.on("audit:event", auditHandler);
    eventBus.on("skill:prompt_loaded", loadedHandler);

    emitSkillAudit(eventBus, {
      agentId: "agent-1",
      tenantId: "tenant-1",
      userId: "user-1",
      skillName: "greet",
      action: "skill.prompt.load",
      outcome: "success",
      metadata: { source: "./skills/greet", bodyLength: 1500 },
    });

    expect(auditHandler).toHaveBeenCalledOnce();
    const auditPayload = auditHandler.mock.calls[0]![0];
    expect(auditPayload.actionType).toBe("skill.prompt.load");
    expect(auditPayload.classification).toBe("read");

    expect(loadedHandler).toHaveBeenCalledOnce();
    const payload = loadedHandler.mock.calls[0]![0];
    expect(payload.skillName).toBe("greet");
    expect(payload.source).toBe("./skills/greet");
    expect(payload.bodyLength).toBe(1500);
    expect(typeof payload.timestamp).toBe("number");
  });

  it("emits audit:event AND skill:prompt_invoked for skill.prompt.invoke", () => {
    const auditHandler = vi.fn();
    const invokedHandler = vi.fn();
    eventBus.on("audit:event", auditHandler);
    eventBus.on("skill:prompt_invoked", invokedHandler);

    emitSkillAudit(eventBus, {
      agentId: "agent-1",
      tenantId: "tenant-1",
      userId: "user-1",
      skillName: "greet",
      action: "skill.prompt.invoke",
      outcome: "success",
      metadata: { invokedBy: "user", args: "hello world" },
    });

    expect(auditHandler).toHaveBeenCalledOnce();
    const auditPayload = auditHandler.mock.calls[0]![0];
    expect(auditPayload.actionType).toBe("skill.prompt.invoke");
    expect(auditPayload.classification).toBe("mutate");

    expect(invokedHandler).toHaveBeenCalledOnce();
    const payload = invokedHandler.mock.calls[0]![0];
    expect(payload.skillName).toBe("greet");
    expect(payload.invokedBy).toBe("user");
    expect(payload.args).toBe("hello world");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("emits skill:prompt_invoked with invokedBy model", () => {
    const invokedHandler = vi.fn();
    eventBus.on("skill:prompt_invoked", invokedHandler);

    emitSkillAudit(eventBus, {
      agentId: "agent-1",
      tenantId: "tenant-1",
      userId: "user-1",
      skillName: "greet",
      action: "skill.prompt.invoke",
      outcome: "success",
      metadata: { invokedBy: "model", args: "" },
    });

    expect(invokedHandler).toHaveBeenCalledOnce();
    const payload = invokedHandler.mock.calls[0]![0];
    expect(payload.invokedBy).toBe("model");
    expect(payload.args).toBe("");
  });

  it("uses default values when prompt load metadata is missing", () => {
    const loadedHandler = vi.fn();
    eventBus.on("skill:prompt_loaded", loadedHandler);

    emitSkillAudit(eventBus, {
      agentId: "agent-1",
      tenantId: "tenant-1",
      userId: "user-1",
      skillName: "greet",
      action: "skill.prompt.load",
      outcome: "success",
    });

    expect(loadedHandler).toHaveBeenCalledOnce();
    const payload = loadedHandler.mock.calls[0]![0];
    expect(payload.source).toBe("unknown");
    expect(payload.bodyLength).toBe(0);
  });
});
