import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";

import {
  fingerprintPublicKey,
  generateIdentity,
  loadOrCreateDeviceIdentity,
  createDeviceIdentityAdapter,
} from "./device-identity.js";

describe("device-identity", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(
      os.tmpdir() + "/comis-device-identity-test-",
    );
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  describe("fingerprintPublicKey", () => {
    it("produces consistent SHA-256 hex for same key", () => {
      const { publicKey } = crypto.generateKeyPairSync("ed25519");
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

      const fp1 = fingerprintPublicKey(pem);
      const fp2 = fingerprintPublicKey(pem);

      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex = 64 chars
    });
  });

  describe("generateIdentity", () => {
    it("produces valid Ed25519 keypair with deviceId", () => {
      const identity = generateIdentity();

      expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
      expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
      expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");

      // Verify deviceId matches public key fingerprint
      expect(fingerprintPublicKey(identity.publicKeyPem)).toBe(
        identity.deviceId,
      );
    });
  });

  describe("loadOrCreateDeviceIdentity", () => {
    it("creates new identity on first run", () => {
      const dir = makeTmpDir();
      const result = loadOrCreateDeviceIdentity(dir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.deviceId).toMatch(/^[a-f0-9]{64}$/);
      expect(result.value.publicKeyPem).toContain("BEGIN PUBLIC KEY");
      expect(result.value.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    });

    it("loads existing identity on second run (same deviceId)", () => {
      const dir = makeTmpDir();
      const first = loadOrCreateDeviceIdentity(dir);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = loadOrCreateDeviceIdentity(dir);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.value.deviceId).toBe(first.value.deviceId);
      expect(second.value.publicKeyPem).toBe(first.value.publicKeyPem);
      expect(second.value.privateKeyPem).toBe(first.value.privateKeyPem);
    });

    it("writes file with restricted permissions (0o600)", () => {
      const dir = makeTmpDir();
      const result = loadOrCreateDeviceIdentity(dir);
      expect(result.ok).toBe(true);

      const filePath = dir + "/identity/device.json";
      const stat = fs.statSync(filePath);
      // mode & 0o777 extracts user/group/other permission bits
      const permissions = stat.mode & 0o777;
      expect(permissions).toBe(0o600);
    });
  });

  describe("sign and verify", () => {
    it("round-trip succeeds", () => {
      const identity = generateIdentity();
      const adapter = createDeviceIdentityAdapter(identity);

      const data = Buffer.from("hello comis");
      const signature = adapter.sign(data);

      expect(
        adapter.verify(data, signature, identity.publicKeyPem),
      ).toBe(true);
    });

    it("rejects tampered data", () => {
      const identity = generateIdentity();
      const adapter = createDeviceIdentityAdapter(identity);

      const data = Buffer.from("hello comis");
      const signature = adapter.sign(data);

      const tampered = Buffer.from("TAMPERED comis");
      expect(
        adapter.verify(tampered, signature, identity.publicKeyPem),
      ).toBe(false);
    });

    it("rejects wrong public key", () => {
      const identity1 = generateIdentity();
      const identity2 = generateIdentity();
      const adapter1 = createDeviceIdentityAdapter(identity1);

      const data = Buffer.from("hello comis");
      const signature = adapter1.sign(data);

      // Verify with identity2's public key should fail
      expect(
        adapter1.verify(data, signature, identity2.publicKeyPem),
      ).toBe(false);
    });
  });
});
