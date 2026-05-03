// SPDX-License-Identifier: Apache-2.0
/**
 * RED baseline (Phase 7 SPEC R2 + R5) — file-backed adapter tests for
 * `OAuthCredentialStorePort`.
 *
 * The source modules do not yet exist:
 *   - `./oauth-credential-store-file.js`        (plan 05)
 *   - `@comis/core` `OAuthProfile` re-export     (plan 03)
 *
 * The file is committed FAILING-TO-COMPILE on purpose. Plan 05 (file
 * adapter) and plan 03 (port + types) turn these tests green.
 *
 * Coverage groups:
 *   1. File creation + permissions (SPEC R2)
 *   2. Restart-survives-write (SPEC R2 acceptance)
 *   3. Profile-ID validation (SPEC R5)
 *   4. Schema-version hard-fail (D-07)
 *   5. CRUD operations
 *   6. Atomic-write durability
 *   7. Lock-file path sanitization (D-02)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Result } from "@comis/shared";
import type { OAuthProfile } from "@comis/core";
import { createOAuthCredentialStoreFile } from "./oauth-credential-store-file.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap a Result or fail the test with a useful message. */
function unwrap<T>(result: Result<T, Error>): T {
  if (!result.ok) {
    throw new Error(`Expected ok result, got error: ${result.error.message}`);
  }
  return result.value;
}

/** Build a baseline OAuthProfile for tests. Override fields as needed. */
function makeProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: "openai-codex",
    profileId: "openai-codex:user_a@example.com",
    access: "access-token-xyz",
    refresh: "refresh-token-abc",
    expires: Date.now() + 3600_000,
    version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------------

describe("createOAuthCredentialStoreFile", () => {
  let tmp: string;
  let authProfilesPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-fs-"));
    authProfilesPath = `${tmp}/auth-profiles.json`;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // Group 1 — File creation + permissions (SPEC R2)
  // -------------------------------------------------------------------------

  describe("file creation and permissions", () => {
    // Test 1.1
    it("first set() creates auth-profiles.json with mode 0o600", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      expect(fs.existsSync(authProfilesPath)).toBe(true);
      expect((fs.statSync(authProfilesPath).mode & 0o777) === 0o600).toBe(true);
    });

    // Test 1.2
    it("subsequent set() preserves mode 0o600 after rename", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      unwrap(
        await store.set(
          "openai-codex:user_a@example.com",
          makeProfile({ access: "rotated-access" }),
        ),
      );
      expect((fs.statSync(authProfilesPath).mode & 0o777) === 0o600).toBe(true);
    });

    // Test 1.3
    it("after set(), no leftover auth-profiles.json.tmp file", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      expect(fs.existsSync(`${authProfilesPath}.tmp`)).toBe(false);
    });

    // Test 1.4
    it("loading from a non-existent file returns ok(undefined)", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.get("openai-codex:user_a@example.com");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Group 2 — Restart-survives-write (SPEC R2 acceptance)
  // -------------------------------------------------------------------------

  describe("restart-survives-write", () => {
    // Test 2.1
    it("a new adapter instance reads what the previous instance wrote", async () => {
      const store1 = createOAuthCredentialStoreFile({ dataDir: tmp });
      const profile = makeProfile({
        profileId: "openai-codex:user_a@example.com",
        access: "persisted-access-xyz",
        refresh: "persisted-refresh-abc",
      });
      unwrap(await store1.set("openai-codex:user_a@example.com", profile));

      // Brand-new adapter — proves no in-process state leaks across instances.
      const store2 = createOAuthCredentialStoreFile({ dataDir: tmp });
      const loaded = unwrap(await store2.get("openai-codex:user_a@example.com"));
      expect(loaded).toEqual(profile);
    });
  });

  // -------------------------------------------------------------------------
  // Group 3 — Profile-ID validation (SPEC R5)
  // -------------------------------------------------------------------------

  describe("profile-ID validation", () => {
    // Test 3.1
    it("set() with a valid <provider>:<identity> profile-ID succeeds", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.set("openai-codex:user_a@example.com", makeProfile());
      expect(result.ok).toBe(true);
    });

    // Test 3.2
    it("set() with profile-ID lacking a colon returns err with 'Invalid profile ID'", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.set("openai-codex", makeProfile({ profileId: "openai-codex" }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Invalid profile ID");
    });

    // Test 3.3
    it("set() with empty provider returns err with 'Invalid profile ID'", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.set(
        ":user_a@example.com",
        makeProfile({ profileId: ":user_a@example.com" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Invalid profile ID");
    });

    // Test 3.4
    it("set() with empty identity returns err with 'Invalid profile ID'", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.set(
        "openai-codex:",
        makeProfile({ profileId: "openai-codex:" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Invalid profile ID");
    });

    // Test 3.5
    it("get() also rejects malformed profile-IDs", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.get("not-a-profile-id");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Invalid profile ID");
    });

    // Test 3.6 — env-bootstrap path is a valid identity
    it("set('openai-codex:env-bootstrap', profile) succeeds (RESEARCH §4 landmine #7)", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.set(
        "openai-codex:env-bootstrap",
        makeProfile({ profileId: "openai-codex:env-bootstrap" }),
      );
      expect(result.ok).toBe(true);
    });

    // Test 3.7 — table-driven rejection of unsafe identity payloads
    it.each([
      { name: "newline", id: "openai-codex:bad\nidentity" },
      { name: "null byte", id: "openai-codex:bad identity" },
      { name: "path traversal", id: "openai-codex:..\\..\\etc\\passwd" },
    ])("set() rejects unsafe profile-ID ($name)", async ({ id }) => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.set(id, makeProfile({ profileId: id }));
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Group 4 — Schema version hard-fail (D-07)
  // -------------------------------------------------------------------------

  describe("schema version hard-fail (D-07)", () => {
    // Test 4.1
    it("get() against a file with version: 99 returns err mentioning 'version' and 'Hint: Delete'", async () => {
      fs.writeFileSync(
        authProfilesPath,
        JSON.stringify({ version: 99, profiles: {} }),
        { mode: 0o600 },
      );
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.get("openai-codex:user_a@example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("version");
        expect(result.error.message).toContain("Hint: Delete");
      }
    });

    // Test 4.2
    it("get() against a file with version: 0 hard-fails the same way", async () => {
      fs.writeFileSync(
        authProfilesPath,
        JSON.stringify({ version: 0, profiles: {} }),
        { mode: 0o600 },
      );
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.get("openai-codex:user_a@example.com");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("version");
        expect(result.error.message).toContain("Hint: Delete");
      }
    });

    // Test 4.3
    it("missing file is NOT a version mismatch — first get() returns ok(undefined)", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const result = await store.get("openai-codex:user_a@example.com");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Group 5 — CRUD operations
  // -------------------------------------------------------------------------

  describe("CRUD operations", () => {
    // Test 5.1
    it("has() reflects set/delete state correctly", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const beforeSet = unwrap(await store.has("openai-codex:user_a@example.com"));
      expect(beforeSet).toBe(false);
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      const afterSet = unwrap(await store.has("openai-codex:user_a@example.com"));
      expect(afterSet).toBe(true);
    });

    // Test 5.2
    it("delete() returns ok(true) when present, ok(false) when not", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      const removed = unwrap(await store.delete("openai-codex:user_a@example.com"));
      expect(removed).toBe(true);
      const removedAgain = unwrap(await store.delete("openai-codex:user_a@example.com"));
      expect(removedAgain).toBe(false);
    });

    // Test 5.3
    it("list() returns all and list({ provider }) filters correctly", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      unwrap(
        await store.set(
          "anthropic:user_b@example.com",
          makeProfile({
            provider: "anthropic",
            profileId: "anthropic:user_b@example.com",
          }),
        ),
      );
      const all = unwrap(await store.list());
      expect(all).toHaveLength(2);
      const onlyCodex = unwrap(await store.list({ provider: "openai-codex" }));
      expect(onlyCodex).toHaveLength(1);
      expect(onlyCodex[0].provider).toBe("openai-codex");
    });

    // Test 5.4
    it("two profiles under the same provider both persist", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      unwrap(
        await store.set(
          "openai-codex:user_b@example.com",
          makeProfile({ profileId: "openai-codex:user_b@example.com" }),
        ),
      );
      const onlyCodex = unwrap(await store.list({ provider: "openai-codex" }));
      expect(onlyCodex).toHaveLength(2);
    });

    // Test 5.5
    it("set() with the same profile-ID overwrites (does not append)", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile({ access: "v1" })));
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile({ access: "v2" })));
      const all = unwrap(await store.list());
      expect(all).toHaveLength(1);
      expect(all[0].access).toBe("v2");
    });
  });

  // -------------------------------------------------------------------------
  // Group 6 — Atomic write durability
  // -------------------------------------------------------------------------

  describe("atomic write durability", () => {
    // Test 6.1
    it("after set(), the file content is valid JSON with version + profiles fields", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      const raw = fs.readFileSync(authProfilesPath, "utf8");
      const parsed = JSON.parse(raw) as { version: number; profiles: Record<string, unknown> };
      expect(parsed.version).toBe(1);
      expect(typeof parsed.profiles).toBe("object");
      expect(parsed.profiles["openai-codex:user_a@example.com"]).toBeDefined();
    });

    // Test 6.2
    it("after set(), no .tmp files remain in the dataDir", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      const tmpFiles = fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Group 7 — Lock-file path sanitization (D-02)
  // -------------------------------------------------------------------------

  describe("lock-file path sanitization (D-02)", () => {
    // Test 7.1 — sentinel exists at sanitized path
    it("after set(), sentinel exists at the sanitized lock path", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      const sentinel = `${tmp}/.locks/auth-profile__openai-codex__user_a_at_example.com.lock`;
      expect(fs.existsSync(sentinel)).toBe(true);
    });

    // Test 7.2 — different profile IDs use different lock paths (no serialization)
    it("two different profile-IDs concurrently both succeed", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const [r1, r2] = await Promise.all([
        store.set("openai-codex:user_a@example.com", makeProfile()),
        store.set(
          "openai-codex:user_b@example.com",
          makeProfile({ profileId: "openai-codex:user_b@example.com" }),
        ),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });

    // Test 7.3 — same profile-ID concurrent writes both complete; final is the second
    it("same profile-ID twice concurrently both complete; last write wins", async () => {
      const store = createOAuthCredentialStoreFile({ dataDir: tmp });
      const [r1, r2] = await Promise.all([
        store.set("openai-codex:user_a@example.com", makeProfile({ access: "first-write" })),
        store.set("openai-codex:user_a@example.com", makeProfile({ access: "second-write" })),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // Final state must equal one of the two writes (deterministic last-write-wins per
      // implementation). Plan 05 chooses the precise semantics; here we only assert
      // that both calls return ok and no torn state remains.
      const loaded = unwrap(await store.get("openai-codex:user_a@example.com"));
      expect(loaded).toBeDefined();
      expect(["first-write", "second-write"]).toContain(loaded!.access);
    });
  });
});
