// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import type { PairingRequest } from "@comis/core";
import { createDevicePairing } from "./device-pairing.js";

function makeRequest(overrides: Partial<PairingRequest> = {}): PairingRequest {
  return {
    deviceId: overrides.deviceId ?? "abc123",
    publicKey: overrides.publicKey ?? "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
    displayName: overrides.displayName ?? "Test Device",
    platform: overrides.platform ?? "linux",
    sourceIp: overrides.sourceIp ?? "192.168.1.100",
    requestedAtMs: overrides.requestedAtMs ?? Date.now(),
  };
}

describe("device-pairing", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(os.tmpdir() + "/comis-device-pairing-test-");
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  describe("requestPairing", () => {
    it("auto-approves loopback (127.0.0.1) and returns token", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      const result = await pairing.requestPairing(
        makeRequest({ sourceIp: "127.0.0.1" }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.autoApproved).toBe(true);
      expect(result.value.token).toBeDefined();
      expect(result.value.token!.length).toBe(64); // 32 bytes hex
    });

    it("auto-approves loopback (::1) and returns token", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      const result = await pairing.requestPairing(
        makeRequest({ sourceIp: "::1" }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.autoApproved).toBe(true);
      expect(result.value.token).toBeDefined();
    });

    it("enters pending queue for non-loopback", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      const result = await pairing.requestPairing(
        makeRequest({ sourceIp: "10.0.0.5" }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.autoApproved).toBe(false);
      expect(result.value.token).toBeUndefined();
    });

    it("returns error for already-paired device", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      // First: auto-approve via loopback
      await pairing.requestPairing(
        makeRequest({ deviceId: "dev1", sourceIp: "127.0.0.1" }),
      );

      // Second: attempt to re-pair
      const result = await pairing.requestPairing(
        makeRequest({ deviceId: "dev1", sourceIp: "127.0.0.1" }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("already paired");
    });
  });

  describe("approvePairing", () => {
    it("moves device from pending to paired with token", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      await pairing.requestPairing(
        makeRequest({ deviceId: "dev2", sourceIp: "10.0.0.5" }),
      );

      const result = await pairing.approvePairing("dev2");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.deviceId).toBe("dev2");
      expect(result.value.role).toBe("node");
      expect(result.value.scopes).toEqual(["read", "write"]);
      expect(result.value.tokens?.default?.token).toBeDefined();

      // Should no longer be pending
      const pending = await pairing.listPending();
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value).toHaveLength(0);

      // Should be paired
      const isPaired = await pairing.isPaired("dev2");
      expect(isPaired.ok).toBe(true);
      if (!isPaired.ok) return;
      expect(isPaired.value).toBe(true);
    });

    it("accepts custom role and scopes", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      await pairing.requestPairing(
        makeRequest({ deviceId: "dev3", sourceIp: "10.0.0.5" }),
      );

      const result = await pairing.approvePairing("dev3", {
        role: "admin",
        scopes: ["read", "write", "admin"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.role).toBe("admin");
      expect(result.value.scopes).toEqual(["read", "write", "admin"]);
    });
  });

  describe("rejectPairing", () => {
    it("removes device from pending", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      await pairing.requestPairing(
        makeRequest({ deviceId: "dev4", sourceIp: "10.0.0.5" }),
      );

      const result = await pairing.rejectPairing("dev4");
      expect(result.ok).toBe(true);

      // No longer pending
      const pending = await pairing.listPending();
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value).toHaveLength(0);
    });

    it("returns error for unknown device", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      const result = await pairing.rejectPairing("nonexistent");
      expect(result.ok).toBe(false);
    });
  });

  describe("listPending", () => {
    it("filters out expired entries", async () => {
      vi.useFakeTimers();
      const dir = makeTmpDir();
      const ttlMs = 300_000; // 5 minutes
      const pairing = createDevicePairing({ stateDir: dir, pendingTtlMs: ttlMs });

      // Add a request at current time
      await pairing.requestPairing(
        makeRequest({ deviceId: "dev5", sourceIp: "10.0.0.5" }),
      );

      // Advance time past TTL
      vi.advanceTimersByTime(ttlMs + 1);

      const pending = await pairing.listPending();
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value).toHaveLength(0);
    });
  });

  describe("revokePairing", () => {
    it("removes device from paired", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      // Auto-approve via loopback
      await pairing.requestPairing(
        makeRequest({ deviceId: "dev6", sourceIp: "127.0.0.1" }),
      );

      const result = await pairing.revokePairing("dev6");
      expect(result.ok).toBe(true);

      const isPaired = await pairing.isPaired("dev6");
      expect(isPaired.ok).toBe(true);
      if (!isPaired.ok) return;
      expect(isPaired.value).toBe(false);
    });

    it("returns error for non-paired device", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      const result = await pairing.revokePairing("nonexistent");
      expect(result.ok).toBe(false);
    });
  });

  describe("concurrency", () => {
    it("serializes concurrent requestPairing calls (no corrupt state)", async () => {
      const dir = makeTmpDir();
      const pairing = createDevicePairing({ stateDir: dir });

      // Fire 10 concurrent requests for different devices
      const promises = Array.from({ length: 10 }, (_, i) =>
        pairing.requestPairing(
          makeRequest({
            deviceId: `concurrent-${i}`,
            sourceIp: "10.0.0.5",
            requestedAtMs: Date.now(),
          }),
        ),
      );

      const results = await Promise.all(promises);

      // All should succeed
      for (const result of results) {
        expect(result.ok).toBe(true);
      }

      // All should be in pending
      const pending = await pairing.listPending();
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value).toHaveLength(10);

      // Verify unique device IDs
      const deviceIds = new Set(pending.value.map((p) => p.deviceId));
      expect(deviceIds.size).toBe(10);
    });
  });

  describe("persistence", () => {
    it("survives re-creation from same state directory", async () => {
      const dir = makeTmpDir();
      const pairing1 = createDevicePairing({ stateDir: dir });

      // Auto-approve a device
      await pairing1.requestPairing(
        makeRequest({ deviceId: "persist-test", sourceIp: "127.0.0.1" }),
      );

      // Create new pairing instance from same directory
      const pairing2 = createDevicePairing({ stateDir: dir });

      const isPaired = await pairing2.isPaired("persist-test");
      expect(isPaired.ok).toBe(true);
      if (!isPaired.ok) return;
      expect(isPaired.value).toBe(true);
    });
  });
});
