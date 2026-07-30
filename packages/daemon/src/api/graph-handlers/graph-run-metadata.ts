// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync } from "node:fs";
import { safePath } from "@comis/core";
import { tryCatch } from "@comis/shared";
import type { GraphHandlerDeps } from "./graph-helpers.js";

export type TerminalGraphMetadata =
  | { kind: "absent" }
  | { kind: "invalid" }
  | {
    kind: "valid";
    status: "completed" | "failed";
    nodeIds: string[];
  };

const MAX_RUN_METADATA_BYTES = 1_048_576;

export function readTerminalGraphMetadata(
  deps: GraphHandlerDeps,
  graphId: string,
  files: readonly string[],
): TerminalGraphMetadata {
  if (!deps.dataDir || !files.includes("_run-metadata.json")) return { kind: "absent" };
  const loaded = tryCatch(() => {
    const metadataPath = safePath(deps.dataDir!, "graph-runs", graphId, "_run-metadata.json");
    const stat = lstatSync(metadataPath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.size > MAX_RUN_METADATA_BYTES
    ) {
      return undefined;
    }
    return JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
  });
  const value = loaded.ok ? loaded.value : undefined;
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    deps.logger?.warn(
      {
        graphId,
        errorKind: "validation" as const,
        hint: "Inspect graph-runs/<graphId>/_run-metadata.json and restore a valid terminal record",
      },
      "Graph run metadata is invalid",
    );
    return { kind: "invalid" };
  }
  const metadata = value as Record<string, unknown>;
  const status = metadata.status;
  const nodes = metadata.nodes;
  if (
    (status !== "completed" && status !== "failed")
    || typeof nodes !== "object"
    || nodes === null
    || Array.isArray(nodes)
  ) {
    deps.logger?.warn(
      {
        graphId,
        errorKind: "validation" as const,
        hint: "Inspect graph-runs/<graphId>/_run-metadata.json and restore a valid terminal record",
      },
      "Graph run metadata is invalid",
    );
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    status,
    nodeIds: Object.keys(nodes),
  };
}
