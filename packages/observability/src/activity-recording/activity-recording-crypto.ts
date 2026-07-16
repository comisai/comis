// SPDX-License-Identifier: Apache-2.0
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { err, tryCatch, type Result } from "@comis/shared";

import type {
  ActivityRecordingCiphertext,
  ActivityRecordingCryptoContext,
  ActivityRecordingCryptoPort,
} from "@comis/core";

const ACTIVITY_HKDF_INFO = "comis-activity-recording-aead-v1";
const ACTIVITY_ROOT_HKDF_INFO = "comis-activity-recording-root-v1";
const ACTIVITY_ROOT_HKDF_SALT = "comis-activity-recording-root-salt-v1";

/** Derive the recorder-only root key before it crosses the worker boundary. */
export function deriveActivityRecordingMasterKey(rootKey: Buffer): Result<Buffer, Error> {
  if (!Buffer.isBuffer(rootKey) || rootKey.length < 32) {
    return err(new Error("Activity recording root key must be at least 32 bytes"));
  }
  return tryCatch(() => Buffer.from(hkdfSync(
    "sha256",
    rootKey.subarray(0, 32),
    ACTIVITY_ROOT_HKDF_SALT,
    ACTIVITY_ROOT_HKDF_INFO,
    32,
  )));
}

function contextAad(context: ActivityRecordingCryptoContext): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "comis-activity-recording-aad",
    schemaVersion: 1,
    streamId: context.streamId,
    instanceId: context.instanceId,
    purpose: context.purpose,
  }), "utf8");
}

function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, salt, ACTIVITY_HKDF_INFO, 32));
}

/**
 * Dedicated activity-evidence AEAD. Its HKDF domain is disjoint from generic
 * secret encryption, while GCM AAD binds every blob to one stream, recorder
 * instance, and purpose.
 */
export function createActivityRecordingCrypto(masterKeyInput: Buffer): ActivityRecordingCryptoPort {
  const validKey = Buffer.isBuffer(masterKeyInput) && masterKeyInput.length >= 32;
  const masterKey = validKey ? Buffer.from(masterKeyInput.subarray(0, 32)) : Buffer.alloc(0);
  return {
    seal(
      context: ActivityRecordingCryptoContext,
      plaintext: Buffer,
    ): Result<ActivityRecordingCiphertext, Error> {
      if (!validKey) return err(new Error("Activity recording master key must be at least 32 bytes"));
      return tryCatch(() => {
        const salt = randomBytes(32);
        const iv = randomBytes(12);
        const key = deriveKey(masterKey, salt);
        try {
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          cipher.setAAD(contextAad(context));
          const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
          return { ciphertext, iv, authTag: cipher.getAuthTag(), salt };
        } finally {
          key.fill(0);
        }
      });
    },

    open(
      context: ActivityRecordingCryptoContext,
      encrypted: ActivityRecordingCiphertext,
    ): Result<Buffer, Error> {
      if (!validKey) return err(new Error("Activity recording master key must be at least 32 bytes"));
      return tryCatch(() => {
        const key = deriveKey(masterKey, encrypted.salt);
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
          decipher.setAAD(contextAad(context));
          decipher.setAuthTag(encrypted.authTag);
          return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
        } finally {
          key.fill(0);
        }
      });
    },
  };
}
