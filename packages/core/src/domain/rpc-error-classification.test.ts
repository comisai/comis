// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyTypedRpcError } from "./rpc-error-classification.js";

// OBS-RPC-REFUSAL-CLASS (orchestration-excellence-20260701): the SINGLE source of truth
// both the daemon rpc-dispatch classifier and the @comis/gateway method-router classifier
// delegate to. Keyed off the stable Error.name (the LCD signal — the gateway can't
// instanceof the daemon/@comis/agent error classes). These tests pin the shared verdicts
// so the two layers can never drift again.
describe("classifyTypedRpcError", () => {
  // Simulate each typed refusal by its observable `.name` (what BOTH layers see at
  // runtime — the gateway never has the class, only the propagated Error).
  const named = (name: string, message = "x"): Error => {
    const e = new Error(message);
    e.name = name;
    return e;
  };

  it("classifies PreconditionError as precondition/warn", () => {
    const c = classifyTypedRpcError(named("PreconditionError"));
    expect(c).not.toBeNull();
    expect(c!.errorKind).toBe("precondition");
    expect(c!.level).toBe("warn");
    expect(c!.hint).toBeTruthy();
  });

  it("classifies SandboxDowngradeError as precondition/warn and names the sandboxNoDowngrade knob", () => {
    const c = classifyTypedRpcError(named("SandboxDowngradeError"));
    expect(c!.errorKind).toBe("precondition");
    expect(c!.level).toBe("warn");
    expect(c!.hint).toMatch(/sandboxNoDowngrade/);
  });

  it("classifies ValidationError and RequiredToolsUnreachableError as validation/warn", () => {
    expect(classifyTypedRpcError(named("ValidationError"))!.errorKind).toBe("validation");
    expect(classifyTypedRpcError(named("RequiredToolsUnreachableError"))!.errorKind).toBe("validation");
    expect(classifyTypedRpcError(named("ValidationError"))!.level).toBe("warn");
  });

  it("classifies AuthorizationError as auth/warn", () => {
    const c = classifyTypedRpcError(named("AuthorizationError"));
    expect(c!.errorKind).toBe("auth");
    expect(c!.level).toBe("warn");
  });

  it("returns null for an unrecognized error name (caller applies its own fallback → internal/error)", () => {
    expect(classifyTypedRpcError(named("Error"))).toBeNull();
    expect(classifyTypedRpcError(named("TypeError"))).toBeNull();
    expect(classifyTypedRpcError(new Error("generic explosion"))).toBeNull();
  });

  it("returns null for a non-Error thrown value", () => {
    expect(classifyTypedRpcError("string error")).toBeNull();
    expect(classifyTypedRpcError(undefined)).toBeNull();
    expect(classifyTypedRpcError({ name: "PreconditionError" })).toBeNull(); // not an Error instance
  });
});
