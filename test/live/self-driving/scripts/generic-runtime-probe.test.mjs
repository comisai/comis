import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  renderDeliveryMirrorForWire,
  selectLatestTelegramDeliveryMirror,
} from "./delivery-mirror-oracle.mjs";

const SCRIPT = resolve("test/live/self-driving/scripts/generic-runtime-probe.mjs");

test("delivery mirror reconciliation compares the platform-rendered text", () => {
  const formatForChannel = (text, channelType) => {
    assert.equal(text, "The **result** is `0`.");
    assert.equal(channelType, "telegram");
    return "The <b>result</b> is <code>0</code>.";
  };

  assert.equal(
    renderDeliveryMirrorForWire(
      { text: "The **result** is `0`.", channel_type: "telegram" },
      formatForChannel,
    ),
    "The <b>result</b> is <code>0</code>.",
  );
});

test("delivery mirror selection retains the platform renderer discriminator", () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /\bchannel_type\b/u);
      return { get: () => undefined };
    },
  };

  selectLatestTelegramDeliveryMirror(db, "chat_a");
});

test("receipts probe follows the live nested-session trajectory pointer", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "comis-receipts-probe-"));
  try {
    const sessionFile = join(
      dataDir,
      "workspace",
      "sessions",
      "default",
      "telegram",
      "user_a~peer~user_a.jsonl",
    );
    const trajectoryFile = join(dataDir, "trajectories", "runtime.trajectory.jsonl");
    mkdirSync(dirname(sessionFile), { recursive: true });
    mkdirSync(dirname(trajectoryFile), { recursive: true });
    writeFileSync(sessionFile, "", "utf8");
    writeFileSync(
      `${sessionFile}.trajectory-path.json`,
      JSON.stringify({
        traceSchema: "comis-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session_a",
        runtimeFile: trajectoryFile,
      }),
      "utf8",
    );
    writeFileSync(
      sessionFile.replace(/\.jsonl$/, "_session-metadata.json"),
      JSON.stringify({ sessionKey: "session_a" }),
      "utf8",
    );
    writeFileSync(
      trajectoryFile,
      [
        { type: "prompt.submitted", ts: "2026-08-04T00:00:00.000Z", data: {} },
        {
          type: "tool.call",
          ts: "2026-08-04T00:00:01.000Z",
          data: { toolName: "web_search", toolCallId: "call_a" },
        },
        {
          type: "tool.result",
          ts: "2026-08-04T00:00:02.000Z",
          data: {
            toolName: "web_search",
            toolCallId: "call_a",
            success: true,
            durationMs: 25,
            resultDigest: "digest_a",
          },
        },
        {
          type: "session.summary",
          ts: "2026-08-04T00:00:03.000Z",
          data: { degraded: false, endReason: "success", toolStats: { web_search: 1 } },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    const output = execFileSync(process.execPath, [SCRIPT, "receipts"], {
      cwd: resolve("."),
      env: {
        ...process.env,
        RIG_MODE: "local",
        RIG_ENV: join(dataDir, "missing-rig-env"),
        COMIS_DATA_DIR: dataDir,
        DATA: dataDir,
      },
      encoding: "utf8",
    });
    const report = JSON.parse(output);

    assert.equal(report.receipts.trajectoryFound, true);
    assert.equal(report.receipts.receipts.length, 2);
    assert.equal(report.receipts.receipts[1].resultDigest, "digest_a");
    assert.deepEqual(report.receipts.summary, {
      degraded: false,
      endReason: "success",
      toolStats: { web_search: 1 },
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
