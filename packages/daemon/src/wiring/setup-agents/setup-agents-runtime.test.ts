// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the setup-agents runtime leaf hosting `setupSingleAgent` —
 * inspects its source body for skillRegistry + OutputGuard + canary token
 * + OAuth wiring + safePath discipline.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupSingleAgent } from "./setup-agents-runtime.js";
// selectOAuthCredentialStore's consuming call-site lives in
// setup-agents-runtime.ts (and setup-agents-registry.ts), so its tests stay
// co-located with the runtime leaf.
import {
  selectOAuthCredentialStore,
  type OAuthCredentialStorePort,
} from "@comis/core";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readRuntimeSource(): string {
  return readFileSync(join(__dirname, "setup-agents-runtime.ts"), "utf-8");
}

describe("setup-agents-runtime wiring", () => {
  it("passes skillRegistry to createPiExecutor deps (regression guard)", () => {
    const source = readRuntimeSource();

    // Verify skillRegistry is created
    expect(source).toContain("const skillRegistry = createSkillRegistry(");

    // Verify skillRegistry is passed in the createPiExecutor deps object.
    // The deps object spans from "createPiExecutor(effectiveConfig, {" to the closing "});"
    // skillRegistry must appear inside that span.
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    expect(depsStart).toBeGreaterThan(-1);
    expect(depsEnd).toBeGreaterThan(depsStart);

    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("skillRegistry");
  });
});

describe("setupSingleAgent OutputGuard wiring", () => {
  it("passes outputGuard and canaryToken to createPiExecutor deps (OGUARD regression guard)", () => {
    const source = readRuntimeSource();

    // Verify OutputGuard and canary token are created before the deps block
    expect(source).toContain("createOutputGuard()");
    expect(source).toContain("generateCanaryToken");

    // Verify both are passed inside the createPiExecutor deps object (not just anywhere in file)
    const depsStart = source.indexOf("createPiExecutor(effectiveConfig, {");
    const depsEnd = source.indexOf("});", depsStart);
    expect(depsStart).toBeGreaterThan(-1);
    expect(depsEnd).toBeGreaterThan(depsStart);

    const depsBlock = source.slice(depsStart, depsEnd);
    expect(depsBlock).toContain("outputGuard");
    expect(depsBlock).toContain("canaryToken");
  });

  it("includes canary fallback derivation", () => {
    const source = readRuntimeSource();
    // Post-split the helper lives in setup-agents-tooling.ts; setup-agents-runtime.ts
    // imports it from that leaf and references it (and CANARY_SECRET) here.
    expect(source).toContain("deriveCanaryFallback");
    expect(source).toContain("CANARY_SECRET");
  });
});

describe("setup-agents-runtime skills directory creation", () => {
  it("creates agent skills directory before skill registry init (SKILL-DIR regression guard)", () => {
    const source = readRuntimeSource();

    // agentSkillsDir must be created before createSkillRegistry is called
    const mkdirPos = source.indexOf("mkdirSync(agentSkillsDir");
    const registryPos = source.indexOf("const skillRegistry = createSkillRegistry(");
    expect(mkdirPos).toBeGreaterThan(-1);
    expect(registryPos).toBeGreaterThan(mkdirPos);
  });
});

// ---------------------------------------------------------------------------
// OAuth credential store wiring
// ---------------------------------------------------------------------------

describe("setupSingleAgent OAuth wiring", () => {
  const source = readRuntimeSource();

  it("invokes createAuthProvider({ oauth: ... }) — closes the unwired-OAuth gap", () => {
    // createAuthProvider was previously exported by @comis/agent but never
    // called by the daemon, so refreshed OAuth tokens lived only in the
    // in-memory cache and silently disappeared on restart. The daemon-side
    // call closes that gap.
    expect(source).toContain("createAuthProvider({");
    expect(source).toMatch(/createAuthProvider\(\s*{[\s\S]*?oauth:\s*{/);
  });

  it("uses safePath (NOT path.join) for all newly-added path constructions", () => {
    // AGENTS.md ESLint security rule forbids path.join in new code.
    // The pre-existing setup-agents.ts source body still uses path.{resolve,
    // dirname, join} via the imports up top for unrelated paths (skills
    // discovery), but the OAuth wiring must use safePath only.
    expect(source).not.toMatch(/path\.join\(/);
    expect(source).not.toMatch(/path\.resolve\(/);
    // The OAuth wiring's dataDir construction must use safePath.
    const oauthSection = source.slice(
      source.indexOf("FIRST daemon-side OAuth wiring"),
      source.indexOf("createAuthProvider({"),
    );
    expect(oauthSection).toContain("safePath(");
  });

  it("selects encrypted-mode adapter via selectOAuthCredentialStore branch", () => {
    // The daemon constructs the encrypted store inline (it owns secretsDb +
    // secretsCrypto) and injects it into the selector via `encryptedStore`.
    // The selector body itself does not import @comis/memory; it just returns
    // the injected port for encrypted mode. selectOAuthCredentialStore is
    // invoked from setup-agents-registry.ts; createOAuthProfileStoreEncrypted
    // is also value-imported there (it constructs the encrypted store inline).
    const registrySource = readFileSync(
      join(__dirname, "setup-agents-registry.ts"),
      "utf-8",
    );
    expect(registrySource).toContain("selectOAuthCredentialStore({");
    expect(registrySource).toContain('import { createOAuthProfileStoreEncrypted } from "@comis/memory"');
    expect(registrySource).toContain("createOAuthProfileStoreEncrypted(deps.secretsDb, deps.secretsCrypto)");
    expect(registrySource).toMatch(/selectOAuthCredentialStore\(\{[\s\S]*?encryptedStore[\s\S]*?\}\)/);
    // Selector body lives in @comis/core and returns the injected port
    // without touching any memory factory.
    const selectorSource = readFileSync(
      join(__dirname, "..", "..", "..", "..", "core", "src", "oauth", "oauth-credential-store-selector.ts"),
      "utf-8",
    );
    const helperBody = selectorSource.slice(
      selectorSource.indexOf("export function selectOAuthCredentialStore"),
    );
    expect(helperBody).toContain('storage === "encrypted"');
    expect(helperBody).toContain("return encryptedStore");
    // File factory consumes the daemon-injected FileLockPort alongside dataDir.
    expect(helperBody).toContain("fileFactory({ dataDir, fileLock })");
    // Negative assertion: the selector source must NOT import @comis/memory.
    expect(selectorSource).not.toContain('from "@comis/memory"');
  });
});

describe("selectOAuthCredentialStore", () => {
  /** Mock OAuthCredentialStorePort returned by the file factory or injected directly. */
  function makeMockPort(): OAuthCredentialStorePort {
    return {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      has: vi.fn(),
    } as unknown as OAuthCredentialStorePort;
  }

  /**
   * Minimal FileLockPort stub. `fileLock` is required on
   * SelectOAuthCredentialStoreInput; the file branch forwards it into the
   * file factory, while the encrypted branch ignores it.
   */
  function makeFileLockStub(): import("@comis/core").FileLockPort {
    return {
      acquire: vi.fn(),
      release: vi.fn(),
      withLock: vi.fn(),
      isLocked: vi.fn(async () => false),
      cleanupStaleLocks: vi.fn(async () => 0),
    };
  }

  it("file mode: invokes createOAuthCredentialStoreFile with { dataDir, fileLock }; ignores encryptedStore", () => {
    const fileMock = vi.fn(() => makeMockPort());
    const sentinelEncrypted = makeMockPort();
    const fileLock = makeFileLockStub();
    const port = selectOAuthCredentialStore({
      storage: "file",
      dataDir: "/tmp/comis-test-w3",
      fileLock,
      // Even when an encryptedStore is supplied, file mode must NOT use it —
      // the file branch unconditionally delegates to the file factory.
      encryptedStore: sentinelEncrypted,
      factories: {
        file: fileMock as unknown as typeof import("@comis/core").createOAuthCredentialStoreFile,
      },
    });
    expect(port).toBeDefined();
    expect(port).not.toBe(sentinelEncrypted);
    expect(fileMock).toHaveBeenCalledTimes(1);
    expect(fileMock).toHaveBeenCalledWith({ dataDir: "/tmp/comis-test-w3", fileLock });
  });

  it("encrypted mode: returns the injected encryptedStore by reference (no internal factory call)", () => {
    const fileMock = vi.fn(() => makeMockPort());
    // Sentinel identity proves the selector returns the EXACT injected port
    // (daemon owns construction; selector is a pass-through for encrypted mode).
    const sentinelEncrypted = makeMockPort();
    const port = selectOAuthCredentialStore({
      storage: "encrypted",
      dataDir: "/tmp/comis-test-w6",
      fileLock: makeFileLockStub(),
      encryptedStore: sentinelEncrypted,
      factories: {
        file: fileMock as unknown as typeof import("@comis/core").createOAuthCredentialStoreFile,
      },
    });
    expect(port).toBe(sentinelEncrypted);
    expect(fileMock).not.toHaveBeenCalled();
  });

  it("encrypted mode + missing encryptedStore: throws Error pointing daemon composition at the inject point", () => {
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-port",
        fileLock: makeFileLockStub(),
        encryptedStore: undefined,
      }),
    ).toThrow(/no encrypted store was injected/);
    // The error message must name setup-agents.ts (the daemon-side construction
    // site) AND createOAuthProfileStoreEncrypted (the factory the daemon calls).
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-port",
        fileLock: makeFileLockStub(),
      }),
    ).toThrow(/setup-agents\.ts/);
    expect(() =>
      selectOAuthCredentialStore({
        storage: "encrypted",
        dataDir: "/tmp/comis-test-encrypted-no-port",
        fileLock: makeFileLockStub(),
      }),
    ).toThrow(/createOAuthProfileStoreEncrypted/);
  });
});

// ---------------------------------------------------------------------------
// setupSingleAgent structural parity tests
// ---------------------------------------------------------------------------

describe("setupSingleAgent structural parity", () => {
  const source = readRuntimeSource();

  it("setupSingleAgent is exported and is an async function", () => {
    expect(typeof setupSingleAgent).toBe("function");
    // Verify it is declared as async in source
    expect(source).toContain("export async function setupSingleAgent(");
  });

  it("setupSingleAgent validates config with PerAgentConfigSchema", () => {
    // Find setupSingleAgent function body
    const fnStart = source.indexOf("export async function setupSingleAgent(");
    expect(fnStart).toBeGreaterThan(-1);

    // The function body should contain PerAgentConfigSchema.parse
    const fnBody = source.slice(fnStart);
    expect(fnBody).toContain("PerAgentConfigSchema.parse(");
  });
});
