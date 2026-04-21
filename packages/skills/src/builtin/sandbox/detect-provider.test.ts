// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// -- Mocks --

const mockBwrapAvailable = vi.fn();
const mockSbexecAvailable = vi.fn();

vi.mock("./bwrap-provider.js", () => {
  return {
    BwrapProvider: class {
      readonly name = "bwrap";
      available() {
        return mockBwrapAvailable();
      }
    },
  };
});

vi.mock("./sandbox-exec-provider.js", () => {
  return {
    SandboxExecProvider: class {
      readonly name = "sandbox-exec";
      available() {
        return mockSbexecAvailable();
      }
    },
  };
});

import { detectSandboxProvider, type DetectLogger } from "./detect-provider.js";

let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

function createMockLogger(): DetectLogger & { calls: Array<{ obj: Record<string, unknown>; msg: string }> } {
  const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    calls,
    warn(obj: Record<string, unknown>, msg: string) {
      calls.push({ obj, msg });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

describe("detectSandboxProvider", () => {
  it("returns BwrapProvider on linux when bwrap is available", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(true);

    const result = detectSandboxProvider();

    expect(result).toBeDefined();
    expect(result!.name).toBe("bwrap");
  });

  it("returns undefined on linux when bwrap is NOT available, logs WARN with hint", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(false);
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.msg).toContain("bwrap not found");
    expect(logger.calls[0]!.obj.hint).toContain("bubblewrap");
  });

  it("returns SandboxExecProvider on darwin when sandbox-exec is available", () => {
    setPlatform("darwin");
    mockSbexecAvailable.mockReturnValue(true);

    const result = detectSandboxProvider();

    expect(result).toBeDefined();
    expect(result!.name).toBe("sandbox-exec");
  });

  it("returns undefined on darwin when sandbox-exec is NOT available, logs WARN", () => {
    setPlatform("darwin");
    mockSbexecAvailable.mockReturnValue(false);
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.msg).toContain("sandbox-exec not found");
  });

  it('returns undefined on unsupported platform (e.g., "win32"), logs WARN with platform name', () => {
    setPlatform("win32");
    const logger = createMockLogger();

    const result = detectSandboxProvider(logger);

    expect(result).toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.msg).toContain("Unsupported platform");
    expect(logger.calls[0]!.obj.hint).toContain("win32");
  });

  it("works correctly when no logger is provided (no crash on undefined logger)", () => {
    setPlatform("freebsd");

    // Should not throw
    const result = detectSandboxProvider();

    expect(result).toBeUndefined();
  });

  it("logger receives correct hint and errorKind fields", () => {
    setPlatform("linux");
    mockBwrapAvailable.mockReturnValue(false);
    const logger = createMockLogger();

    detectSandboxProvider(logger);

    expect(logger.calls[0]!.obj.errorKind).toBe("config");
    expect(typeof logger.calls[0]!.obj.hint).toBe("string");
  });
});
