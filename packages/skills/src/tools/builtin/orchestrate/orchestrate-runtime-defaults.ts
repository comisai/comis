// SPDX-License-Identifier: Apache-2.0
/** Runtime defaults shared by the live orchestrate runner and replay runner. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { createToolResultSizeGuard } from "@comis/agent";
import { safePath } from "@comis/core";

import {
  resolveJailAgentCli,
  resolveJailNode,
  resolveJailPython,
  SYSTEM_RO_PATHS,
} from "../sandbox/bwrap-provider.js";
import type {
  JailAgentCliResolution,
  JailNodeResolution,
  JailPythonResolution,
} from "../sandbox/types.js";
import type {
  OrchestrateSpawnFn,
  OrchestrateSpawnedChild,
} from "./orchestrate-repair.js";

const COMIS_AGENT_ENTRY_FILENAME = "comis-agent-entry.js";
const COMIS_AGENT_MANIFEST_FILENAME = "comis-agent-manifest.json";
const STDOUT_MAX_CHARS = 30_000;

interface TextBlock {
  type: "text";
  text: string;
}

/** Size-bounce raw stdout into bounded text content. */
export function sizeBounceStdout(stdout: string): TextBlock[] {
  const result = createToolResultSizeGuard().truncateIfNeeded(
    [{ type: "text", text: stdout }],
    STDOUT_MAX_CHARS,
    "orchestrate stdout",
  );
  return result.content.map((block) => ({
    type: "text" as const,
    text: block.text ?? "",
  }));
}

/** Real child-process spawn used when no test seam is injected. */
export const defaultSpawn: OrchestrateSpawnFn = (bin, args, opts) =>
  spawn(bin, args, {
    env: opts.env,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as OrchestrateSpawnedChild;

/** Resolve the Node runtime reachable from inside the jail. */
export function defaultResolveJailNode(): JailNodeResolution {
  return resolveJailNode({ pathDirs: SYSTEM_RO_PATHS, execPath: process.execPath });
}

/** Resolve an absolute Python interpreter path that is reachable in the jail. */
export function defaultResolveJailPython(): JailPythonResolution {
  return resolveJailPython({
    interpreterPaths: ["/usr/bin/python3", "/bin/python3", "/usr/local/bin/python3"],
  });
}

/** Resolve and verify the read-only comis-agent CLI bound into the jail. */
export function defaultResolveJailAgentCli(assetDir: string): JailAgentCliResolution {
  const manifestPath = safePath(assetDir, COMIS_AGENT_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return {
      mode: "unavailable",
      hint:
        "The comis-agent manifest is missing from the skills dist. Rebuild so the manifest and entry are copied into dist.",
    };
  }

  let expectedSha: string;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { sha256?: unknown };
    if (typeof parsed.sha256 !== "string" || parsed.sha256.length === 0) {
      return {
        mode: "unavailable",
        hint: "The comis-agent manifest has no sha256 pin. Regenerate the agent CLI manifest.",
      };
    }
    expectedSha = parsed.sha256;
  } catch {
    return {
      mode: "unavailable",
      hint: "The comis-agent manifest could not be parsed. Regenerate the agent CLI manifest.",
    };
  }

  return resolveJailAgentCli({
    binPath: safePath(assetDir, COMIS_AGENT_ENTRY_FILENAME),
    expectedSha,
  });
}
