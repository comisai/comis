// SPDX-License-Identifier: Apache-2.0
/**
 * Discovery stage of `comis config tooling-fill`.
 *
 * Loads the config file (raw + JS view + AST), enumerates hint entries from
 * `tooling.{mcp,skills}.capabilityHints`, applies the --all stub-only filter,
 * and runs the single-hint idempotency check.
 *
 * Returns a `DiscoverOutcome` with either a `bail` exit (early-return) or
 * the surviving hint entries + the parsed Document + raw YAML to pass to
 * the fill/verify stages.
 *
 * Pure of process I/O — only fs.readFileSync, yaml.parseDocument, and
 * `@comis/core`'s loadConfigFile.
 *
 * @module
 */
import * as fs from "node:fs";
import { parseDocument, isMap, isPair, isScalar, type Document } from "yaml";
import { ok, err, type Result } from "@comis/shared";
import { loadConfigFile } from "@comis/core";
import { isStubValued, type HintShape } from "../validators.js";
import type { FillKind } from "../apply-hint.js";
import type {
  HintEntry,
  OrchestratorOpts,
  OrchestratorResult,
} from "./orchestrator-types.js";

/**
 * Result of the discover phase. Either a bail with a concrete OrchestratorResult
 * (early-return — e.g., file unreadable, idempotency refusal, --all with no
 * stubs) or a `continue` with the parsed Document + raw YAML + surviving
 * entries to hand off to the fill phase.
 */
export type DiscoverOutcome =
  | { readonly kind: "bail"; readonly result: OrchestratorResult }
  | {
      readonly kind: "continue";
      readonly doc: Document;
      readonly rawYaml: string;
      readonly configJs: Record<string, unknown>;
      readonly entries: readonly HintEntry[];
    };

/**
 * Top-level discover entry. Validates args, reads + parses the config, and
 * runs both the --all filter and the single-hint idempotency refusal.
 */
export function discoverTools(opts: OrchestratorOpts): DiscoverOutcome {
  // ---- Validate args ----------------------------------------------------
  if (!opts.all && opts.hintName === undefined) {
    return {
      kind: "bail",
      result: {
        exitCode: 1,
        summary: "<hint-name> is required unless --all is passed.",
      },
    };
  }

  // ---- Load config (raw + JS view + AST) -------------------------------
  let rawYaml: string;
  try {
    rawYaml = fs.readFileSync(opts.configPath, "utf-8");
  } catch (e) {
    return {
      kind: "bail",
      result: {
        exitCode: 1,
        summary: `Failed to read ${opts.configPath}: ${(e as Error).message}`,
      },
    };
  }

  const loaded = loadConfigFile(opts.configPath);
  if (!loaded.ok) {
    return {
      kind: "bail",
      result: {
        exitCode: 1,
        summary: `Failed to load ${opts.configPath}: ${loaded.error.message}`,
      },
    };
  }
  const configJs = loaded.value as Record<string, unknown>;

  let doc: Document;
  try {
    doc = parseDocument(rawYaml);
    if (doc.errors.length > 0) {
      return {
        kind: "bail",
        result: {
          exitCode: 1,
          summary: `Invalid YAML in ${opts.configPath}: ${doc.errors
            .map((er) => er.message)
            .join("; ")}`,
        },
      };
    }
  } catch (e) {
    return {
      kind: "bail",
      result: {
        exitCode: 1,
        summary: `Failed to parse ${opts.configPath}: ${String(e)}`,
      },
    };
  }

  // ---- Resolve hint(s) to fill -----------------------------------------
  const resolved = resolveHints(doc, opts);
  if (!resolved.ok) {
    return { kind: "bail", result: { exitCode: 1, summary: resolved.error } };
  }
  let entries = resolved.value;

  // For --all: filter to stub-valued unless --force.
  if (opts.all && !opts.force) {
    entries = entries.filter((e) => isStubValued(e.current));
  }

  if (entries.length === 0) {
    return {
      kind: "bail",
      result: {
        exitCode: 0,
        summary: opts.all
          ? "(nothing to fill — no stub-valued hints found)"
          : "(nothing to fill)",
      },
    };
  }

  // ---- Idempotency check (single-hint mode) ----------------------------
  // For single-hint mode, refuse if non-stub AND not --force. (--all does
  // its own silent skip above.)
  if (!opts.all && !opts.force) {
    const onlyEntry = entries[0]!;
    if (!isStubValued(onlyEntry.current)) {
      const desc = onlyEntry.current.description ?? "";
      const pkgs = onlyEntry.current.replacesPackages ?? [];
      return {
        kind: "bail",
        result: {
          exitCode: 1,
          summary: `${onlyEntry.name}: already filled (description: "${desc}", replacesPackages: [${pkgs.length} items]). Use --force to overwrite.`,
        },
      };
    }
  }

  return { kind: "continue", doc, rawYaml, configJs, entries };
}

/**
 * Inspect both `tooling.mcp.capabilityHints` and `tooling.skills.capabilityHints`
 * and produce the list of hints to operate on.
 *
 * Single-hint mode: resolves <name> via map containment. If both maps
 * contain the key, requires `--kind` (returns err otherwise).
 *
 * --all mode: every hint across both maps. Idempotency filtering happens
 * downstream (caller filters by isStubValued unless --force).
 */
function resolveHints(
  doc: Document,
  opts: OrchestratorOpts,
): Result<HintEntry[], string> {
  const mcpHints = readHintMap(doc, ["tooling", "mcp", "capabilityHints"]);
  const skillHints = readHintMap(doc, [
    "tooling",
    "skills",
    "capabilityHints",
  ]);
  const mcpCommands = readMcpCommands(doc);
  const skillDescriptions = readSkillDescriptions(doc);

  if (opts.all) {
    const out: HintEntry[] = [];
    for (const [name, hint] of mcpHints) {
      out.push({
        name,
        kind: "mcp",
        current: hint,
        mcpCommand: mcpCommands.get(name),
      });
    }
    for (const [name, hint] of skillHints) {
      out.push({
        name,
        kind: "skills",
        current: hint,
        skillDescription: skillDescriptions.get(name),
      });
    }
    return ok(out);
  }

  const name = opts.hintName!;
  const inMcp = mcpHints.has(name);
  const inSkills = skillHints.has(name);
  if (!inMcp && !inSkills) {
    return err(
      `Hint not found: "${name}". Run "comis config sync-tooling --write" first to materialize the stub.`,
    );
  }
  let kind: FillKind;
  if (opts.kindHint !== undefined) {
    kind = opts.kindHint;
    if (kind === "mcp" && !inMcp) {
      return err(`Hint "${name}" not found under tooling.mcp.capabilityHints`);
    }
    if (kind === "skills" && !inSkills) {
      return err(
        `Hint "${name}" not found under tooling.skills.capabilityHints`,
      );
    }
  } else if (inMcp && inSkills) {
    return err(
      `Ambiguous hint name "${name}" — present under both mcp and skills. Pass --kind mcp|skills to disambiguate.`,
    );
  } else {
    kind = inMcp ? "mcp" : "skills";
  }

  const current = (kind === "mcp" ? mcpHints : skillHints).get(name)!;
  if (kind === "mcp") {
    return ok([{ name, kind, current, mcpCommand: mcpCommands.get(name) }]);
  }
  return ok([
    { name, kind, current, skillDescription: skillDescriptions.get(name) },
  ]);
}

/**
 * Read a YAMLMap of capabilityHints into a Map<name, HintShape>.
 *
 * Each value is reduced to {description?, replacesPackages?} — the two
 * fields the orchestrator needs to call isStubValued. Other fields
 * (cluster, future fields) are not surfaced here; setHintFields touches
 * them via doc.setIn at known paths.
 */
function readHintMap(
  doc: Document,
  hintMapPath: string[],
): Map<string, HintShape> {
  const out = new Map<string, HintShape>();
  if (!doc.hasIn(hintMapPath)) return out;
  const node = doc.getIn(hintMapPath, true);
  if (!isMap(node)) return out;
  for (const p of node.items) {
    if (!isPair(p)) continue;
    const k = isScalar(p.key) ? p.key.value : p.key;
    if (typeof k !== "string") continue;
    const valueNode = p.value;
    if (!isMap(valueNode)) {
      out.set(k, {});
      continue;
    }
    const desc = readScalarString(valueNode, "description");
    const pkgs = readSeqStrings(valueNode, "replacesPackages");
    out.set(k, {
      description: desc,
      replacesPackages: pkgs,
    });
  }
  return out;
}

/** Read a string scalar from a YAMLMap by key, or undefined if absent/non-string. */
function readScalarString(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- yaml@2.8.4 YAMLMap doesn't expose a public type-narrowing helper for this lookup.
  mapNode: any,
  key: string,
): string | undefined {
  if (!mapNode || typeof mapNode.get !== "function") return undefined;
  const v = mapNode.get(key, true) as unknown;
  if (v === undefined || v === null) return undefined;
  if (isScalar(v)) {
    return typeof v.value === "string" ? v.value : undefined;
  }
  return typeof v === "string" ? v : undefined;
}

/** Read a YAMLSeq of strings from a YAMLMap by key, or undefined if absent. */
function readSeqStrings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- yaml@2.8.4 YAMLMap.
  mapNode: any,
  key: string,
): string[] | undefined {
  if (!mapNode || typeof mapNode.get !== "function") return undefined;
  const v = mapNode.get(key) as unknown;
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return undefined;
}

/**
 * Read `integrations.mcp.servers` and produce a name → "command args..."
 * map for prompt context. Best-effort — silent on malformed entries.
 */
function readMcpCommands(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  const node = doc.getIn(["integrations", "mcp", "servers"], true);
  if (node === undefined || node === null) return out;
  // Use doc.toJSON() at the path for simplicity — not performance-critical.
  const js = doc.getIn(["integrations", "mcp", "servers"]) as unknown;
  if (!Array.isArray(js)) return out;
  for (const srv of js) {
    if (typeof srv !== "object" || srv === null) continue;
    const s = srv as { name?: unknown; command?: unknown; args?: unknown };
    if (typeof s.name !== "string") continue;
    const cmd =
      typeof s.command === "string"
        ? `${s.command}${
            Array.isArray(s.args)
              ? " " + s.args.filter((a) => typeof a === "string").join(" ")
              : ""
          }`
        : undefined;
    if (cmd !== undefined) out.set(s.name, cmd);
  }
  return out;
}

/**
 * Read existing skill manifest descriptions for prompt context. Skills are
 * harder to introspect than MCPs because they live on disk; for the
 * orchestrator's prompt we only need the manifest description if it's
 * already laid down in the existing capability hint (the operator hasn't
 * stubbed it back to TODO yet). For full skills introspection see
 * sync-tooling/discover.ts.
 */
function readSkillDescriptions(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  const hints = readHintMap(doc, ["tooling", "skills", "capabilityHints"]);
  for (const [name, h] of hints) {
    if (
      typeof h.description === "string" &&
      h.description !== "TODO" &&
      h.description !== ""
    ) {
      out.set(name, h.description);
    }
  }
  return out;
}
