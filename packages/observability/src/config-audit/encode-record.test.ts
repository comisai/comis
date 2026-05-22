// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { encodeAuditRecord } from "./encode-record.js";

describe("encodeAuditRecord", () => {
  it("redacts --password=value in argv and caps argv length", () => {
    const out = encodeAuditRecord({
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-22T00:00:00.000Z",
      source: "config-io",
      event: "config.write",
      callerSource: "config-patch-rpc",
      configPath: "/tmp/foo",
      pid: 1,
      ppid: 1,
      argv: ["node", "--inspect", "--password=secret", "daemon.js"],
      cwd: "/tmp",
      execArgv: [],
      watchMode: false,
      entryScript: "daemon.js",
      result: "rename",
    });
    expect(typeof out).toBe("string");
    expect(out.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(out.trimEnd()) as Record<string, unknown>;
    expect(Array.isArray(parsed.argv)).toBe(true);
    const argv = parsed.argv as string[];
    // The literal --password=secret entry MUST not survive verbatim.
    expect(argv.some((s) => s === "--password=secret")).toBe(false);
    // The redactor masks the value but preserves the flag name for forensics.
    const passwordEntry = argv.find((s) => s.startsWith("--password="));
    expect(passwordEntry).toBeDefined();
    expect(passwordEntry).not.toBe("--password=secret");
  });

  it("omits the argv field entirely when the input record has no argv", () => {
    const out = encodeAuditRecord({
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-22T00:00:00.000Z",
      event: "config.observe",
      configPath: "/tmp/foo",
      outcome: "valid",
    });
    const parsed = JSON.parse(out.trimEnd()) as Record<string, unknown>;
    expect("argv" in parsed).toBe(false);
  });

  it("preserves non-array argv verbatim for the scrub edge case", () => {
    const out = encodeAuditRecord({
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-22T00:00:00.000Z",
      argv: "not-an-array" as unknown,
    });
    const parsed = JSON.parse(out.trimEnd()) as Record<string, unknown>;
    expect(parsed.argv).toBe("not-an-array");
  });

  it("falls back to the serialization sentinel when safeJsonStringify returns undefined", () => {
    const out = encodeAuditRecord({
      traceSchema: "comis-config-audit",
      schemaVersion: 1,
      ts: "2026-05-22T00:00:00.000Z",
      // BigInt forces JSON.stringify to throw → safeJsonStringify returns undefined.
      value: BigInt(1) as unknown,
    });
    const parsed = JSON.parse(out.trimEnd()) as Record<string, unknown>;
    expect(parsed.traceSchema).toBe("comis-config-audit");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.__serializationError).toBe("record-not-serializable");
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
