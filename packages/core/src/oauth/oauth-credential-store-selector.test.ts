// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for selectOAuthCredentialStore.
 *
 * Coverage:
 *   1. storage="file" with default factory returns a port (no `encryptedStore` required).
 *   2. storage="file" with injected factory invokes the factory with the right config.
 *   3. storage="encrypted" with an injected encryptedStore returns that store verbatim.
 *   4. storage="encrypted" without an encryptedStore throws with the operator hint.
 */

import { describe, it, expect, vi } from "vitest";
import { ok } from "@comis/shared";
import type { OAuthCredentialStorePort } from "../ports/oauth-credential-store.js";
import type { FileLockPort } from "../ports/file-lock.js";
import { selectOAuthCredentialStore } from "./oauth-credential-store-selector.js";

function makeStubFileLock(): FileLockPort {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    withLock: vi.fn(),
    isLocked: vi.fn(),
    cleanupStaleLocks: vi.fn(),
  } as unknown as FileLockPort;
}

function makeStubStore(): OAuthCredentialStorePort {
  return {
    get: vi.fn(async () => ok(undefined)),
    set: vi.fn(async () => ok(undefined)),
    delete: vi.fn(async () => ok(false)),
    list: vi.fn(async () => ok([])),
    has: vi.fn(async () => ok(false)),
  };
}

describe("selectOAuthCredentialStore", () => {
  it("storage='file' with default factory returns a port", () => {
    const fileLock = makeStubFileLock();
    const store = selectOAuthCredentialStore({
      storage: "file",
      dataDir: "/tmp/comis-test-selector",
      fileLock,
    });
    // The real createOAuthCredentialStoreFile returns a frozen port — assert
    // the surface, not the identity.
    expect(typeof store.get).toBe("function");
    expect(typeof store.set).toBe("function");
    expect(typeof store.delete).toBe("function");
    expect(typeof store.list).toBe("function");
    expect(typeof store.has).toBe("function");
  });

  it("storage='file' with injected factory invokes the factory with dataDir + fileLock", () => {
    const fileLock = makeStubFileLock();
    const stub = makeStubStore();
    const factory = vi.fn(() => stub);
    const result = selectOAuthCredentialStore({
      storage: "file",
      dataDir: "/tmp/comis-test-selector",
      fileLock,
      factories: { file: factory },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      dataDir: "/tmp/comis-test-selector",
      fileLock,
    });
    expect(result).toBe(stub);
  });

  it("storage='encrypted' with injected encryptedStore returns it verbatim", () => {
    const fileLock = makeStubFileLock();
    const stub = makeStubStore();
    const result = selectOAuthCredentialStore({
      storage: "encrypted",
      dataDir: "/tmp/comis-test-selector",
      fileLock,
      encryptedStore: stub,
    });
    expect(result).toBe(stub);
  });

  it("storage='encrypted' without encryptedStore throws with operator hint", () => {
    const fileLock = makeStubFileLock();
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-selector",
        fileLock,
      }),
    ).toThrow(/encrypted/i);
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-selector",
        fileLock,
      }),
    ).toThrow(/setup-agents/);
  });

  // env branch — must throw actionable error (env is read-only; no writable store)
  it("storage='env' throws with actionable error mentioning 'env' and 'read-only' or 'login'", () => {
    const fileLock = makeStubFileLock();
    expect(() =>
      selectOAuthCredentialStore({
        storage: "env",
        dataDir: "/tmp/comis-test-selector",
        fileLock,
      }),
    ).toThrow(/env/i);
    // Error must be actionable — must mention either "read-only" or "login"
    expect(() =>
      selectOAuthCredentialStore({
        storage: "env",
        dataDir: "/tmp/comis-test-selector",
        fileLock,
      }),
    ).toThrow(/read-only|login/i);
  });
});
