// SPDX-License-Identifier: Apache-2.0
/**
 * Device Identity Port — hexagonal boundary for cryptographic device identity.
 *
 * A device generates a stable Ed25519 keypair that persists across restarts.
 * The DeviceId is the SHA-256 fingerprint of the public key raw bytes (DER/SPKI).
 *
 * Stable device identity with Ed25519 keypair.
 * Pairing request/approval types.
 * Paired device with role and scopes.
 *
 * @module
 */

/** Persistent Ed25519 identity for this daemon instance. */
export interface DeviceIdentity {
  readonly deviceId: string; // SHA-256 fingerprint of public key raw bytes
  readonly publicKeyPem: string; // Ed25519 PEM (SPKI)
  readonly privateKeyPem: string; // Ed25519 PEM (PKCS8)
}

/** A pending pairing request from a remote device. */
export interface PairingRequest {
  readonly deviceId: string;
  readonly publicKey: string;
  readonly displayName?: string;
  readonly platform?: string;
  readonly sourceIp: string;
  readonly requestedAtMs: number;
}

/** A device that has been approved and persisted to paired state. */
export interface PairedDevice {
  readonly deviceId: string;
  readonly publicKey: string;
  readonly displayName?: string;
  readonly platform?: string;
  readonly role?: string;
  readonly roles?: string[];
  readonly scopes?: string[];
  readonly tokens?: Record<
    string,
    { token: string; createdAtMs: number; expiresAtMs?: number }
  >;
  readonly createdAtMs: number;
  readonly approvedAtMs: number;
}

/** Port interface for device identity operations (sign/verify). */
export interface DeviceIdentityPort {
  readonly identity: DeviceIdentity;
  sign(data: Buffer): Buffer;
  verify(data: Buffer, signature: Buffer, publicKeyPem: string): boolean;
}
