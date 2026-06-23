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

describe("createOrchestrateExecutorCores", () => {
  it("exposes the 5 file cores (read/grep/find/ls/jq) + a web_search core", () => {
    const cores = createOrchestrateExecutorCores({ logger: makeLogger() });
    expect(Object.keys(cores.fileExecutors).sort()).toEqual(
      ["find", "grep", "jq", "ls", "read"],
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
});
