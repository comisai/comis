// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for SYNTHETIC_ERROR_KIND_MAP and resolveErrorKind helper.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  SYNTHETIC_ERROR_KIND_MAP,
  resolveErrorKind,
} from "./error-kind-map.js";

describe("SYNTHETIC_ERROR_KIND_MAP", () => {
  it("uses the activity recording gap payload error kind", () => {
    expect(resolveErrorKind("activity-recording:gap", { errorKind: "auth" })).toBe("auth");
  });

  it("security:injection_detected → internal", () => {
    expect(SYNTHETIC_ERROR_KIND_MAP["security:injection_detected"]).toBe("internal");
  });

  it("maps security:memory_tainted to internal", () => {
    expect(SYNTHETIC_ERROR_KIND_MAP["security:memory_tainted"]).toBe("internal");
  });

  it("execution:aborted → internal", () => {
    expect(SYNTHETIC_ERROR_KIND_MAP["execution:aborted"]).toBe("internal");
  });

  it("execution:prompt_timeout → timeout", () => {
    expect(SYNTHETIC_ERROR_KIND_MAP["execution:prompt_timeout"]).toBe("timeout");
  });

  it("mcp:server:reconnect_failed → dependency", () => {
    expect(SYNTHETIC_ERROR_KIND_MAP["mcp:server:reconnect_failed"]).toBe("dependency");
  });
});

describe("resolveErrorKind", () => {
  it("typed payload wins: auth:refresh_failed with errorKind:network returns network", () => {
    const result = resolveErrorKind(
      "auth:refresh_failed",
      { errorKind: "network" } as never,
    );
    expect(result).toBe("network");
  });

  it("optional+missing returns null: tool:executed with no errorKind", () => {
    const result = resolveErrorKind(
      "tool:executed",
      {} as never,
    );
    expect(result).toBeNull();
  });

  it("synthetic mapping: security:injection_detected returns internal", () => {
    const result = resolveErrorKind(
      "security:injection_detected",
      {} as never,
    );
    expect(result).toBe("internal");
  });

  it("unsubscribed event returns null", () => {
    const result = resolveErrorKind(
      "notification:enqueued" as never,
      {} as never,
    );
    expect(result).toBeNull();
  });
});
