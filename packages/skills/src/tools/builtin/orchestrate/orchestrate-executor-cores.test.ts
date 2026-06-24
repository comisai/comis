// SPDX-License-Identifier: Apache-2.0
/**
 * `orchestrate-executor-cores` — the shipped daemon-side `tool.invoke` executor
 * cores (Plan 05). Asserts: the file cores run under the lease's workspaceDir
 * (a `read` returns the file content), the `jq` core confines its path under the
 * workspace + honest-degrades (missing path / traversal escape / non-zero exit)
 * to an `{ error }` shape (never a throw), and `web_search` routes to the shipped
 * tool. The real in-jail jq-over-ResultRef round-trip is the VPS-deferred
 * `orchestrate-jail.linux.test.ts`; here we assert the wiring + confinement.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComisLogger } from "@comis/core";
import { createOrchestrateExecutorCores } from "./orchestrate-executor-cores.js";

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

describe("createOrchestrateExecutorCores", () => {
  it("exposes the 7 file cores (read/grep/find/ls/jq/sql/jsonpath) + a web_search core", () => {
    const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
    expect(Object.keys(cores.fileExecutors).sort()).toEqual(
      ["find", "grep", "jq", "jsonpath", "ls", "read", "sql"],
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
      // content-free { error } (both are valid M1 outcomes — never a throw).
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
  // QRY-01: the `sql` (DuckDB-over-CSV/JSONL) core — Task 1 wiring skeleton.
  // The dev host has NO duckdb (CLAUDE.md: jq is at /usr/bin/jq, duckdb is not),
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

  it("sql refuses a path that escapes the workspace ({ error }, no spawn) — T-221-QRY-02", async () => {
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
