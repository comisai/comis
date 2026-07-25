// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate-executor-cores` — the shipped daemon-side `tool.invoke` executor
 * cores. Asserts: the file cores run under the lease's workspaceDir
 * (a `read` returns the file content), the `jq` core confines its path under the
 * workspace + honest-degrades (missing path / traversal escape / non-zero exit)
 * to an `{ error }` shape (never a throw), and `web_search` routes to the shipped
 * tool. The real in-jail jq-over-ResultRef round-trip is the VPS-deferred
 * `orchestrate-jail.linux.test.ts`; here we assert the wiring + confinement.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComisLogger } from "@comis/core";

// Spy on execFile so the SSRF/exfil-rejection tests can assert duckdb is NEVER
// spawned for a malicious query. The default implementation
// DELEGATES to the real execFile, so the jq / duckdb-absent / file-tool paths
// keep their genuine behavior; only the call-count assertions read the spy.
const { execFileSpy } = vi.hoisted(() => ({ execFileSpy: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  execFileSpy.mockImplementation((...args: unknown[]) =>
    (actual.execFile as unknown as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, execFile: execFileSpy };
});

import {
  createOrchestrateExecutorCores,
  rejectDangerousSql,
  isSafeJsonPath,
} from "./orchestrate-executor-cores.js";
import { createResultRefStore, safeResultRunId } from "./result-ref-store.js";

const RUN_ID = "run-1";

function makeLogger(): ComisLogger {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { child: vi.fn(() => child), ...child } as unknown as ComisLogger;
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "orch-cores-"));
}

/** Capture the logger.child(...) spy so a test can assert errorKind on a WARN. */
function makeLoggerWithCapture(): { logger: ComisLogger; child: Record<string, ReturnType<typeof vi.fn>> } {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const logger = { child: vi.fn(() => child), ...child } as unknown as ComisLogger;
  return { logger, child };
}

beforeEach(() => {
  // Clear the spy's call history (NOT its delegating implementation) so each
  // rejection test counts only its own duckdb spawns.
  execFileSpy.mockClear();
});

describe("createOrchestrateExecutorCores", () => {
  it("exposes the 8 file cores (read/grep/find/ls/jq/sql/jsonpath + write) + a web_search core", () => {
    const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
    expect(Object.keys(cores.fileExecutors).sort()).toEqual(
      ["find", "grep", "jq", "jsonpath", "ls", "read", "sql", "write"],
    );
    expect(typeof cores.webSearch).toBe("function");
  });

  it("runs the read core under the lease's workspaceDir and returns the file content", async () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, "note.txt"), "hello orchestrate\n", "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = (await cores.fileExecutors.read({ path: "note.txt" }, { workspaceDir: ws })) as {
        content: { text?: string }[];
      };
      const text = result.content.map((c) => c.text ?? "").join("");
      expect(text).toContain("hello orchestrate");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("runs the ls core under the lease's workspaceDir and lists the workspace entries", async () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, "alpha.txt"), "a", "utf8");
      writeFileSync(join(ws, "beta.txt"), "b", "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = (await cores.fileExecutors.ls({ path: "." }, { workspaceDir: ws })) as {
        content: { text?: string }[];
      };
      // The ls core constructs the shipped ls AgentTool under ctx.workspaceDir and
      // executes it; the listing names the files we created (proves the core is
      // scoped to the lease's workspace, not the daemon cwd).
      const text = result.content.map((c) => c.text ?? "").join("");
      expect(text).toContain("alpha.txt");
      expect(text).toContain("beta.txt");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("runs the find core under the lease's workspaceDir and matches a glob", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "sub"), { recursive: true });
      writeFileSync(join(ws, "sub", "keep.json"), "{}", "utf8");
      writeFileSync(join(ws, "sub", "skip.txt"), "x", "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = (await cores.fileExecutors.find(
        { pattern: "**/*.json" },
        { workspaceDir: ws },
      )) as { content: { text?: string }[] };
      // The find core constructs the shipped find AgentTool under the workspace and
      // globs it — the .json file matches, the .txt file does not.
      const text = result.content.map((c) => c.text ?? "").join("");
      expect(text).toContain("keep.json");
      expect(text).not.toContain("skip.txt");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("runs the grep core under the lease's workspaceDir and returns a content-shaped result (or degrades cleanly if rg is absent)", async () => {
    const ws = makeWorkspace();
    const prevOffline = process.env.COMIS_OFFLINE;
    // Offline so the grep tool's ripgrep provisioner never attempts a download in
    // the sandbox: rg already present → it runs; rg absent → the tool catches the
    // "not available" path and returns it inline (never a throw out of the core).
    process.env.COMIS_OFFLINE = "1";
    try {
      writeFileSync(join(ws, "data.txt"), "needle in a haystack\nother line\n", "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = (await cores.fileExecutors.grep(
        { pattern: "needle", path: "data.txt" },
        { workspaceDir: ws },
      )) as { content: { text?: string }[] };
      // The grep core constructs the shipped grep AgentTool under the workspace and
      // executes it. Either outcome (a match line, or an inline "rg not available"
      // block) routes through the tool and returns the {content:[...]} shape
      // WITHOUT throwing — proving the daemon-side grep core wiring.
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      if (prevOffline === undefined) delete process.env.COMIS_OFFLINE;
      else process.env.COMIS_OFFLINE = prevOffline;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // The `write` core — the FIRST general writing core on this surface (the
  // module was read-only by construction). It adapts the shipped
  // createComisWriteTool under the RUN-SCOPED, EPHEMERAL write root
  // `<workspace>/results/<safe-run-id>/writes` — every path is safePath-confined
  // to THAT root
  // (a `..`/absolute/into-`skills/` escape is refused, nothing is written
  // outside), the write is run-EPHEMERAL (its exact run root is reaped by
  // ResultRefStore.cleanupRun on run end), and a guard that would throw
  // honest-degrades to an { error } (never a throw), like the jq/sql/jsonpath
  // slicers. Ground truth: a real file under a real temp workspace's
  // results/<safe-run-id>/writes; a real absence after a REAL cleanupRun; a real absence of
  // the workspace-root discovery subtree (skills/).
  // -------------------------------------------------------------------------

  it("runs the write core under the isolated run results root instead of the persistent workspace root", async () => {
    const ws = makeWorkspace();
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = (await cores.fileExecutors.write(
        { path: "note.txt", content: "hello orchestrate write" },
        { workspaceDir: ws, runId: RUN_ID },
      )) as { error?: string };
      // Ground truth: the file lands under the run-scoped results write root with
      // the exact content — NOT at the persistent workspace root (the read cores'
      // dir + the top-priority skill-discovery path).
      const written = join(ws, "results", safeResultRunId(RUN_ID), "writes", "note.txt");
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, "utf8")).toBe("hello orchestrate write");
      // The persistent workspace root is UNTOUCHED — no cross-run persisted file.
      expect(existsSync(join(ws, "note.txt"))).toBe(false);
      // The core returns the write tool's AgentToolResult (a small ack), never an error.
      expect(result.error).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("write is RUN-EPHEMERAL: a written file is GONE after the run's cleanupRun", async () => {
    const ws = makeWorkspace();
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      await cores.fileExecutors.write(
        { path: "summary.md", content: "# Findings" },
        { workspaceDir: ws, runId: RUN_ID },
      );
      await cores.fileExecutors.write(
        { path: "concurrent.md", content: "# Concurrent" },
        { workspaceDir: ws, runId: "run-2" },
      );
      const written = join(ws, "results", safeResultRunId(RUN_ID), "writes", "summary.md");
      const concurrent = join(ws, "results", safeResultRunId("run-2"), "writes", "concurrent.md");
      expect(existsSync(written)).toBe(true); // present DURING the run
      expect(existsSync(concurrent)).toBe(true);

      // Reap the run with the REAL store teardown (the same cleanupRun the
      // orchestrate runner calls on run end) — NOT a test-local rmSync. This is
      // the ground-truth ephemerality proof: the write lives under results/,
      // which cleanupRun wipes wholesale.
      const store = createResultRefStore({ logger: makeLogger() });
      await store.cleanupRun({ workspacePath: ws, runId: RUN_ID });

      expect(existsSync(written)).toBe(false); // GONE after the run ends
      expect(existsSync(concurrent)).toBe(true); // another run's root is untouched
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("write CANNOT reach the workspace-root skills/ discovery subtree (a ../ escape into skills/ is denied)", async () => {
    const ws = makeWorkspace();
    // The cross-run prompt-injection persistence vector: a write that escapes the
    // run-scoped root back up into the workspace-root skills/ (the top-priority,
    // live-watched skill-discovery path). safePath must refuse it BEFORE any write.
    const plantedSkill = join(ws, "skills", "x", "SKILL.md");
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = (await cores.fileExecutors.write(
        { path: "../../skills/x/SKILL.md", content: "<attacker skill body>" },
        { workspaceDir: ws, runId: RUN_ID },
      )) as { error?: string };
      expect(result.error).toEqual(expect.stringContaining("escape"));
      // Ground truth: the discovery path is UNTOUCHED — nothing planted.
      expect(existsSync(plantedSkill)).toBe(false);
      expect(existsSync(join(ws, "skills"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("write PRESERVES the distinct failure kind instead of collapsing to 'not writable'", async () => {
    const ws = makeWorkspace();
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      // AGENTS.md is a PROTECTED_WORKSPACE_FILES basename → the shipped write tool
      // throws a prefixed `[protected_file]` error. The core must surface that
      // DISTINCT failure CLASS (so a jailed script trying to recover knows WHY),
      // NOT collapse every write failure to the misleading "not writable" message
      // — while still leaking no host path.
      const result = (await cores.fileExecutors.write(
        { path: "AGENTS.md", content: "x" },
        { workspaceDir: ws, runId: RUN_ID },
      )) as { error?: string };
      expect(result.error).toBeDefined();
      expect(result.error).toContain("protected_file"); // the distinct kind is preserved
      expect(result.error).not.toMatch(/not writable/); // NOT collapsed to the generic message
      // Content-free: the interpolated message tail (which can echo a host path for
      // other kinds) is dropped — only the bracketed enum kind is surfaced.
      expect(result.error).not.toContain(ws);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("write refuses a `..` traversal ({ error }, nothing written outside the workspace, never throws)", async () => {
    const ws = makeWorkspace();
    // The escape target is one level ABOVE the workspace (a writable temp parent):
    // if the confinement failed, the write would create it there — so its ABSENCE
    // is the ground-truth proof that nothing escaped the run workspace.
    const escaped = join(ws, "..", "orch-write-escape-canary.txt");
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.write(
        { path: "../orch-write-escape-canary.txt", content: "escaped" },
        { workspaceDir: ws, runId: RUN_ID },
      );
      expect(result).toEqual({ error: expect.stringContaining("escape") });
      expect(existsSync(escaped)).toBe(false); // nothing written outside the workspace
    } finally {
      rmSync(escaped, { force: true }); // clean up if the confinement ever regressed
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("write refuses an absolute path ({ error }, nothing written to the absolute target)", async () => {
    const ws = makeWorkspace();
    // An absolute path into a sibling temp dir OUTSIDE the workspace: it is
    // writable, so its absence proves the absolute path was denied (not merely
    // unreachable). safePath resolves an absolute segment to itself → escapes.
    const outside = mkdtempSync(join(tmpdir(), "orch-write-abs-"));
    const absTarget = join(outside, "abs-canary.txt");
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.write(
        { path: absTarget, content: "abs" },
        { workspaceDir: ws, runId: RUN_ID },
      );
      expect(result).toEqual({ error: expect.stringContaining("escape") });
      expect(existsSync(absTarget)).toBe(false); // the absolute path was denied
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("jq honest-degrades to an { error } when no path is given (never throws)", async () => {
    const ws = makeWorkspace();
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.jq({ expr: "." }, { workspaceDir: ws });
      expect(result).toEqual({ error: expect.stringContaining("path") });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("jq refuses a path that escapes the workspace ({ error }, no spawn)", async () => {
    const ws = makeWorkspace();
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.jq(
        { path: "../../../etc/passwd", expr: "." },
        { workspaceDir: ws },
      );
      expect(result).toEqual({ error: expect.stringContaining("escape") });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("jq runs the system binary over a workspace-confined results file (or degrades cleanly if jq is absent)", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(join(ws, "results", "r.json"), JSON.stringify([{ id: 1 }, { id: 2 }]), "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.jq(
        { path: "results/r.json", expr: ".[].id" },
        { workspaceDir: ws },
      );
      // jq present on the host → the compact slice "1\n2"; jq absent → a
      // content-free { error } (both are valid outcomes — never a throw).
      if (typeof result === "string") {
        expect(result.replace(/\s+/g, " ").trim()).toBe("1 2");
      } else {
        expect(result).toEqual({ error: expect.stringMatching(/jq/i) });
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // The `sql` (DuckDB-over-CSV/JSONL) core wiring.
  // The dev host has NO duckdb (jq ships with the OS; duckdb does not),
  // so the spawn ENOENT-degrades to { error } errorKind:"precondition" — never a
  // throw, never a silent success. The real DuckDB round-trip is the VPS
  // orchestrate-jail.linux.test.ts.
  // -------------------------------------------------------------------------

  it("sql honest-degrades to an { error } when no path is given (never throws)", async () => {
    const ws = makeWorkspace();
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.sql({ query: "SELECT 1" }, { workspaceDir: ws });
      expect(result).toEqual({ error: expect.stringContaining("path") });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("sql refuses a path that escapes the workspace ({ error }, no spawn)", async () => {
    const ws = makeWorkspace();
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.sql(
        { path: "../../../etc/passwd", query: "SELECT * FROM read_json_auto('x')" },
        { workspaceDir: ws },
      );
      expect(result).toEqual({ error: expect.stringContaining("escape") });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("sql honest-degrades when duckdb is absent (precondition, never a throw)", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(
        join(ws, "results", "rows.jsonl"),
        '{"id":1,"price":150}\n{"id":2,"price":50}\n',
        "utf8",
      );
      const { logger, child } = makeLoggerWithCapture();
      const cores = createOrchestrateExecutorCores({ logger });
      const result = await cores.fileExecutors.sql(
        { path: "results/rows.jsonl", query: "SELECT id FROM read_json_auto('results/rows.jsonl')" },
        { workspaceDir: ws },
      );
      // duckdb present on the host → a JSON-rows slice (string); duckdb absent →
      // a content-free { error } naming duckdb with errorKind:"precondition".
      // The dev host (and CI) has no duckdb, so the precondition branch fires.
      if (typeof result === "string") {
        // (VPS / a host with duckdb installed) — the slice is the JSON rows.
        expect(result).toMatch(/id/);
      } else {
        expect(result).toEqual({ error: expect.stringMatching(/duckdb/i) });
        // The degrade is logged as a precondition (unmet host prerequisite), not
        // a validation error — mirrors the jq ENOENT branch.
        const preconditionWarn = child.warn.mock.calls.find(
          ([fields]) => (fields as { errorKind?: string })?.errorKind === "precondition",
        );
        expect(preconditionWarn, "expected a precondition WARN on the duckdb-absent path").toBeDefined();
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("routes web_search to the shipped multi-provider tool and returns its result", async () => {
    // The web_search core forwards args to the SHIPPED createWebSearchTool. Pin a
    // single provider with NO configured API key so the shipped tool's own
    // missing-key guard short-circuits to a deterministic `all_providers_failed`
    // result with NO network call — the honest "no creds" outcome, returned as a
    // content block. The assertion is on the ROUTING (the core executed the tool
    // and handed its content-shaped result back), not on a live search.
    const cores = createOrchestrateExecutorCores({
      logger: makeLogger(),
      webSearchConfig: { provider: "brave" },
    });
    const result = (await cores.webSearch(
      { query: "comis orchestrate" },
      { agentId: "agent-1" },
    )) as { content: { type: string; text?: string }[] };

    expect(Array.isArray(result.content)).toBe(true);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    // No key → the shipped tool reports all_providers_failed (brave named). This
    // proves the core ran the real web-search tool and returned its output.
    expect(text).toContain("all_providers_failed");
    expect(text).toContain("brave");
  });
});

// ---------------------------------------------------------------------------
// DuckDB hardening + jsonpath-without-eval (the security core).
// Written RED-first per AGENTS.md §2.10: without the `rejectDangerousSql`
// guard, a malicious query reaches execFile (asserted absent here).
// ---------------------------------------------------------------------------

describe("sql core — DuckDB hardening: rejects extension/file-write/network verbs before spawn", () => {
  // Each malicious query MUST be refused with errorKind:"validation" and MUST
  // NOT spawn duckdb (the SSRF/exfil floor — the un-jailed daemon-side DuckDB
  // can never be coerced into a remote fetch / file write / extension install).
  const MALICIOUS: ReadonlyArray<readonly [string, string]> = [
    ["INSTALL httpfs", "INSTALL httpfs; SELECT * FROM read_json_auto('results/r.jsonl')"],
    ["LOAD httpfs", "LOAD httpfs; SELECT 1"],
    ["ATTACH", "ATTACH 'x.db' AS x; SELECT * FROM x.t"],
    ["COPY ... TO", "COPY (SELECT 1) TO 'out.csv'"],
    ["EXPORT DATABASE", "EXPORT DATABASE 'd'"],
    ["http:// reader", "SELECT * FROM read_csv('http://evil/x.csv')"],
    ["https:// reader", "SELECT * FROM read_json_auto('https://evil/x.json')"],
    ["s3:// reader", "SELECT * FROM read_parquet('s3://evil/x.parquet')"],
  ];

  for (const [label, query] of MALICIOUS) {
    it(`rejects \`${label}\` with errorKind:validation and NEVER spawns duckdb`, async () => {
      const ws = makeWorkspace();
      try {
        mkdirSync(join(ws, "results"), { recursive: true });
        writeFileSync(join(ws, "results", "r.jsonl"), '{"id":1}\n', "utf8");
        const { logger, child } = makeLoggerWithCapture();
        const cores = createOrchestrateExecutorCores({ logger });
        const result = await cores.fileExecutors.sql(
          { path: "results/r.jsonl", query },
          { workspaceDir: ws },
        );
        // Refused as an { error } (never a throw, never a silent success).
        expect(result).toEqual({ error: expect.stringMatching(/reject|not allowed/i) });
        // Refused BEFORE any spawn — duckdb is never invoked for a malicious query.
        expect(execFileSpy).not.toHaveBeenCalled();
        // Classified as a validation error (bad input), not a precondition.
        const validationWarn = child.warn.mock.calls.find(
          ([fields]) => (fields as { errorKind?: string })?.errorKind === "validation",
        );
        expect(validationWarn, "expected a validation WARN on the rejected query").toBeDefined();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  it("ALLOWS a benign read-only SELECT through to duckdb (does not over-block)", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(join(ws, "results", "r.jsonl"), '{"id":1,"price":150}\n', "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.sql(
        { path: "results/r.jsonl", query: "SELECT id FROM read_json_auto('results/r.jsonl') WHERE price > 100" },
        { workspaceDir: ws },
      );
      // A benign query passes the screen → reaches duckdb (spawned exactly once).
      // duckdb is absent on the dev host → precondition degrade; present → slice.
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      if (typeof result !== "string") {
        expect(result).toEqual({ error: expect.stringMatching(/duckdb/i) });
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Local-file exfil confinement (CRITICAL): a `sql` core that ran the model
// query VERBATIM against duckdb with only a keyword denylist would be
// exfiltrable — DuckDB's local-file table functions
// (read_text/read_blob/glob/getenv) read an ARBITRARY absolute host path with
// none of the denied keywords and no url-scheme, so a model query like
// `SELECT * FROM read_text('/home/<user>/.comis/config.yaml')` exfils daemon
// secrets. The core therefore CONFINES the daemon-side duckdb to the run's
// workspace via `SET allowed_directories=['<ws>']; SET
// enable_external_access=false; SET lock_configuration=true;` (set BEFORE the
// model query so it cannot widen them) AND spawns duckdb with cwd=<ws> so a
// workspace-relative `results/...` read still resolves. Defense-in-depth: the
// pure-exfil readers that have NO tabular-query purpose
// (read_text/read_blob/glob/getenv/parquet_metadata/parquet_schema) are ALSO
// keyword-rejected before spawn.
// ---------------------------------------------------------------------------

describe("sql core — local-file exfil confinement", () => {
  // The pure-exfil readers have no legitimate tabular-query use over a
  // results/ ResultRef (the contract only ever uses read_json_auto/read_csv/
  // read_parquet). They read raw bytes / enumerate dirs / read env from an
  // ARBITRARY absolute host path — refuse them BEFORE any spawn (belt-and-
  // suspenders with the allowed_directories confinement below).
  const EXFIL_READERS: ReadonlyArray<readonly [string, string]> = [
    ["read_text(/etc/passwd)", "SELECT * FROM read_text('/etc/passwd')"],
    ["read_text(/proc/self/environ)", "SELECT content FROM read_text('/proc/self/environ')"],
    ["read_blob(host config)", "SELECT * FROM read_blob('/home/x/.comis/config.yaml')"],
    ["glob(dir enumeration)", "SELECT * FROM glob('/home/x/.comis/*')"],
    ["getenv(daemon env)", "SELECT getenv('ANTHROPIC_API_KEY')"],
    ["parquet_metadata", "SELECT * FROM parquet_metadata('/etc/shadow')"],
    ["parquet_schema", "SELECT * FROM parquet_schema('/etc/shadow')"],
  ];

  for (const [label, query] of EXFIL_READERS) {
    it(`refuses \`${label}\` before spawn (no duckdb, { error })`, async () => {
      const ws = makeWorkspace();
      try {
        mkdirSync(join(ws, "results"), { recursive: true });
        writeFileSync(join(ws, "results", "r.jsonl"), '{"id":1}\n', "utf8");
        const { logger, child } = makeLoggerWithCapture();
        const cores = createOrchestrateExecutorCores({ logger });
        const result = await cores.fileExecutors.sql({ path: "results/r.jsonl", query }, { workspaceDir: ws });
        // The exfil reader is refused as a content-free { error } (never a throw).
        expect(result).toEqual({ error: expect.stringMatching(/reject|not allowed/i) });
        // Refused BEFORE any spawn — the pure-exfil reader never reaches duckdb.
        expect(execFileSpy).not.toHaveBeenCalled();
        const validationWarn = child.warn.mock.calls.find(
          ([fields]) => (fields as { errorKind?: string })?.errorKind === "validation",
        );
        expect(validationWarn, "expected a validation WARN on the refused exfil reader").toBeDefined();
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  it("confines the daemon-side duckdb to the workspace: prelude sets allowed_directories + external-access-off + lock, BEFORE the model query, and spawns with cwd=<workspace>", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(join(ws, "results", "r.jsonl"), '{"id":1,"price":150}\n', "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      // A legitimate tabular read over the confined ResultRef — passes the screen
      // and reaches duckdb (spawned once). allowed_directories keeps it readable.
      const modelQuery = "SELECT id FROM read_json_auto('results/r.jsonl') WHERE price > 100";
      await cores.fileExecutors.sql({ path: "results/r.jsonl", query: modelQuery }, { workspaceDir: ws });
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      const call = execFileSpy.mock.calls[0] as [string, string[], Record<string, unknown>];
      const [bin, argv, opts] = call;
      expect(bin).toBe("duckdb");
      const cIdx = argv.indexOf("-c");
      const sqlText = argv[cIdx + 1] as string;
      // The confinement settings are present, name the workspace as the only
      // allowed read root, and disable + lock all other external access.
      expect(sqlText).toContain("enable_external_access=false");
      expect(sqlText).toContain("lock_configuration=true");
      expect(sqlText).toContain("allowed_directories=");
      expect(sqlText).toContain(ws); // the run's workspace abs path is the allow-root
      // The lockdown MUST precede the (untrusted) model query so it cannot widen
      // allowed_directories or re-enable external access from inside its own SQL.
      const lockIdx = sqlText.indexOf("lock_configuration=true");
      const modelIdx = sqlText.indexOf(modelQuery);
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(modelIdx).toBeGreaterThan(lockIdx);
      // allowed_directories is set BEFORE external-access is disabled (so the
      // allow-root carve-out registers while config is still mutable).
      expect(sqlText.indexOf("allowed_directories=")).toBeLessThan(
        sqlText.indexOf("enable_external_access=false"),
      );
      // duckdb is spawned with cwd=<workspace> so a workspace-relative
      // `results/...` read resolves inside the allow-root (not the daemon cwd).
      expect(opts.cwd).toBe(ws);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("scrubs absolute host paths out of a duckdb non-zero-exit error before it crosses the jail boundary", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(join(ws, "results", "r.jsonl"), '{"id":1}\n', "utf8");
      // Simulate duckdb present but exiting non-zero with a diagnostic that echoes
      // an absolute host path (DuckDB does this on a failed read). The error
      // returned to the jailed client MUST NOT contain the host path.
      execFileSpy.mockImplementationOnce((...args: unknown[]) => {
        const cb = args[args.length - 1] as (e: unknown, o: string, s: string) => void;
        const err = Object.assign(new Error("Command failed"), { code: 1 });
        cb(err, "", "IO Error: No files found that match '/home/secret-user/.comis/config.yaml'");
        return undefined as never;
      });
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = (await cores.fileExecutors.sql(
        { path: "results/r.jsonl", query: "SELECT id FROM read_json_auto('results/r.jsonl')" },
        { workspaceDir: ws },
      )) as { error: string };
      expect(result.error).toMatch(/duckdb error/i);
      // The absolute host path is scrubbed; the daemon's filesystem layout never
      // leaks into the jailed client's error.
      expect(result.error).not.toContain("/home/secret-user/.comis/config.yaml");
      expect(result.error).toContain("<path>");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("a secret host file OUTSIDE the workspace is not exfiltrated (refused/confined; secret absent from result)", async () => {
    const ws = makeWorkspace();
    // A secret file in a sibling temp dir OUTSIDE the workspace allow-root.
    const secretDir = mkdtempSync(join(tmpdir(), "orch-secret-"));
    const secret = "TOP-SECRET-EXFIL-CANARY-7f3a9";
    writeFileSync(join(secretDir, "secret.txt"), secret, "utf8");
    const secretPath = join(secretDir, "secret.txt");
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(join(ws, "results", "r.jsonl"), '{"id":1}\n', "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      // The model tries to read the out-of-workspace secret via read_text.
      const result = await cores.fileExecutors.sql(
        { path: "results/r.jsonl", query: `SELECT content FROM read_text('${secretPath}')` },
        { workspaceDir: ws },
      );
      // Whatever the outcome (keyword-refused here; allowed_directories-refused on
      // a host with duckdb), the secret string MUST NOT appear in the result.
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });
});

describe("rejectDangerousSql (pure guard)", () => {
  it("returns a reason for each disallowed verb + url-reader, null for a benign SELECT", () => {
    for (const q of [
      "INSTALL httpfs",
      "load httpfs",
      "ATTACH 'x.db'",
      "COPY t TO 'o.csv'",
      "EXPORT DATABASE 'd'",
      "IMPORT DATABASE 'd'",
      "PRAGMA database_list",
      "SELECT * FROM read_csv('http://e/x')",
      "SELECT * FROM read_json_auto('https://e/x')",
      "SELECT * FROM read_parquet('s3://e/x')",
    ]) {
      expect(rejectDangerousSql(q), `expected ${q} rejected`).not.toBeNull();
    }
    // A column named INSTALLED_AT must NOT trip the whole-word INSTALL match.
    expect(rejectDangerousSql("SELECT installed_at FROM read_json_auto('results/r.jsonl')")).toBeNull();
    expect(rejectDangerousSql("SELECT id, price FROM read_json_auto('results/r.jsonl') WHERE price > 100")).toBeNull();
  });

  it("rejects the pure-exfil local-file readers (read_text/read_blob/glob/getenv/parquet_metadata)", () => {
    for (const q of [
      "SELECT * FROM read_text('/etc/passwd')",
      "select content from READ_TEXT('/proc/self/environ')",
      "SELECT * FROM read_blob('/home/x/.comis/config.yaml')",
      "SELECT * FROM glob('/home/x/.comis/*')",
      "SELECT getenv('ANTHROPIC_API_KEY')",
      "SELECT * FROM parquet_metadata('/etc/shadow')",
      "SELECT * FROM parquet_schema('/etc/shadow')",
    ]) {
      expect(rejectDangerousSql(q), `expected ${q} rejected (exfil reader)`).not.toBeNull();
    }
  });

  it("still ALLOWS the legitimate tabular readers the contract uses (read_json_auto/read_csv/read_parquet/read_json/read_ndjson) — confined by allowed_directories, not keyword-blocked", () => {
    for (const q of [
      "SELECT * FROM read_json_auto('results/r.jsonl')",
      "SELECT * FROM read_csv('results/r.csv')",
      "SELECT * FROM read_csv_auto('results/r.csv')",
      "SELECT * FROM read_parquet('results/r.parquet')",
      "SELECT * FROM read_json('results/r.json')",
      "SELECT * FROM read_ndjson('results/r.ndjson')",
      "SELECT * FROM parquet_scan('results/r.parquet')",
    ]) {
      expect(rejectDangerousSql(q), `expected ${q} allowed (legitimate tabular reader)`).toBeNull();
    }
  });
});

describe("jsonpath core: DuckDB json_extract, NO eval lib", () => {
  it("compiles a $-dot/bracket expr into a json_extract query over read_json_auto", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(
        join(ws, "results", "doc.json"),
        JSON.stringify({ items: [{ price: 42 }, { price: 7 }] }),
        "utf8",
      );
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      const result = await cores.fileExecutors.jsonpath(
        { path: "results/doc.json", expr: "$.items[0].price" },
        { workspaceDir: ws },
      );
      // The core spawned duckdb exactly once with a json_extract query carrying
      // the exact expr (asserted on the spy's argv), then returned the slice (or
      // the precondition degrade on a duckdb-less host).
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      const [bin, argv] = execFileSpy.mock.calls[0] as [string, string[]];
      expect(bin).toBe("duckdb");
      const cFlagIdx = argv.indexOf("-c");
      const sqlText = argv[cFlagIdx + 1];
      expect(sqlText).toContain("json_extract");
      expect(sqlText).toContain("$.items[0].price");
      expect(sqlText).toContain("read_json_auto(");
      if (typeof result !== "string") {
        expect(result).toEqual({ error: expect.stringMatching(/duckdb/i) });
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe jsonpath expr (wildcard / SQL metacharacters) and NEVER spawns duckdb", async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(join(ws, "results"), { recursive: true });
      writeFileSync(join(ws, "results", "doc.json"), "{}", "utf8");
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      for (const expr of [
        "$.items[*]", // wildcard — unsupported
        "$.a'; DROP TABLE t; --", // quote/metacharacter injection
        "items[0]", // not $-rooted
        "$..price", // recursive descent — unsupported
      ]) {
        execFileSpy.mockClear();
        const result = await cores.fileExecutors.jsonpath(
          { path: "results/doc.json", expr },
          { workspaceDir: ws },
        );
        expect(result, `expr ${expr} should be rejected`).toEqual({
          error: expect.stringMatching(/jsonpath/i),
        });
        // The unsafe expr never reaches duckdb (it cannot inject into json_extract).
        expect(execFileSpy, `expr ${expr} must not spawn duckdb`).not.toHaveBeenCalled();
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("escapes a single quote in the workspace path so it cannot break out of the SQL literal", async () => {
    // The workspace dir is <dataDir>/workspace-<agentId>; agentId is only
    // z.string().min(1) (no charset limit), so a data-dir / agent-id containing a
    // single quote is reachable. safePath confines the LOCATION but does not
    // escape SQL metacharacters — the jsonpath core interpolates absPath into a
    // single-quoted read_json_auto('...') literal, so an unescaped quote would
    // break out into injectable SQL. Use a workspace dir whose name carries a
    // quote and assert the generated SQL DOUBLES it (SQL string-literal escaping),
    // never leaving a lone quote that closes the literal early.
    const wsParent = mkdtempSync(join(tmpdir(), "orch-quote-"));
    const ws = join(wsParent, "workspace-x'or'1");
    mkdirSync(join(ws, "results"), { recursive: true });
    writeFileSync(join(ws, "results", "doc.json"), JSON.stringify({ a: 1 }), "utf8");
    try {
      const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
      await cores.fileExecutors.jsonpath(
        { path: "results/doc.json", expr: "$.a" },
        { workspaceDir: ws },
      );
      expect(execFileSpy).toHaveBeenCalledTimes(1);
      const [, argv] = execFileSpy.mock.calls[0] as [string, string[]];
      const sqlText = argv[argv.indexOf("-c") + 1] as string;
      // Isolate the read_json_auto('...') literal and assert the path inside it
      // has every single quote doubled (no lone quote that would close it early).
      const m = sqlText.match(/read_json_auto\('((?:[^']|'')*)'\)/);
      expect(m, "expected a well-formed read_json_auto('...') literal").not.toBeNull();
      const inside = m![1]!;
      // The raw path's single quotes must appear DOUBLED in the literal body.
      expect(inside).toContain("workspace-x''or''1");
      // And the body must contain no UN-doubled quote (every ' is part of a '').
      expect(inside.replace(/''/g, "")).not.toContain("'");
    } finally {
      rmSync(wsParent, { recursive: true, force: true });
    }
  });
});

describe("isSafeJsonPath (pure guard)", () => {
  it("accepts $-rooted dot/bracket paths, rejects wildcards/filters/metacharacters", () => {
    for (const ok of ["$", "$.a", "$.items[0].price", "$['a']['b']", '$["a"][0]']) {
      expect(isSafeJsonPath(ok), `expected ${ok} accepted`).toBe(true);
    }
    for (const bad of ["$.items[*]", "$..price", "items[0]", "$.a'; DROP TABLE t; --", "$.a[?(@.x>1)]"]) {
      expect(isSafeJsonPath(bad), `expected ${bad} rejected`).toBe(false);
    }
  });
});
