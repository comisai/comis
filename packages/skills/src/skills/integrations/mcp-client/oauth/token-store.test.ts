// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the OAuth 3-file token store.
 *
 * Coverage:
 *   1. saveTokens + tokens round-trip; on-disk <server>.json carries ABSOLUTE
 *      expiresAt (= pinned-now + expires_in*1000) and NO expiresIn/expires_in.
 *   2. Absolute-expiry TYPE guard: the stored schema has no relative field
 *      (`expectTypeOf<TokenFile>().not.toHaveProperty("expiresIn")`). The
 *      load-bearing compile-time guard lives in token-store.ts itself
 *      (`*.test.ts` is excluded from `tsc`); this runtime structural check is
 *      the documentation/regression mirror.
 *   3. File mode: <server>.json mode & 0o777 === 0o600; the mcp-tokens dir
 *      mode & 0o777 === 0o700 (fstat/stat-verified).
 *   4. client info + discovery files round-trip (<server>.client.json /
 *      <server>.meta.json), both 0o600.
 *   5. deleteAll removes all three files; subsequent reads return undefined.
 *   6. External-edit invalidation: an external rewrite of <server>.json
 *      (bypassing the store) is picked up on the next read after the debounce
 *      flush; a truncated/partial write keeps the last-good cache and never
 *      crashes (fail-soft).
 *   7. No raw fs writes: token-store.ts source contains no
 *      fs.openSync/fs.writeFileSync/renameSync (all writes route through the
 *      @comis/observability substrate; no rename → no EXDEV).
 *
 * All filesystem state lives in an mkdtemp tmpdir. Watcher events are emitted
 * through a local harness so unit-test correctness does not depend on
 * operating-system event delivery. `now` is injected so expiry math is
 * deterministic.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenStore, type TokenFile, type TokenStore } from "./token-store.js";

const watcherControl = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  interface FakeWatcher {
    on(event: string, handler: Handler): FakeWatcher;
    once(event: string, handler: Handler): FakeWatcher;
    close(): Promise<void>;
  }

  let handlers = new Map<string, Handler[]>();

  function removeHandler(event: string, handler: Handler): void {
    const remaining = (handlers.get(event) ?? []).filter((candidate) => candidate !== handler);
    handlers.set(event, remaining);
  }

  function emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
  }

  function create(): FakeWatcher {
    handlers = new Map<string, Handler[]>();
    const watcher: FakeWatcher = {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return watcher;
      },
      once(event, handler) {
        const onceHandler: Handler = (...args) => {
          removeHandler(event, onceHandler);
          handler(...args);
        };
        handlers.set(event, [...(handlers.get(event) ?? []), onceHandler]);
        return watcher;
      },
      async close() {
        handlers.clear();
      },
    };
    queueMicrotask(() => emit("ready"));
    return watcher;
  }

  return { create, emit };
});

vi.mock("chokidar", () => ({
  watch: vi.fn(() => watcherControl.create()),
}));

const PINNED_NOW = 1_700_000_000_000; // fixed epoch ms for deterministic expiry

/** Minimal silent logger satisfying the store's logger contract. */
function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Poll `predicate` until it returns truthy or the attempt budget is exhausted.
 *
 * Replaces a fixed sleep while the store's 100ms debounce runs. Each iteration
 * drives a store read, which triggers the lazy re-read after the watcher clears
 * the cache.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { attempts = 200, intervalMs = 25 }: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe("createTokenStore", () => {
  let dir: string;
  let store: TokenStore;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-token-store-"));
    logger = makeLogger();
    store = createTokenStore({
      tokensDir: dir,
      confinedBaseDir: dir,
      now: () => PINNED_NOW,
      logger,
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips tokens and persists ABSOLUTE expiresAt (no relative field)", async () => {
    await store.saveTokens("notion", {
      access_token: "AT",
      refresh_token: "RT",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "read write",
    });

    const got = await store.tokens("notion");
    expect(got).toBeDefined();
    expect(got?.access_token).toBe("AT");
    expect(got?.refresh_token).toBe("RT");
    // The store reconstructs the SDK-shaped expires_in from the absolute value.
    expect(got?.expires_in).toBe(3600);

    // On-disk file: absolute expiresAt, and NO relative key anywhere.
    const raw = JSON.parse(readFileSync(join(dir, "notion.json"), "utf8")) as Record<string, unknown>;
    expect(raw["expiresAt"]).toBe(PINNED_NOW + 3600 * 1000);
    expect(raw).not.toHaveProperty("expiresIn");
    expect(raw).not.toHaveProperty("expires_in");
    expect(raw["accessToken"]).toBe("AT");
    expect(raw["refreshToken"]).toBe("RT");
  });

  it("computes a stored absolute value even when expires_in is absent (sentinel TTL)", async () => {
    await store.saveTokens("svc", {
      access_token: "AT2",
      token_type: "Bearer",
    });
    const raw = JSON.parse(readFileSync(join(dir, "svc.json"), "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("expires_in");
    expect(raw).not.toHaveProperty("expiresIn");
    expect(typeof raw["expiresAt"]).toBe("number");
    expect(raw["expiresAt"] as number).toBeGreaterThan(PINNED_NOW);
  });

  it("TYPE: the stored TokenFile schema has no expiresIn/expires_in field (compile-time guard mirror)", () => {
    // Runtime structural mirror of the compile-time `never` guard in
    // token-store.ts. `*.test.ts` is excluded from `tsc`, so this assertion
    // documents intent at the test layer; the build-time guard is in source.
    expectTypeOf<TokenFile>().not.toHaveProperty("expiresIn");
    expectTypeOf<TokenFile>().not.toHaveProperty("expires_in");
    expectTypeOf<TokenFile>().toHaveProperty("expiresAt").toEqualTypeOf<number>();
  });

  it("writes <server>.json at 0o600 and the tokens dir at 0o700 (fstat-verified)", async () => {
    await store.saveTokens("notion", {
      access_token: "AT",
      expires_in: 60,
      token_type: "Bearer",
    });
    const fileMode = statSync(join(dir, "notion.json")).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = statSync(dir).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("round-trips client information to <server>.client.json at 0o600", async () => {
    await store.saveClientInformation("notion", {
      client_id: "cid-123",
      client_secret: "shh",
      redirect_uris: ["http://127.0.0.1:8765/callback"],
    });
    const got = await store.clientInformation("notion");
    expect(got?.client_id).toBe("cid-123");
    expect(got?.client_secret).toBe("shh");
    const mode = statSync(join(dir, "notion.client.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips discovery state to <server>.meta.json at 0o600", async () => {
    await store.saveDiscoveryState("notion", {
      authorizationServerUrl: "https://auth.example.com",
      resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource",
    });
    const got = await store.discoveryState("notion");
    expect(got?.authorizationServerUrl).toBe("https://auth.example.com");
    expect(got?.resourceMetadataUrl).toBe(
      "https://api.example.com/.well-known/oauth-protected-resource",
    );
    const mode = statSync(join(dir, "notion.meta.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("deleteAll removes all three files; subsequent reads return undefined (logout)", async () => {
    await store.saveTokens("notion", { access_token: "AT", expires_in: 60, token_type: "Bearer" });
    await store.saveClientInformation("notion", {
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:9/callback"],
    });
    await store.saveDiscoveryState("notion", { authorizationServerUrl: "https://a" });

    await store.deleteAll("notion");

    expect(existsSync(join(dir, "notion.json"))).toBe(false);
    expect(existsSync(join(dir, "notion.client.json"))).toBe(false);
    expect(existsSync(join(dir, "notion.meta.json"))).toBe(false);
    expect(await store.tokens("notion")).toBeUndefined();
    expect(await store.clientInformation("notion")).toBeUndefined();
    expect(await store.discoveryState("notion")).toBeUndefined();
  });

  it("returns undefined for a server with no files on disk", async () => {
    expect(await store.tokens("ghost")).toBeUndefined();
    expect(await store.clientInformation("ghost")).toBeUndefined();
    expect(await store.discoveryState("ghost")).toBeUndefined();
  });

  it("invalidates its cache on an EXTERNAL rewrite of <server>.json", async () => {
    // Write the baseline BEFORE the watcher starts so it is part of the initial
    // scan, then await the watcher `ready` so the external write below is
    // cleanly observed as a `change` (not coalesced into the initial scan).
    await store.saveTokens("notion", {
      access_token: "AT",
      refresh_token: "RT",
      expires_in: 3600,
      token_type: "Bearer",
    });
    await store.startWatch();
    // Prime the in-memory cache.
    const first = await store.tokens("notion");
    expect(first?.access_token).toBe("AT");

    // External rewrite, bypassing the store entirely (a cron/sibling refresh).
    const external: TokenFile = {
      accessToken: "AT-EXTERNAL",
      refreshToken: "RT2",
      expiresAt: PINNED_NOW + 7200 * 1000,
      tokenType: "Bearer",
    };
    writeFileSync(join(dir, "notion.json"), JSON.stringify(external), { mode: 0o600 });
    watcherControl.emit("change", join(dir, "notion.json"));

    // Poll until the debounced cache-invalidation lands and the next read
    // re-reads the external value. The watcher event itself is explicit: this
    // unit test verifies the store's event contract without relying on an
    // operating-system watcher delivering events under suite contention.
    const invalidated = await waitFor(
      async () => (await store.tokens("notion"))?.access_token === "AT-EXTERNAL",
    );
    expect(invalidated).toBe(true);

    const second = await store.tokens("notion");
    expect(second?.access_token).toBe("AT-EXTERNAL");
    expect(second?.refresh_token).toBe("RT2");
  }, 10_000);

  it("keeps the last-good cache and logs WARN on a truncated/partial external write (fail-soft)", async () => {
    await store.saveTokens("notion", {
      access_token: "AT-GOOD",
      expires_in: 3600,
      token_type: "Bearer",
    });
    await store.startWatch();
    const primed = await store.tokens("notion");
    expect(primed?.access_token).toBe("AT-GOOD");

    // Ignore any construction-time warns; only the fail-soft re-read counts.
    logger.warn.mockClear();

    // Write a truncated (invalid JSON) file directly.
    writeFileSync(join(dir, "notion.json"), '{"accessToken":"AT-', { mode: 0o600 });
    watcherControl.emit("change", join(dir, "notion.json"));

    // The WARN only fires when a read re-parses the file AFTER the watcher
    // clears the cache, so poll BY reading until the fail-soft path logs.
    const warned = await waitFor(async () => {
      await store.tokens("notion");
      return logger.warn.mock.calls.length > 0;
    });
    expect(warned).toBe(true);

    // Fail-soft: parse error must NOT throw; the last-good cache is served.
    const after = await store.tokens("notion");
    expect(after?.access_token).toBe("AT-GOOD");
    expect(logger.warn).toHaveBeenCalled();
  }, 10_000);

  it("close() tears down the watcher (no leaked timers/handles)", async () => {
    await store.startWatch();
    await store.saveTokens("notion", { access_token: "AT", expires_in: 60, token_type: "Bearer" });
    await expect(store.close()).resolves.toBeUndefined();
    // Idempotent.
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("ARCH: token-store.ts contains no raw fs.openSync/fs.writeFileSync/renameSync", () => {
    const srcPath = fileURLToPath(new URL("./token-store.ts", import.meta.url));
    const src = readFileSync(srcPath, "utf8");
    // Strip line comments and block comments so the doc-prose that legitimately
    // names these primitives (explaining why we do NOT call them) is not flagged.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/fs\.openSync/);
    expect(code).not.toMatch(/fs\.writeFileSync/);
    expect(code).not.toMatch(/\brenameSync\b/);
    expect(code).not.toMatch(/\bwriteFileSync\b/);
  });
});
