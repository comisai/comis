// SPDX-License-Identifier: Apache-2.0
/**
 * Device Pairing — request queue, approval flow, and file-backed state.
 * Loopback connections (127.0.0.1 and ::1) are auto-approved without manual intervention.
 * Non-loopback requests enter a pending queue with a configurable TTL (default 5 minutes).
 * Concurrent mutations are serialized via a promise-based mutex.
 * State is persisted to JSON files with atomic writes and 0o600 permissions.
 * @module
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

import { ok, err, tryCatch } from "@comis/shared";
import type { Result } from "@comis/shared";
import { safePath } from "@comis/core";
import type { PairingRequest, PairedDevice } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DevicePairingDeps {
  readonly stateDir: string;
  readonly pendingTtlMs?: number; // Default: 300_000 (5 minutes)
  readonly isLoopback?: (ip: string) => boolean;
}

export interface DevicePairing {
  requestPairing(
    req: PairingRequest,
  ): Promise<Result<{ autoApproved: boolean; token?: string }, Error>>;
  approvePairing(
    deviceId: string,
    opts?: { role?: string; scopes?: string[] },
  ): Promise<Result<PairedDevice, Error>>;
  rejectPairing(deviceId: string): Promise<Result<void, Error>>;
  listPending(): Promise<Result<PairingRequest[], Error>>;
  listPaired(): Promise<Result<PairedDevice[], Error>>;
  revokePairing(deviceId: string): Promise<Result<void, Error>>;
  isPaired(deviceId: string): Promise<Result<boolean, Error>>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PENDING_TTL_MS = 300_000; // 5 minutes

function defaultIsLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1";
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function resolveDevicesDir(stateDir: string): Result<string, Error> {
  return tryCatch(() => safePath(stateDir, "devices"));
}

function readJsonFile<T>(filePath: string, fallback: T): Result<T, Error> {
  const readResult = tryCatch(() => fs.readFileSync(filePath, "utf-8"));
  if (!readResult.ok) return ok(fallback); // file doesn't exist yet
  return tryCatch(() => JSON.parse(readResult.value) as T);
}

function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
): Result<void, Error> {
  const tmpPath =
    filePath + `.tmp.${crypto.randomBytes(4).toString("hex")}`;
  const result = tryCatch(() => {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, json, "utf-8");
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  });

  if (!result.ok) {
    tryCatch(() => fs.unlinkSync(tmpPath));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDevicePairing(deps: DevicePairingDeps): DevicePairing {
  const ttlMs = deps.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const isLoopback = deps.isLoopback ?? defaultIsLoopback;

  // Promise-based mutex for serializing state mutations
  let lockChain = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = lockChain.then(fn, fn);
    lockChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  // Resolve file paths once
  const dirResult = resolveDevicesDir(deps.stateDir);
  if (!dirResult.ok) {
    // Return a pairing object that always errors if dir resolution fails
    const error = dirResult.error;
    const errResult = <T>(): Promise<Result<T, Error>> =>
      Promise.resolve(err(error));
    return {
      requestPairing: errResult,
      approvePairing: errResult,
      rejectPairing: errResult,
      listPending: errResult,
      listPaired: errResult,
      revokePairing: errResult,
      isPaired: errResult,
    };
  }

  const devicesDir = dirResult.value;
  const pendingPathResult = tryCatch(() =>
    safePath(devicesDir, "pending.json"),
  );
  const pairedPathResult = tryCatch(() =>
    safePath(devicesDir, "paired.json"),
  );

  if (!pendingPathResult.ok || !pairedPathResult.ok) {
    const error = !pendingPathResult.ok
      ? pendingPathResult.error
      : (pairedPathResult as { ok: false; error: Error }).error;
    const errResult = <T>(): Promise<Result<T, Error>> =>
      Promise.resolve(err(error));
    return {
      requestPairing: errResult,
      approvePairing: errResult,
      rejectPairing: errResult,
      listPending: errResult,
      listPaired: errResult,
      revokePairing: errResult,
      isPaired: errResult,
    };
  }

  const pendingPath = pendingPathResult.value;
  const pairedPath = pairedPathResult.value;

  // Ensure devices directory exists
  tryCatch(() => fs.mkdirSync(devicesDir, { recursive: true }));

  // -- Internal state helpers ------------------------------------------------

  function loadPending(): PairingRequest[] {
    const result = readJsonFile<PairingRequest[]>(pendingPath, []);
    return result.ok ? result.value : [];
  }

  function loadPaired(): PairedDevice[] {
    const result = readJsonFile<PairedDevice[]>(pairedPath, []);
    return result.ok ? result.value : [];
  }

  function savePending(items: PairingRequest[]): Result<void, Error> {
    return writeJsonFileAtomic(pendingPath, items);
  }

  function savePaired(items: PairedDevice[]): Result<void, Error> {
    return writeJsonFileAtomic(pairedPath, items);
  }

  function filterExpired(items: PairingRequest[]): PairingRequest[] {
    const now = Date.now();
    return items.filter((r) => r.requestedAtMs + ttlMs > now);
  }

  function generateToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  function createPairedDevice(
    req: PairingRequest,
    opts?: { role?: string; scopes?: string[] },
  ): PairedDevice {
    const now = Date.now();
    const token = generateToken();
    return {
      deviceId: req.deviceId,
      publicKey: req.publicKey,
      displayName: req.displayName,
      platform: req.platform,
      role: opts?.role ?? "node",
      scopes: opts?.scopes ?? ["read", "write"],
      tokens: {
        default: { token, createdAtMs: now },
      },
      createdAtMs: now,
      approvedAtMs: now,
    };
  }

  // -- Public interface ------------------------------------------------------

  return {
    requestPairing(req) {
      return withLock(async () => {
        // Check if already paired
        const paired = loadPaired();
        if (paired.some((d) => d.deviceId === req.deviceId)) {
          return err(
            new Error(`Device ${req.deviceId} is already paired`),
          );
        }

        if (isLoopback(req.sourceIp)) {
          // Auto-approve loopback connections
          const device = createPairedDevice(req);
          const token =
            device.tokens?.default?.token ?? generateToken();
          paired.push(device);
          const saveResult = savePaired(paired);
          if (!saveResult.ok) return saveResult;
          return ok({ autoApproved: true, token });
        }

        // Add to pending queue
        let pending = loadPending();
        pending = filterExpired(pending);
        // Replace existing pending request for same device
        pending = pending.filter((p) => p.deviceId !== req.deviceId);
        pending.push(req);
        const saveResult = savePending(pending);
        if (!saveResult.ok) return saveResult;
        return ok({ autoApproved: false });
      });
    },

    approvePairing(deviceId, opts?) {
      return withLock(async () => {
        let pending = loadPending();
        pending = filterExpired(pending);

        const idx = pending.findIndex((p) => p.deviceId === deviceId);
        if (idx === -1) {
          return err(
            new Error(
              `No pending pairing request for device ${deviceId}`,
            ),
          );
        }

        const req = pending[idx]!;
        pending.splice(idx, 1);

        const device = createPairedDevice(req, opts);
        const paired = loadPaired();
        paired.push(device);

        const savePendingResult = savePending(pending);
        if (!savePendingResult.ok) return savePendingResult;

        const savePairedResult = savePaired(paired);
        if (!savePairedResult.ok) return savePairedResult;

        return ok(device);
      });
    },

    rejectPairing(deviceId) {
      return withLock(async () => {
        let pending = loadPending();
        const before = pending.length;
        pending = pending.filter((p) => p.deviceId !== deviceId);
        if (pending.length === before) {
          return err(
            new Error(
              `No pending pairing request for device ${deviceId}`,
            ),
          );
        }
        const saveResult = savePending(pending);
        if (!saveResult.ok) return saveResult;
        return ok(undefined);
      });
    },

    listPending() {
      return withLock(async () => {
        let pending = loadPending();
        pending = filterExpired(pending);
        // Save cleaned list (removes expired)
        const saveResult = savePending(pending);
        if (!saveResult.ok) return saveResult;
        return ok(pending);
      });
    },

    listPaired() {
      return withLock(async () => {
        return ok(loadPaired());
      });
    },

    revokePairing(deviceId) {
      return withLock(async () => {
        const paired = loadPaired();
        const before = paired.length;
        const filtered = paired.filter((d) => d.deviceId !== deviceId);
        if (filtered.length === before) {
          return err(
            new Error(`Device ${deviceId} is not paired`),
          );
        }
        const saveResult = savePaired(filtered);
        if (!saveResult.ok) return saveResult;
        return ok(undefined);
      });
    },

    isPaired(deviceId) {
      return withLock(async () => {
        const paired = loadPaired();
        return ok(paired.some((d) => d.deviceId === deviceId));
      });
    },
  };
}
