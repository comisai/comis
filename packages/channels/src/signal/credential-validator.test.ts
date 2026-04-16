import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockHealthCheck = vi.fn();
const mockRpcRequest = vi.fn();

vi.mock("./signal-client.js", () => ({
  signalHealthCheck: (...args: unknown[]) => mockHealthCheck(...args),
  signalRpcRequest: (...args: unknown[]) => mockRpcRequest(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { validateSignalConnection } from "./credential-validator.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateSignalConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns err when health check fails", async () => {
    mockHealthCheck.mockResolvedValue(err(new Error("Connection refused")));

    const result = await validateSignalConnection({ baseUrl: "http://signal:8080" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Connection refused");
    }
  });

  it("returns ok with unknown phoneNumber when no account specified", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));

    const result = await validateSignalConnection({ baseUrl: "http://signal:8080" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        phoneNumber: "unknown",
        registered: true,
      });
    }
  });

  it("returns err when listAccounts fails", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));
    mockRpcRequest.mockResolvedValue(err(new Error("RPC error")));

    const result = await validateSignalConnection({
      baseUrl: "http://signal:8080",
      account: "+1234567890",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to list Signal accounts");
    }
  });

  it("returns ok with account found by number field", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));
    mockRpcRequest.mockResolvedValue(
      ok([{ number: "+1234567890", uuid: "abc-123" }]),
    );

    const result = await validateSignalConnection({
      baseUrl: "http://signal:8080",
      account: "+1234567890",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        phoneNumber: "+1234567890",
        uuid: "abc-123",
        registered: true,
      });
    }
  });

  it("returns ok with account found by uuid field", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));
    mockRpcRequest.mockResolvedValue(
      ok([{ number: "+9999999999", uuid: "target-uuid" }]),
    );

    const result = await validateSignalConnection({
      baseUrl: "http://signal:8080",
      account: "target-uuid",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registered).toBe(true);
      expect(result.value.uuid).toBe("target-uuid");
    }
  });

  it("returns ok with account found by phoneNumber field variant", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));
    mockRpcRequest.mockResolvedValue(
      ok([{ phoneNumber: "+5551234567" }]),
    );

    const result = await validateSignalConnection({
      baseUrl: "http://signal:8080",
      account: "+5551234567",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phoneNumber).toBe("+5551234567");
      expect(result.value.registered).toBe(true);
    }
  });

  it("returns ok with account found by account field variant", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));
    mockRpcRequest.mockResolvedValue(
      ok([{ account: "+7771234567" }]),
    );

    const result = await validateSignalConnection({
      baseUrl: "http://signal:8080",
      account: "+7771234567",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phoneNumber).toBe("+7771234567");
      expect(result.value.registered).toBe(true);
    }
  });

  it("returns ok with registered=false when account not found", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));
    mockRpcRequest.mockResolvedValue(
      ok([{ number: "+0000000000", uuid: "other-uuid" }]),
    );

    const result = await validateSignalConnection({
      baseUrl: "http://signal:8080",
      account: "+9999999999",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        phoneNumber: "+9999999999",
        registered: false,
      });
    }
  });

  it("passes baseUrl to signalHealthCheck", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));

    await validateSignalConnection({ baseUrl: "http://custom:9090" });

    expect(mockHealthCheck).toHaveBeenCalledWith("http://custom:9090");
  });

  it("passes baseUrl to signalRpcRequest for listAccounts", async () => {
    mockHealthCheck.mockResolvedValue(ok(true));
    mockRpcRequest.mockResolvedValue(ok([]));

    await validateSignalConnection({
      baseUrl: "http://signal:8080",
      account: "+1234567890",
    });

    expect(mockRpcRequest).toHaveBeenCalledWith(
      "listAccounts",
      undefined,
      { baseUrl: "http://signal:8080" },
    );
  });
});
