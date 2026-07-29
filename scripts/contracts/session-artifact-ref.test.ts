import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChatSessionArtifacts } from "../../test/live/self-driving/scripts/session-artifact-ref.mjs";

describe("live session artifact resolution", () => {
  it("finds the privacy-principal Telegram session in the actual nested workspace layout", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-live-ref-"));
    const channelDir = join(dataDir, "workspace", "sessions", "default", "telegram");
    mkdirSync(channelDir, { recursive: true });
    const base = join(channelDir, "platform_digest~peer~platform_digest.jsonl");
    writeFileSync(
      base,
      `${JSON.stringify({
        type: "custom",
        customType: "comis.inbound-message-provenance",
        data: {
          messages: [{
            id: "message_a",
            channelId: "678314278",
            channelType: "telegram",
            senderId: "678314278",
          }],
        },
      })}\n`,
    );
    writeFileSync(`${base}.trajectory.jsonl`, `${JSON.stringify({
      traceSchema: "comis-trajectory",
      type: "prompt.submitted",
      seq: 1,
      traceId: "trace_a",
      data: {},
    })}\n`);

    expect(resolveChatSessionArtifacts(dataDir, "678314278")).toEqual({
      sessionFile: base,
      trajectoryFile: `${base}.trajectory.jsonl`,
    });
  });
});
