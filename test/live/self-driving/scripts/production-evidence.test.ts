import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { err, ok } from "@comis/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  EVIDENCE_FACTS_BEGIN,
  EVIDENCE_FACTS_END,
  MAX_EVIDENCE_REPORT_BYTES,
  buildProductionEvidenceProbePlan,
  buildProductionEvidenceProbeScript,
  compareProductionEvidenceReports,
  executeProductionEvidenceProbe,
  parseProductionEvidenceFacts,
  type ProductionEvidenceItem,
  type ProductionEvidenceReport,
} from "./production-evidence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeEvidenceFixture(): {
  dataDir: string;
  sessionFile: string;
  privateValues: readonly string[];
} {
  const dataDir = mkdtempSync(join(tmpdir(), "comis-production-evidence-"));
  roots.push(dataDir);
  const privateValues = [
    "PRIVATE_USER_PROMPT",
    "private-user-session",
    "secret-token-value",
    dataDir,
  ] as const;

  const logsDir = join(dataDir, "logs");
  const workspace = join(dataDir, "workspace");
  const sessionDir = join(workspace, "sessions", "tenant-private", "telegram-private");
  const schedulerDir = join(workspace, ".scheduler");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(schedulerDir, { recursive: true });
  mkdirSync(join(workspace, "media", "photos"), { recursive: true });
  mkdirSync(join(workspace, "results"), { recursive: true });
  mkdirSync(join(workspace, "skills", "private-skill"), { recursive: true });
  mkdirSync(join(workspace, ".learned-skills", "private-learned"), { recursive: true });
  mkdirSync(join(dataDir, "background-tasks", "agent-private"), { recursive: true });
  mkdirSync(join(dataDir, "subagent-results", "tenant-private"), { recursive: true });
  mkdirSync(join(dataDir, "graph-runs", "abcd1234"), { recursive: true });
  mkdirSync(join(dataDir, "skills", "bundled-private"), { recursive: true });

  const sessionFile = join(sessionDir, "private-user-session.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ role: "user", content: "PRIVATE_USER_PROMPT" }),
      JSON.stringify({ role: "assistant", content: "private assistant response" }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    sessionFile.replace(/\.jsonl$/u, "_session-metadata.json"),
    JSON.stringify({ traceId: "private-trace", token: "secret-token-value" }),
  );
  writeFileSync(`${sessionFile}.trajectory.jsonl`, `${JSON.stringify({ body: "PRIVATE_USER_PROMPT" })}\n`);
  writeFileSync(
    `${sessionFile}.trajectory-path.json`,
    JSON.stringify({ diskPathRel: "private-user-session.jsonl.trajectory.jsonl" }),
  );
  writeFileSync(join(logsDir, "daemon.1.log"), `PRIVATE_USER_PROMPT\nsecret-token-value\n`);
  writeFileSync(join(logsDir, "security-audit.jsonl"), `${JSON.stringify({ raw: "secret-token-value" })}\n`);
  writeFileSync(join(logsDir, "config-audit.jsonl"), `${JSON.stringify({ raw: "secret-token-value" })}\n`);
  writeFileSync(join(logsDir, "cache-trace.jsonl"), `${JSON.stringify({ raw: "PRIVATE_USER_PROMPT" })}\n`);
  writeFileSync(join(logsDir, "session-index.2026-07-15.jsonl"), `${JSON.stringify({ event: "turn_completed" })}\n`);
  writeFileSync(join(schedulerDir, "cron-jobs.json"), JSON.stringify([{ payload: "PRIVATE_USER_PROMPT" }]));
  writeFileSync(join(schedulerDir, "execution.jsonl"), `${JSON.stringify({ ts: 3000, summary: "PRIVATE_USER_PROMPT" })}\n`);
  writeFileSync(join(dataDir, "background-tasks", "agent-private", "task-private.json"), JSON.stringify({ result: "PRIVATE_USER_PROMPT" }));
  writeFileSync(join(dataDir, "subagent-results", "tenant-private", "run-private.json"), JSON.stringify({ result: "PRIVATE_USER_PROMPT" }));
  writeFileSync(join(dataDir, "graph-runs", "abcd1234", "node-output.md"), "PRIVATE_USER_PROMPT");
  writeFileSync(join(workspace, "media", "photos", "private-photo.png"), "private-media-bytes");
  writeFileSync(join(workspace, "results", "private-result.txt"), "PRIVATE_USER_PROMPT");
  writeFileSync(join(workspace, "skills", "private-skill", "SKILL.md"), "PRIVATE_USER_PROMPT");
  writeFileSync(join(workspace, ".learned-skills", "private-learned", "SKILL.md"), "PRIVATE_USER_PROMPT");
  writeFileSync(join(dataDir, "skills", "bundled-private", "SKILL.md"), "PRIVATE_USER_PROMPT");
  writeFileSync(join(dataDir, "config.yaml"), "apiKey: secret-token-value\n");

  const db = new Database(join(dataDir, "memory.db"));
  db.exec(`
    CREATE TABLE lcd_messages (id TEXT, created_at INTEGER);
    INSERT INTO lcd_messages VALUES ('private-message-a', 1000), ('private-message-b', 2000);
    CREATE TABLE lcd_message_parts (id TEXT);
    INSERT INTO lcd_message_parts VALUES ('private-part');
    CREATE TABLE memories (id TEXT, content TEXT, created_at INTEGER);
    INSERT INTO memories VALUES ('private-memory', 'PRIVATE_USER_PROMPT', 1500);
    CREATE TABLE delivery_queue (id TEXT, text TEXT, created_at INTEGER);
    INSERT INTO delivery_queue VALUES ('private-delivery', 'PRIVATE_USER_PROMPT', 2500);
    CREATE TABLE obs_diagnostics (id INTEGER, message TEXT, timestamp INTEGER);
    INSERT INTO obs_diagnostics VALUES (1, 'secret-token-value', 2750);
  `);
  db.close();

  return { dataDir, sessionFile, privateValues };
}

function runProbe(dataDir: string): string {
  const result = spawnSync(
    "bash",
    ["-s", "--", dataDir, process.cwd(), userInfo().username],
    { encoding: "utf8", input: buildProductionEvidenceProbeScript() },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function parseReport(raw: string): ProductionEvidenceReport {
  const result = parseProductionEvidenceFacts(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function item(report: ProductionEvidenceReport, id: ProductionEvidenceItem["id"]): ProductionEvidenceItem {
  const found = report.items.find((candidate) => candidate.id === id);
  expect(found, `missing evidence item ${id}`).toBeDefined();
  return found as ProductionEvidenceItem;
}

describe("production evidence inventory", () => {
  it("builds a read-only service-user probe plan with explicit roots and SSH port", () => {
    const result = buildProductionEvidenceProbePlan({
      host: "production.example.com",
      port: 2222,
      dataDir: "/srv/comis-data",
      packageRoot: "/opt/node_modules/comisai",
      serviceUser: "comis",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      label: "production-evidence-inventory",
      host: "production.example.com",
      port: 2222,
      args: [
        "bash",
        "-s",
        "--",
        "/srv/comis-data",
        "/opt/node_modules/comisai",
        "comis",
      ],
    });
    expect(result.value.stdin).toContain("sudo -n -u");
    expect(result.value.stdin).not.toMatch(/(?:^|\s)(?:rm|mv|cp|chmod|chown|tee|install)(?:\s|$)/mu);
  });

  it("rejects unsafe plan inputs before constructing a remote invocation", () => {
    expect(
      buildProductionEvidenceProbePlan({
        host: "production.example.com",
        dataDir: "relative-data",
        packageRoot: "/opt/node_modules/comisai",
        serviceUser: "comis",
      }).ok,
    ).toBe(false);
    expect(
      buildProductionEvidenceProbePlan({
        host: "production.example.com",
        dataDir: "/srv/comis-data",
        packageRoot: "/opt/node_modules/comisai",
        serviceUser: "bad user",
      }).ok,
    ).toBe(false);
  });

  it("returns bounded aggregate facts for real layouts without exposing content or paths", () => {
    const fixture = makeEvidenceFixture();
    const raw = runProbe(fixture.dataDir);
    const report = parseReport(raw);

    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(MAX_EVIDENCE_REPORT_BYTES);
    expect(report).toMatchObject({
      schema: "comis-production-evidence",
      schemaVersion: 1,
      consistency: "live_non_atomic",
    });
    expect(item(report, "lcd_messages")).toMatchObject({
      configured: "configured",
      availability: "available",
      readability: "readable",
      rows: 2,
      contentDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      earliestMs: 1000,
      latestMs: 2000,
      timeBasis: "row_timestamp",
    });
    expect(item(report, "session_transcripts")).toMatchObject({
      availability: "available",
      readability: "readable",
      files: 1,
      records: 2,
      timeBasis: "file_mtime",
    });
    expect(item(report, "delivery_queue")).toMatchObject({ rows: 1, earliestMs: 2500, latestMs: 2500 });
    expect(item(report, "media_artifacts")).toMatchObject({ files: 1 });
    expect(item(report, "active_graphs")).toMatchObject({
      availability: "unsupported",
      readability: "not_applicable",
      gapReason: "not_durable",
    });
    expect(item(report, "system_event_queue")).toMatchObject({
      availability: "unsupported",
      gapReason: "not_durable",
    });
    expect(item(report, "recall_traces")).toMatchObject({
      availability: "missing",
      readability: "not_applicable",
      gapReason: "configuration_not_evaluated",
    });
    for (const privateValue of fixture.privateValues) expect(raw).not.toContain(privateValue);
    expect(raw).not.toContain("package.json");
    expect(raw).not.toContain("memory.db");
    expect(readFileSync(fixture.sessionFile, "utf8")).toContain("PRIVATE_USER_PROMPT");
    const db = new Database(join(fixture.dataDir, "memory.db"), { readonly: true });
    expect(db.prepare("SELECT content FROM memories").pluck().get()).toBe("PRIVATE_USER_PROMPT");
    db.close();
  });

  it("strictly rejects oversized, extra-field, and incomplete evidence envelopes", () => {
    expect(parseProductionEvidenceFacts("x".repeat(MAX_EVIDENCE_REPORT_BYTES + 1)).ok).toBe(false);
    const fixture = makeEvidenceFixture();
    const valid = runProbe(fixture.dataDir);
    expect(parseProductionEvidenceFacts(`banner\n${valid}`).ok).toBe(false);
    expect(
      parseProductionEvidenceFacts(
        valid.replace('"schemaVersion":1', '"schemaVersion":1,"raw":"PRIVATE_USER_PROMPT"'),
      ).ok,
    ).toBe(false);
    expect(
      parseProductionEvidenceFacts(
        valid.replace('"id":"memory_database"', '"id":"memory_database","path":"/private"'),
      ).ok,
    ).toBe(false);
    expect(parseProductionEvidenceFacts(valid.replace(EVIDENCE_FACTS_END, "")).ok).toBe(false);
  });

  it("execution sanitizes remote failures and malformed reports", async () => {
    const input = {
      host: "production.example.com",
      dataDir: "/srv/comis-data",
      packageRoot: "/opt/node_modules/comisai",
      serviceUser: "comis",
    } as const;
    const failed = await executeProductionEvidenceProbe(input, {
      run: async () => err({ kind: "remote", message: "PRIVATE_REMOTE_STDERR" }),
    });
    expect(failed).toEqual({
      ok: false,
      error: {
        kind: "remote_failure",
        message: "Production evidence inventory probe failed",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_REMOTE_STDERR");

    const malformed = await executeProductionEvidenceProbe(input, {
      run: async () => ok({ stdout: "PRIVATE_REMOTE_OUTPUT", exitCode: 0 }),
    });
    expect(malformed.ok).toBe(false);
    expect(JSON.stringify(malformed)).not.toContain("PRIVATE_REMOTE_OUTPUT");
  });

  it("attests source and target evidence parity while ignoring probe observation time", () => {
    const fixture = makeEvidenceFixture();
    const source = parseReport(runProbe(fixture.dataDir));
    const target = { ...source, observedAtMs: source.observedAtMs + 250 };

    const result = compareProductionEvidenceReports(source, target);

    expect(result).toEqual({
      ok: true,
      value: {
        exact: true,
        itemCount: source.items.length,
        gapCount: source.items.filter((candidate) => candidate.gapReason !== undefined).length,
      },
    });
  });

  it("reports the first evidence divergence without disclosing compared values", () => {
    const fixture = makeEvidenceFixture();
    const source = parseReport(runProbe(fixture.dataDir));
    const target = {
      ...source,
      items: source.items.map((candidate) =>
        candidate.id === "lcd_messages" ? { ...candidate, rows: 9_999_999 } : candidate,
      ),
    };

    const result = compareProductionEvidenceReports(source, target);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "evidence_mismatch",
        evidenceId: "lcd_messages",
        field: "rows",
        message: "Target evidence does not match the production source",
      },
    });
    expect(JSON.stringify(result)).not.toContain("9999999");
  });

  it("rejects equal aggregate metadata when evidence content differs", () => {
    const fixture = makeEvidenceFixture();
    const source = parseReport(runProbe(fixture.dataDir));
    const target = {
      ...source,
      items: source.items.map((candidate) =>
        candidate.id === "lcd_messages"
          ? { ...candidate, contentDigestSha256: "f".repeat(64) }
          : candidate,
      ),
    };

    const result = compareProductionEvidenceReports(source, target);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "evidence_mismatch",
        evidenceId: "lcd_messages",
        field: "contentDigestSha256",
        message: "Target evidence does not match the production source",
      },
    });
    expect(JSON.stringify(result)).not.toContain("f".repeat(64));
  });
});
