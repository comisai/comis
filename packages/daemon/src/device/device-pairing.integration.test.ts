/**
 * Device pairing integration tests.
 * Full device lifecycle tests using real file system (temp directory).
 * Tests identity generation, pairing flow, loopback auto-approval,
 * TTL expiry, rejection, revocation, and identity persistence.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  generateIdentity,
  loadOrCreateDeviceIdentity,
} from "./device-identity.js";
import { createDevicePairing, type DevicePairingDeps } from "./device-pairing.js";
import type { PairingRequest } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(os.tmpdir() + "/comis-pairing-integ-");
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
  vi.useRealTimers();
});

function makeRequest(overrides: Partial<PairingRequest> = {}): PairingRequest {
  const identity = generateIdentity();
  return {
    deviceId: identity.deviceId,
    publicKey: identity.publicKeyPem,
    displayName: "Test Device",
    platform: `${os.platform()}-${os.arch()}`,
    sourceIp: "192.168.1.100",
    requestedAtMs: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("device pairing integration", () => {
  it("completes full lifecycle: generate -> request -> approve -> verify paired", async () => {
    const stateDir = makeTmpDir();
    const pairing = createDevicePairing({ stateDir });

    // 1. Generate identity
    const identity = generateIdentity();

    // 2. Request pairing from non-loopback
    const req = makeRequest({
      deviceId: identity.deviceId,
      publicKey: identity.publicKeyPem,
      sourceIp: "10.0.0.5",
    });
    const requestResult = await pairing.requestPairing(req);
    expect(requestResult.ok).toBe(true);
    if (!requestResult.ok) return;
    expect(requestResult.value.autoApproved).toBe(false);

    // 3. List pending (should see the request)
    const pendingResult = await pairing.listPending();
    expect(pendingResult.ok).toBe(true);
    if (!pendingResult.ok) return;
    expect(pendingResult.value).toHaveLength(1);
    expect(pendingResult.value[0]!.deviceId).toBe(identity.deviceId);

    // 4. Approve
    const approveResult = await pairing.approvePairing(identity.deviceId);
    expect(approveResult.ok).toBe(true);

    // 5. List paired (should see device)
    const pairedResult = await pairing.listPaired();
    expect(pairedResult.ok).toBe(true);
    if (!pairedResult.ok) return;
    expect(pairedResult.value).toHaveLength(1);
    expect(pairedResult.value[0]!.deviceId).toBe(identity.deviceId);
    expect(pairedResult.value[0]!.role).toBe("node");
    expect(pairedResult.value[0]!.scopes).toEqual(["read", "write"]);

    // 6. Verify isPaired
    const isPairedResult = await pairing.isPaired(identity.deviceId);
    expect(isPairedResult.ok).toBe(true);
    if (!isPairedResult.ok) return;
    expect(isPairedResult.value).toBe(true);
  });

  it("auto-approves loopback IPv4 (127.0.0.1) with token", async () => {
    const stateDir = makeTmpDir();
    const pairing = createDevicePairing({ stateDir });

    const identity = generateIdentity();
    const req = makeRequest({
      deviceId: identity.deviceId,
      publicKey: identity.publicKeyPem,
      sourceIp: "127.0.0.1",
    });

    const result = await pairing.requestPairing(req);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.autoApproved).toBe(true);
    expect(result.value.token).toBeTruthy();
    expect(typeof result.value.token).toBe("string");

    // Verify device is in paired list
    const pairedResult = await pairing.listPaired();
    expect(pairedResult.ok).toBe(true);
    if (!pairedResult.ok) return;
    expect(pairedResult.value).toHaveLength(1);
    expect(pairedResult.value[0]!.deviceId).toBe(identity.deviceId);
  });

  it("auto-approves loopback IPv6 (::1) with token", async () => {
    const stateDir = makeTmpDir();
    const pairing = createDevicePairing({ stateDir });

    const identity = generateIdentity();
    const req = makeRequest({
      deviceId: identity.deviceId,
      publicKey: identity.publicKeyPem,
      sourceIp: "::1",
    });

    const result = await pairing.requestPairing(req);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.autoApproved).toBe(true);
    expect(result.value.token).toBeTruthy();

    // Verify in paired list
    const pairedResult = await pairing.listPaired();
    expect(pairedResult.ok).toBe(true);
    if (!pairedResult.ok) return;
    expect(pairedResult.value).toHaveLength(1);
  });

  it("filters expired requests (TTL expiry)", async () => {
    vi.useFakeTimers();

    const stateDir = makeTmpDir();
    const pairing = createDevicePairing({ stateDir, pendingTtlMs: 300_000 });

    const req = makeRequest({ sourceIp: "10.0.0.1" });
    const requestResult = await pairing.requestPairing(req);
    expect(requestResult.ok).toBe(true);

    // Advance time past 5 minutes
    vi.advanceTimersByTime(300_001);

    // List pending — expired request should be filtered out
    const pendingResult = await pairing.listPending();
    expect(pendingResult.ok).toBe(true);
    if (!pendingResult.ok) return;
    expect(pendingResult.value).toHaveLength(0);
  });

  it("rejects pending requests", async () => {
    const stateDir = makeTmpDir();
    const pairing = createDevicePairing({ stateDir });

    const identity = generateIdentity();
    const req = makeRequest({
      deviceId: identity.deviceId,
      publicKey: identity.publicKeyPem,
      sourceIp: "10.0.0.1",
    });

    await pairing.requestPairing(req);

    // Reject
    const rejectResult = await pairing.rejectPairing(identity.deviceId);
    expect(rejectResult.ok).toBe(true);

    // Verify no longer in pending
    const pendingResult = await pairing.listPending();
    expect(pendingResult.ok).toBe(true);
    if (!pendingResult.ok) return;
    expect(pendingResult.value).toHaveLength(0);

    // Verify not in paired
    const isPairedResult = await pairing.isPaired(identity.deviceId);
    expect(isPairedResult.ok).toBe(true);
    if (!isPairedResult.ok) return;
    expect(isPairedResult.value).toBe(false);
  });

  it("persists identity across loads", () => {
    const stateDir = makeTmpDir();

    // Create first identity
    const result1 = loadOrCreateDeviceIdentity(stateDir);
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    const firstId = result1.value.deviceId;

    // Load from same dir — should get same identity
    const result2 = loadOrCreateDeviceIdentity(stateDir);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.deviceId).toBe(firstId);
    expect(result2.value.publicKeyPem).toBe(result1.value.publicKeyPem);
    expect(result2.value.privateKeyPem).toBe(result1.value.privateKeyPem);
  });

  it("revokes paired devices", async () => {
    const stateDir = makeTmpDir();
    const pairing = createDevicePairing({ stateDir });

    // Pair a device via loopback
    const identity = generateIdentity();
    const req = makeRequest({
      deviceId: identity.deviceId,
      publicKey: identity.publicKeyPem,
      sourceIp: "127.0.0.1",
    });
    await pairing.requestPairing(req);

    // Verify paired
    const beforeResult = await pairing.isPaired(identity.deviceId);
    expect(beforeResult.ok).toBe(true);
    if (!beforeResult.ok) return;
    expect(beforeResult.value).toBe(true);

    // Revoke
    const revokeResult = await pairing.revokePairing(identity.deviceId);
    expect(revokeResult.ok).toBe(true);

    // Verify no longer paired
    const afterResult = await pairing.isPaired(identity.deviceId);
    expect(afterResult.ok).toBe(true);
    if (!afterResult.ok) return;
    expect(afterResult.value).toBe(false);
  });
});
