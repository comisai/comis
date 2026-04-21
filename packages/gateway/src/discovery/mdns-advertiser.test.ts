// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @homebridge/ciao before importing the module under test
const mockService = {
  advertise: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
};

const mockResponder = {
  createService: vi.fn(() => mockService),
  shutdown: vi.fn(async () => {}),
};

vi.mock("@homebridge/ciao", () => ({
  default: {
    getResponder: () => mockResponder,
  },
}));

import {
  createMdnsAdvertiser,
  type MdnsAdvertiserDeps,
} from "./mdns-advertiser.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

describe("createMdnsAdvertiser", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let deps: MdnsAdvertiserDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    deps = { port: 4766, logger };
  });

  it("creates service with correct name, type, port, and TXT records", () => {
    createMdnsAdvertiser(deps);

    expect(mockResponder.createService).toHaveBeenCalledWith({
      name: "Comis Gateway",
      type: "http",
      port: 4766,
      txt: {
        version: "0.0.1",
        path: "/v1",
        openai_compat: "true",
        acp: "stdio",
      },
    });
  });

  it("creates service with custom name and version", () => {
    createMdnsAdvertiser({
      port: 9000,
      name: "Custom Gateway",
      version: "1.2.3",
      logger,
    });

    expect(mockResponder.createService).toHaveBeenCalledWith({
      name: "Custom Gateway",
      type: "http",
      port: 9000,
      txt: {
        version: "1.2.3",
        path: "/v1",
        openai_compat: "true",
        acp: "stdio",
      },
    });
  });

  it("advertise() calls service.advertise() and sets isAdvertising to true", async () => {
    const handle = createMdnsAdvertiser(deps);

    expect(handle.isAdvertising()).toBe(false);
    await handle.advertise();

    expect(mockService.advertise).toHaveBeenCalledOnce();
    expect(handle.isAdvertising()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith({
      name: "Comis Gateway",
      port: 4766,
      version: "0.0.1",
    }, "mDNS service advertised");
  });

  it("stop() calls service.end() then responder.shutdown() and sets isAdvertising to false", async () => {
    const handle = createMdnsAdvertiser(deps);
    await handle.advertise();

    await handle.stop();

    expect(mockService.end).toHaveBeenCalledOnce();
    expect(mockResponder.shutdown).toHaveBeenCalledOnce();
    expect(handle.isAdvertising()).toBe(false);
    expect(logger.info).toHaveBeenCalledWith({
      name: "Comis Gateway",
    }, "mDNS service stopped");
  });

  it("stop() when not advertising is a no-op", async () => {
    const handle = createMdnsAdvertiser(deps);

    await handle.stop();

    expect(mockService.end).not.toHaveBeenCalled();
    expect(mockResponder.shutdown).not.toHaveBeenCalled();
    expect(handle.isAdvertising()).toBe(false);
  });

  it("stop() with error in service.end() logs error but does not throw", async () => {
    const handle = createMdnsAdvertiser(deps);
    await handle.advertise();

    const error = new Error("end failed");
    mockService.end.mockRejectedValueOnce(error);

    // Should not throw
    await expect(handle.stop()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      { err: error, hint: "mDNS shutdown is best-effort; the service may already be stopped", errorKind: "network" },
      "Failed to stop mDNS service cleanly",
    );
    expect(handle.isAdvertising()).toBe(false);
  });
});
