// SPDX-License-Identifier: Apache-2.0
//
// UX-1 (LOCAL re-test 2026-06-20): `comis sessions list` reported a 2-part key
// (`default:openai-api`) for a workspace JSONL session, but the LCD/`reset`/
// `explain` paths key on the canonical 3-part `tenant:user:channel` form
// (`default:openai-api:openai`). Copying the listed key into `sessions reset`
// therefore deleted 0 rows. scanWorkspaceSessions dropped the channel directory
// from the derived key (`${tenantId}:${file}` instead of
// `${tenantId}:${file}:${channelDir}`). A 2-part key is ALSO un-parseable by
// parseFormattedSessionKey (needs >=3 segments) and never dedups against the
// SQLite session_key. These pin the canonical-key derivation.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFormattedSessionKey } from "@comis/core";
import { scanWorkspaceSessions } from "./session-helpers.js";

describe("scanWorkspaceSessions — canonical tenant:user:channel sessionKey (UX-1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comis-ux1-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(tenant: string, channelDir: string, file: string): void {
    const d = join(dir, "sessions", tenant, channelDir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, file), JSON.stringify({ role: "user", content: "hi" }) + "\n");
  }

  it("includes the channel directory — sessions/default/openai/openai-api.jsonl => default:openai-api:openai", () => {
    writeSession("default", "openai", "openai-api.jsonl");
    const s = scanWorkspaceSessions(dir).find((r) => r.sessionKey.startsWith("default:openai-api"));
    expect(s).toBeDefined();
    expect(s!.sessionKey).toBe("default:openai-api:openai");
  });

  it("produces a key that round-trips through parseFormattedSessionKey (a 2-part key would not)", () => {
    writeSession("default", "telegram", "678314278.jsonl");
    const s = scanWorkspaceSessions(dir).find((r) => r.sessionKey.includes("678314278"))!;
    expect(s.sessionKey).toBe("default:678314278:telegram");
    const parsed = parseFormattedSessionKey(s.sessionKey);
    expect(parsed).toBeDefined();
    expect(parsed!.tenantId).toBe("default");
    expect(parsed!.userId).toBe("678314278");
    expect(parsed!.channelId).toBe("telegram");
  });
});
