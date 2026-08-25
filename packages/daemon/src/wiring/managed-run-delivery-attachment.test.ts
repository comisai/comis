// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeManagedRunAttachment } from "./managed-run-delivery-attachment.js";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeDelivery(body: Buffer) {
  return {
    kind: "attachment" as const,
    evidenceRef: "evidence-report",
    subjectDigest: "c".repeat(64),
    contentHash: sha256(body),
    body,
    fileName: "report.md",
    mediaType: "text/markdown",
  };
}

describe("managed-run delivery attachment materialization", () => {
  it("rejects a symlinked attachment directory without changing its target", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "managed-delivery-parent-")));
    const target = join(parent, "target");
    const link = join(parent, "delivery");
    try {
      mkdirSync(target, { mode: 0o755 });
      chmodSync(target, 0o755);
      symlinkSync(target, link);

      const result = materializeManagedRunAttachment(
        link,
        "claim-attachment",
        makeDelivery(Buffer.from("immutable report artifact", "utf8")),
      );

      expect(result.ok).toBe(false);
      expect(statSync(target).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an occupied exact path containing different attachment data", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "managed-delivery-")));
    chmodSync(directory, 0o700);
    try {
      const claimId = "claim-attachment";
      const delivery = makeDelivery(Buffer.from("immutable report artifact", "utf8"));
      const filename = `${sha256(JSON.stringify([
        claimId,
        delivery.evidenceRef,
        delivery.contentHash,
      ]))}.body`;
      writeFileSync(join(directory, filename), "different bytes", { mode: 0o600 });

      const result = materializeManagedRunAttachment(directory, claimId, delivery);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("occupied by different data");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
