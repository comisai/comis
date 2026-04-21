// SPDX-License-Identifier: Apache-2.0
/**
 * Skill Isolation Multi-Agent E2E Integration Tests
 *
 * Validates that per-agent skill isolation (Phases 439-441) works correctly
 * across the full daemon stack: config -> daemon -> gateway -> WebSocket RPC ->
 * skill registry -> filesystem.
 *
 *   TEST-ISO-01: Alpha's local skill is visible only to alpha
 *   TEST-ISO-02: Beta's local skill is visible only to beta
 *   TEST-ISO-03: Non-default agent cannot upload with shared scope
 *   TEST-ISO-04: Default agent's shared skill is visible to all agents
 *   TEST-ISO-05: Deleting shared skill removes it from all agents
 *
 * Uses a dedicated config (port 8730, alpha + beta agents, separate memory DB)
 * to avoid conflicts with other test suites.
 *
 * Uses WebSocket JSON-RPC for full-stack testing including gateway auth and
 * scope enforcement (skills.upload/delete require "admin" scope).
 *
 * @module
 */

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-skill-isolation.yaml");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMIS_DIR = join(homedir(), ".comis");

/** Skill names prefixed with test-iso- to avoid collisions and simplify cleanup. */
const ALPHA_SKILL = "test-iso-alpha-local";
const BETA_SKILL = "test-iso-beta-local";
const SHARED_SKILL = "test-iso-shared-skill";

/**
 * Generate a valid SKILL.md content string with YAML frontmatter.
 */
function SKILL_MD_TEMPLATE(name: string, description: string): string {
  return `---
name: ${name}
description: "${description}"
---

Test skill body.
`;
}

// ---------------------------------------------------------------------------
// Helper: send JSON-RPC and extract result (throws on error)
// ---------------------------------------------------------------------------

let rpcId = 0;

/**
 * Send a JSON-RPC request over WebSocket, extract result, throw on error.
 */
async function rpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const resp = await sendJsonRpc(ws, method, params, ++rpcId, { timeoutMs: RPC_FAST_MS }) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };

  if (resp.error) {
    throw new Error(`RPC error ${resp.error.code}: ${resp.error.message}`);
  }

  return resp.result;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Skill Isolation Multi-Agent E2E", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
  }, 120_000);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  afterAll(async () => {
    // Best-effort delete of test skills via RPC (both agents, both scopes)
    if (ws && ws.readyState === WebSocket.OPEN) {
      const skillNames = [ALPHA_SKILL, BETA_SKILL, SHARED_SKILL];
      const agents = ["alpha", "beta"];
      const scopes = ["local", "shared"];

      for (const name of skillNames) {
        for (const agentId of agents) {
          for (const scope of scopes) {
            try {
              await rpc(ws, "skills.delete", { agentId, name, scope });
            } catch {
              // Skill may not exist or agent may not have permission -- expected
            }
          }
        }
      }

      ws.close();
    }

    // Also rmSync any remaining test skill dirs from filesystem
    rmSync(join(COMIS_DIR, "workspace-alpha/skills", ALPHA_SKILL), { force: true, recursive: true });
    rmSync(join(COMIS_DIR, "workspace-beta/skills", BETA_SKILL), { force: true, recursive: true });
    rmSync(join(COMIS_DIR, "skills", SHARED_SKILL), { force: true, recursive: true });

    // Daemon cleanup
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // TEST-ISO-01: alpha's local skill is visible only to alpha
  // -------------------------------------------------------------------------

  it(
    "TEST-ISO-01: alpha's local skill is visible only to alpha",
    async () => {
      // Upload a local skill for alpha
      const uploadResult = await rpc(ws, "skills.upload", {
        agentId: "alpha",
        name: ALPHA_SKILL,
        scope: "local",
        files: [{ path: "SKILL.md", content: SKILL_MD_TEMPLATE(ALPHA_SKILL, "Alpha local skill") }],
      }) as { ok: boolean };

      expect(uploadResult.ok).toBe(true);

      // List alpha's skills -- should contain the alpha skill
      const alphaSkills = await rpc(ws, "skills.list", {
        agentId: "alpha",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(alphaSkills.skills.some((s) => s.name === ALPHA_SKILL)).toBe(true);

      // List beta's skills -- should NOT contain the alpha skill
      const betaSkills = await rpc(ws, "skills.list", {
        agentId: "beta",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(betaSkills.skills.some((s) => s.name === ALPHA_SKILL)).toBe(false);
    },
    RPC_FAST_MS * 3,
  );

  // -------------------------------------------------------------------------
  // TEST-ISO-02: beta's local skill is visible only to beta
  // -------------------------------------------------------------------------

  it(
    "TEST-ISO-02: beta's local skill is visible only to beta",
    async () => {
      // Upload a local skill for beta
      const uploadResult = await rpc(ws, "skills.upload", {
        agentId: "beta",
        name: BETA_SKILL,
        scope: "local",
        files: [{ path: "SKILL.md", content: SKILL_MD_TEMPLATE(BETA_SKILL, "Beta local skill") }],
      }) as { ok: boolean };

      expect(uploadResult.ok).toBe(true);

      // List beta's skills -- should contain the beta skill
      const betaSkills = await rpc(ws, "skills.list", {
        agentId: "beta",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(betaSkills.skills.some((s) => s.name === BETA_SKILL)).toBe(true);

      // List alpha's skills -- should NOT contain the beta skill
      const alphaSkills = await rpc(ws, "skills.list", {
        agentId: "alpha",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(alphaSkills.skills.some((s) => s.name === BETA_SKILL)).toBe(false);
    },
    RPC_FAST_MS * 3,
  );

  // -------------------------------------------------------------------------
  // TEST-ISO-03: non-default agent cannot upload with shared scope
  // -------------------------------------------------------------------------

  it(
    "TEST-ISO-03: non-default agent cannot upload with shared scope",
    async () => {
      try {
        await rpc(ws, "skills.upload", {
          agentId: "beta",
          name: "test-iso-denied",
          scope: "shared",
          files: [{ path: "SKILL.md", content: SKILL_MD_TEMPLATE("test-iso-denied", "Should fail") }],
        });

        expect.fail("Non-default agent should not upload shared skills");
      } catch (err) {
        expect(String(err)).toContain("Only the default agent");
      }
    },
    RPC_FAST_MS * 2,
  );

  // -------------------------------------------------------------------------
  // TEST-ISO-04: default agent's shared skill is visible to all agents
  // -------------------------------------------------------------------------

  it(
    "TEST-ISO-04: default agent's shared skill is visible to all agents",
    async () => {
      // Upload shared skill as alpha (the default agent)
      const uploadResult = await rpc(ws, "skills.upload", {
        agentId: "alpha",
        name: SHARED_SKILL,
        scope: "shared",
        files: [{ path: "SKILL.md", content: SKILL_MD_TEMPLATE(SHARED_SKILL, "Shared skill") }],
      }) as { ok: boolean };

      expect(uploadResult.ok).toBe(true);

      // List alpha's skills -- should contain the shared skill
      const alphaSkills = await rpc(ws, "skills.list", {
        agentId: "alpha",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(alphaSkills.skills.some((s) => s.name === SHARED_SKILL)).toBe(true);

      // List beta's skills -- should also contain the shared skill
      const betaSkills = await rpc(ws, "skills.list", {
        agentId: "beta",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(betaSkills.skills.some((s) => s.name === SHARED_SKILL)).toBe(true);

      // Verify filesystem: shared skill exists in the shared skills directory
      expect(existsSync(join(COMIS_DIR, "skills", SHARED_SKILL, "SKILL.md"))).toBe(true);
    },
    RPC_FAST_MS * 3,
  );

  // -------------------------------------------------------------------------
  // TEST-ISO-05: deleting shared skill removes it from all agents
  // -------------------------------------------------------------------------

  it(
    "TEST-ISO-05: deleting shared skill removes it from all agents",
    async () => {
      // Confirm shared skill is still visible to both agents
      const alphaBefore = await rpc(ws, "skills.list", {
        agentId: "alpha",
      }) as { skills: Array<{ name: string; source: string }> };

      const betaBefore = await rpc(ws, "skills.list", {
        agentId: "beta",
      }) as { skills: Array<{ name: string; source: string }> };

      // If shared skill not present (e.g., cleanup from prior run), re-upload it
      if (
        !alphaBefore.skills.some((s) => s.name === SHARED_SKILL) ||
        !betaBefore.skills.some((s) => s.name === SHARED_SKILL)
      ) {
        await rpc(ws, "skills.upload", {
          agentId: "alpha",
          name: SHARED_SKILL,
          scope: "shared",
          files: [{ path: "SKILL.md", content: SKILL_MD_TEMPLATE(SHARED_SKILL, "Shared skill") }],
        });
      }

      // Delete the shared skill
      const deleteResult = await rpc(ws, "skills.delete", {
        agentId: "alpha",
        name: SHARED_SKILL,
        scope: "shared",
      }) as { ok: boolean };

      expect(deleteResult.ok).toBe(true);

      // List alpha's skills -- should NOT contain the shared skill
      const alphaAfter = await rpc(ws, "skills.list", {
        agentId: "alpha",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(alphaAfter.skills.some((s) => s.name === SHARED_SKILL)).toBe(false);

      // List beta's skills -- should NOT contain the shared skill
      const betaAfter = await rpc(ws, "skills.list", {
        agentId: "beta",
      }) as { skills: Array<{ name: string; source: string }> };

      expect(betaAfter.skills.some((s) => s.name === SHARED_SKILL)).toBe(false);
    },
    RPC_FAST_MS * 3,
  );
});
