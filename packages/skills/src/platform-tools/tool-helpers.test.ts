// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  jsonResult,
  imageResult,
  dualImageResult,
  readStringParam,
  readNumberParam,
  readBooleanParam,
  readEnumParam,
  createActionGate,
  throwToolError,
  createTrustGuard,
  meetsMinimumTrust,
  TRUST_HIERARCHY,
} from "./tool-helpers.js";
import { runWithContext } from "@comis/core";
import type { RequestContext } from "@comis/core";

// Mock @comis/core so safePath simply concatenates base + "/" + segments
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    safePath: (base: string, ...segments: string[]) => base + "/" + segments.join("/"),
  };
});

describe("jsonResult", () => {
  it("produces correct content array with pretty-printed JSON", () => {
    const data = { key: "value", count: 42 };
    const result = jsonResult(data);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      JSON.stringify(data, null, 2),
    );
    expect(result.details).toEqual(data);
  });

  it("handles arrays and nested objects", () => {
    const data = [{ a: 1 }, { b: [2, 3] }];
    const result = jsonResult(data);
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      JSON.stringify(data, null, 2),
    );
  });
});

describe("imageResult", () => {
  it("produces image content type with base64Data and mimeType", () => {
    const result = imageResult("aGVsbG8=", "image/png");

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("image");
    const imgContent = result.content[0] as { type: "image"; data: string; mimeType: string };
    expect(imgContent.data).toBe("aGVsbG8=");
    expect(imgContent.mimeType).toBe("image/png");
    expect(result.details).toEqual({ type: "image/png" });
  });
});

describe("readStringParam", () => {
  it("returns string value", () => {
    expect(readStringParam({ name: "test" }, "name")).toBe("test");
  });

  it("throws for missing required parameter", () => {
    expect(() => readStringParam({}, "name")).toThrow("Missing required parameter: name");
  });

  it("returns undefined for missing optional parameter", () => {
    expect(readStringParam({}, "name", false)).toBeUndefined();
  });

  it("throws for non-string value", () => {
    expect(() => readStringParam({ name: 42 }, "name")).toThrow(
      "Parameter name must be a string, got number",
    );
  });
});

describe("readNumberParam", () => {
  it("returns number value", () => {
    expect(readNumberParam({ count: 42 }, "count")).toBe(42);
  });

  it("throws for missing required parameter", () => {
    expect(() => readNumberParam({}, "count")).toThrow("Missing required parameter: count");
  });

  it("returns undefined for missing optional parameter", () => {
    expect(readNumberParam({}, "count", false)).toBeUndefined();
  });

  it("throws for non-number value", () => {
    expect(() => readNumberParam({ count: "42" }, "count")).toThrow(
      "Parameter count must be a number, got string",
    );
  });
});

describe("readBooleanParam", () => {
  it("returns boolean value", () => {
    expect(readBooleanParam({ flag: true }, "flag")).toBe(true);
    expect(readBooleanParam({ flag: false }, "flag")).toBe(false);
  });

  it("throws for missing required parameter", () => {
    expect(() => readBooleanParam({}, "flag")).toThrow("Missing required parameter: flag");
  });

  it("returns undefined for missing optional parameter", () => {
    expect(readBooleanParam({}, "flag", false)).toBeUndefined();
  });

  it("throws for non-boolean value", () => {
    expect(() => readBooleanParam({ flag: "yes" }, "flag")).toThrow(
      "Parameter flag must be a boolean, got string",
    );
  });
});

describe("createActionGate", () => {
  it("returns correct actionType and requiresConfirmation for read action", () => {
    const gate = createActionGate("file.read");
    const result = gate({});
    expect(result.actionType).toBe("file.read");
    expect(result.requiresConfirmation).toBe(false);
  });

  it("returns requiresConfirmation=true for destructive action", () => {
    const gate = createActionGate("file.delete");
    const result = gate({});
    expect(result.actionType).toBe("file.delete");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("returns requiresConfirmation=true for unknown action (fail-closed)", () => {
    const gate = createActionGate("unknown.action");
    const result = gate({});
    expect(result.requiresConfirmation).toBe(true);
  });

  it("returns requiresConfirmation=false for mutate action", () => {
    const gate = createActionGate("file.write");
    const result = gate({});
    expect(result.actionType).toBe("file.write");
    expect(result.requiresConfirmation).toBe(false);
  });

  it("returns requiresConfirmation=false when _confirmed is true for destructive action", () => {
    const gate = createActionGate("config.patch");
    const result = gate({ _confirmed: true });
    expect(result.actionType).toBe("config.patch");
    expect(result.requiresConfirmation).toBe(false);
  });

  it("still requires confirmation when _confirmed is false", () => {
    const gate = createActionGate("config.patch");
    const result = gate({ _confirmed: false });
    expect(result.actionType).toBe("config.patch");
    expect(result.requiresConfirmation).toBe(true);
  });
});

describe("dualImageResult", () => {
  it("returns text block first, image block second", () => {
    const result = dualImageResult("base64data", "image/jpeg", "screenshots/abc.jpg", "/workspace");
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("image");
  });

  it("text block contains relative and absolute paths", () => {
    const result = dualImageResult("base64data", "image/jpeg", "screenshots/abc.jpg", "/workspace");
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("screenshots/abc.jpg");
    expect(textBlock.text).toContain("Screenshot saved:");
    expect(textBlock.text).toContain("Full path:");
  });

  it("image block contains base64 data and mimeType", () => {
    const result = dualImageResult("base64data", "image/jpeg", "screenshots/abc.jpg", "/workspace");
    const imageBlock = result.content[1] as { type: string; data: string; mimeType: string };
    expect(imageBlock.data).toBe("base64data");
    expect(imageBlock.mimeType).toBe("image/jpeg");
  });

  it("details contains type, filePath, and relativePath", () => {
    const result = dualImageResult("base64data", "image/jpeg", "screenshots/abc.jpg", "/workspace");
    expect(result.details).toEqual(expect.objectContaining({
      type: "image/jpeg",
      relativePath: "screenshots/abc.jpg",
    }));
    expect(result.details.filePath).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Structured error infrastructure
// ---------------------------------------------------------------------------

describe("throwToolError", () => {
  it("throws Error with code prefix and message", () => {
    expect(() => throwToolError("invalid_action", "Unknown action type.")).toThrow(
      "[invalid_action] Unknown action type.",
    );
  });

  it("includes Valid values when validValues provided", () => {
    expect(() =>
      throwToolError("invalid_value", 'Invalid action: "foo".', {
        validValues: ["a", "b", "c"],
      }),
    ).toThrow('[invalid_value] Invalid action: "foo". Valid values: a, b, c.');
  });

  it("includes Hint when hint provided", () => {
    expect(() =>
      throwToolError("missing_param", "Missing action.", {
        hint: "Provide the action parameter",
      }),
    ).toThrow("[missing_param] Missing action. Hint: Provide the action parameter.");
  });

  it("includes both validValues and hint in full format", () => {
    expect(() =>
      throwToolError("invalid_value", 'Invalid mode: "fast".', {
        validValues: ["slow", "normal"],
        hint: "Use one of the listed values",
      }),
    ).toThrow(
      '[invalid_value] Invalid mode: "fast". Valid values: slow, normal. Hint: Use one of the listed values.',
    );
  });

  it("works with no options", () => {
    expect(() => throwToolError("conflict", "Resource already exists.")).toThrow(
      "[conflict] Resource already exists.",
    );
  });

  it("works with only hint (no validValues)", () => {
    expect(() =>
      throwToolError("not_found", "Agent not found.", {
        hint: "Check the agent ID",
      }),
    ).toThrow("[not_found] Agent not found. Hint: Check the agent ID.");
  });

  it("works with only validValues (no hint)", () => {
    expect(() =>
      throwToolError("invalid_value", 'Invalid level: "root".', {
        validValues: ["admin", "user", "guest"],
      }),
    ).toThrow('[invalid_value] Invalid level: "root". Valid values: admin, user, guest.');
  });

  it("produces correct prefix for all 6 error codes", () => {
    const codes = [
      "invalid_action",
      "invalid_value",
      "missing_param",
      "permission_denied",
      "not_found",
      "conflict",
    ] as const;

    for (const code of codes) {
      expect(() => throwToolError(code, "msg")).toThrow(`[${code}] msg`);
    }
  });

  it("throws an Error instance (not a plain string)", () => {
    try {
      throwToolError("conflict", "test");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("[conflict] test");
    }
  });
});

describe("readEnumParam", () => {
  it("returns valid value", () => {
    const result = readEnumParam({ action: "add" }, "action", ["add", "remove"]);
    expect(result).toBe("add");
  });

  it("returns valid value for last item in list", () => {
    const result = readEnumParam({ action: "remove" }, "action", ["add", "remove"]);
    expect(result).toBe("remove");
  });

  it("throws for invalid value with [invalid_value] prefix", () => {
    expect(() =>
      readEnumParam({ action: "delete" }, "action", ["add", "remove"]),
    ).toThrow("[invalid_value]");
  });

  it("error message includes the invalid value and all valid values", () => {
    expect(() =>
      readEnumParam({ action: "delete" }, "action", ["add", "remove", "list"]),
    ).toThrow(/Invalid action: "delete".*Valid values: add, remove, list/);
  });

  it("works with readonly arrays (as const usage)", () => {
    const VALID_ACTIONS = ["start", "stop", "restart"] as const;
    const result = readEnumParam({ action: "stop" }, "action", VALID_ACTIONS);
    expect(result).toBe("stop");
  });

  it("throws for missing param (delegates to readStringParam)", () => {
    expect(() =>
      readEnumParam({}, "action", ["add", "remove"]),
    ).toThrow("Missing required parameter: action");
  });

  it("throws for non-string param (delegates to readStringParam)", () => {
    expect(() =>
      readEnumParam({ action: 42 }, "action", ["add", "remove"]),
    ).toThrow("Parameter action must be a string");
  });
});

// ---------------------------------------------------------------------------
// Trust guard helpers (migrated to throwToolError)
// ---------------------------------------------------------------------------

function makeContext(trustLevel: "admin" | "user" | "guest"): RequestContext {
  return {
    tenantId: "default",
    userId: "test-user",
    sessionKey: "test-session",
    traceId: crypto.randomUUID(),
    startedAt: Date.now(),
    trustLevel,
  };
}

describe("TRUST_HIERARCHY", () => {
  it("defines guest < user < admin ordering", () => {
    expect(TRUST_HIERARCHY).toEqual(["guest", "user", "admin"]);
  });
});

describe("meetsMinimumTrust", () => {
  it("admin meets admin requirement", () => {
    expect(meetsMinimumTrust("admin", "admin")).toBe(true);
  });

  it("admin meets user requirement", () => {
    expect(meetsMinimumTrust("admin", "user")).toBe(true);
  });

  it("admin meets guest requirement", () => {
    expect(meetsMinimumTrust("admin", "guest")).toBe(true);
  });

  it("user meets user requirement", () => {
    expect(meetsMinimumTrust("user", "user")).toBe(true);
  });

  it("user meets guest requirement", () => {
    expect(meetsMinimumTrust("user", "guest")).toBe(true);
  });

  it("user does NOT meet admin requirement", () => {
    expect(meetsMinimumTrust("user", "admin")).toBe(false);
  });

  it("guest meets guest requirement", () => {
    expect(meetsMinimumTrust("guest", "guest")).toBe(true);
  });

  it("guest does NOT meet user requirement", () => {
    expect(meetsMinimumTrust("guest", "user")).toBe(false);
  });

  it("guest does NOT meet admin requirement", () => {
    expect(meetsMinimumTrust("guest", "admin")).toBe(false);
  });
});

describe("createTrustGuard", () => {
  it("does not throw (returns void) for admin trust when minimum is admin", () => {
    const guard = createTrustGuard("agents_manage", "admin");
    expect(() => runWithContext(makeContext("admin"), () => guard())).not.toThrow();
  });

  it("throws [permission_denied] for user trust when minimum is admin", () => {
    const guard = createTrustGuard("agents_manage", "admin");
    expect(() => runWithContext(makeContext("user"), () => guard())).toThrow(
      "[permission_denied]",
    );
  });

  it("error message includes tool name and trust level info", () => {
    const guard = createTrustGuard("agents_manage", "admin");
    expect(() => runWithContext(makeContext("user"), () => guard())).toThrow(
      /Insufficient trust level for agents_manage.*requires admin.*current level is user/,
    );
  });

  it("throws for guest trust when minimum is admin", () => {
    const guard = createTrustGuard("tokens_manage", "admin");
    expect(() => runWithContext(makeContext("guest"), () => guard())).toThrow(
      "[permission_denied]",
    );
  });

  it("does not throw for user trust when minimum is user", () => {
    const guard = createTrustGuard("obs_query", "user");
    expect(() => runWithContext(makeContext("user"), () => guard())).not.toThrow();
  });

  it("throws when called outside request context (no context = guest)", () => {
    const guard = createTrustGuard("agents_manage", "admin");
    // Call outside runWithContext -- tryGetContext returns undefined, defaults to guest
    expect(() => guard()).toThrow("[permission_denied]");
    expect(() => guard()).toThrow(/current level is guest/);
  });

  it("defaults minimum trust to admin when not specified", () => {
    const guard = createTrustGuard("agents_manage");
    expect(() => runWithContext(makeContext("user"), () => guard())).toThrow(
      "[permission_denied]",
    );
  });

  it("throws Error instance (not returning errorResult)", () => {
    const guard = createTrustGuard("agents_manage", "admin");
    try {
      runWithContext(makeContext("guest"), () => guard());
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain("[permission_denied]");
    }
  });

  it("includes hint about admin trust requirement", () => {
    const guard = createTrustGuard("agents_manage", "admin");
    expect(() => runWithContext(makeContext("guest"), () => guard())).toThrow(
      /Hint: This tool requires admin trust level\./,
    );
  });
});
