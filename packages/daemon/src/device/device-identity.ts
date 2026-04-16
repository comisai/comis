/**
 * Device Identity — Ed25519 keypair generation, file persistence, and signing.
 * Produces a stable device identity that persists across process restarts.
 * DeviceId is the SHA-256 fingerprint of the public key raw bytes (DER/SPKI).
 * Private key files are written with mode 0o600 for security.
 * @module
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

import { ok, tryCatch } from "@comis/shared";
import type { Result } from "@comis/shared";
import { safePath } from "@comis/core";
import type { DeviceIdentity, DeviceIdentityPort } from "@comis/core";

/**
 * Compute the SHA-256 fingerprint of an Ed25519 public key.
 * Exports the key as DER (SPKI), hashes the raw bytes, returns hex string.
 */
export function fingerprintPublicKey(publicKeyPem: string): string {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const derBytes = keyObject.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(derBytes).digest("hex");
}

/**
 * Generate a new Ed25519 identity (keypair + deviceId).
 */
export function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

/**
 * Load an existing device identity from disk, or create and persist a new one.
 * Identity is stored at `<stateDir>/identity/device.json`.
 * Private key file is written with mode 0o600.
 * Uses atomic write (temp file + rename) for crash safety.
 */
export function loadOrCreateDeviceIdentity(
  stateDir: string,
): Result<DeviceIdentity, Error> {
  const dirResult = tryCatch(() => safePath(stateDir, "identity"));
  if (!dirResult.ok) return dirResult;
  const identityDir = dirResult.value;

  const fileResult = tryCatch(() => safePath(identityDir, "device.json"));
  if (!fileResult.ok) return fileResult;
  const filePath = fileResult.value;

  // Try loading existing identity
  const readResult = tryCatch(() => fs.readFileSync(filePath, "utf-8"));
  if (readResult.ok) {
    const parseResult = tryCatch(() =>
      JSON.parse(readResult.value) as DeviceIdentity,
    );
    if (!parseResult.ok) return parseResult;
    return ok(parseResult.value);
  }

  // Generate new identity
  const identity = generateIdentity();

  // Create directory (recursive)
  const mkdirResult = tryCatch(() =>
    fs.mkdirSync(identityDir, { recursive: true }),
  );
  if (!mkdirResult.ok) return mkdirResult;

  // Atomic write: temp file -> chmod -> rename
  const tmpPath = filePath + `.tmp.${crypto.randomBytes(4).toString("hex")}`;
  const writeResult = tryCatch(() => {
    const json = JSON.stringify(identity, null, 2);
    fs.writeFileSync(tmpPath, json, "utf-8");
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  });

  if (!writeResult.ok) {
    // Clean up temp file on failure
    tryCatch(() => fs.unlinkSync(tmpPath));
    return writeResult;
  }

  return ok(identity);
}

/**
 * Factory: create a DeviceIdentityPort adapter from an existing identity.
 */
export function createDeviceIdentityAdapter(
  identity: DeviceIdentity,
): DeviceIdentityPort {
  return {
    identity,

    sign(data: Buffer): Buffer {
      const privateKey = crypto.createPrivateKey(identity.privateKeyPem);
      return Buffer.from(crypto.sign(null, data, privateKey));
    },

    verify(data: Buffer, signature: Buffer, publicKeyPem: string): boolean {
      const publicKey = crypto.createPublicKey(publicKeyPem);
      return crypto.verify(null, data, publicKey, signature);
    },
  };
}
