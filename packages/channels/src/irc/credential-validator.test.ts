// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateIrcConnection } from "./credential-validator.js";

// Mock irc-framework Client
const mockConnect = vi.fn();
const mockQuit = vi.fn();
const mockUser = { nick: "testbot" };
const mockNetwork = { name: "Libera.Chat" };
const eventHandlers = new Map<string, (...args: unknown[]) => void>();

vi.mock("irc-framework", () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: mockConnect,
      quit: mockQuit,
      user: mockUser,
      network: mockNetwork,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        eventHandlers.set(event, handler);
      }),
    };
  }),
}));

describe("validateIrcConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    mockUser.nick = "testbot";
    mockNetwork.name = "Libera.Chat";
  });

  it("returns IrcBotInfo on successful registration", async () => {
    mockConnect.mockImplementation(() => {
      // Simulate server registering the client
      const handler = eventHandlers.get("registered");
      if (handler) handler();
    });

    const result = await validateIrcConnection({
      host: "irc.libera.chat",
      nick: "testbot",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.host).toBe("irc.libera.chat");
      expect(result.value.nick).toBe("testbot");
      expect(result.value.serverName).toBe("Libera.Chat");
    }
    expect(mockQuit).toHaveBeenCalledWith("validation complete");
  });

  it("uses TLS port 6697 by default", async () => {
    mockConnect.mockImplementation(() => {
      const handler = eventHandlers.get("registered");
      if (handler) handler();
    });

    await validateIrcConnection({
      host: "irc.libera.chat",
      nick: "testbot",
    });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "irc.libera.chat",
        port: 6697,
        nick: "testbot",
        tls: true,
        auto_reconnect: false,
        auto_reconnect_max_retries: 0,
      }),
    );
  });

  it("uses non-TLS port 6667 when tls=false", async () => {
    mockConnect.mockImplementation(() => {
      const handler = eventHandlers.get("registered");
      if (handler) handler();
    });

    await validateIrcConnection({
      host: "irc.libera.chat",
      nick: "testbot",
      tls: false,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 6667,
        tls: false,
      }),
    );
  });

  it("returns error on connection error event", async () => {
    mockConnect.mockImplementation(() => {
      const handler = eventHandlers.get("error");
      if (handler) handler({ message: "Connection refused" });
    });

    const result = await validateIrcConnection({
      host: "bad-server.example",
      nick: "testbot",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Connection refused");
    }
  });

  it("returns error when connection closes before registration", async () => {
    mockConnect.mockImplementation(() => {
      const handler = eventHandlers.get("close");
      if (handler) handler();
    });

    const result = await validateIrcConnection({
      host: "irc.example.com",
      nick: "testbot",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("closed before registration");
    }
  });

  it("uses custom port when specified", async () => {
    mockConnect.mockImplementation(() => {
      const handler = eventHandlers.get("registered");
      if (handler) handler();
    });

    await validateIrcConnection({
      host: "irc.example.com",
      port: 7000,
      nick: "testbot",
      tls: true,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ port: 7000 }),
    );
  });

  it("falls back to host as serverName when network.name is empty", async () => {
    mockNetwork.name = "";
    mockConnect.mockImplementation(() => {
      const handler = eventHandlers.get("registered");
      if (handler) handler();
    });

    const result = await validateIrcConnection({
      host: "irc.fallback.net",
      nick: "testbot",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serverName).toBe("irc.fallback.net");
    }
  });
});
