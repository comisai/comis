// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry points; Commander catches and formats failures.
/** Installed skill lifecycle commands backed by typed daemon RPC contracts. */

import { readFileSync } from "node:fs";
import {
  SkillsDeleteContract,
  SkillsImportContract,
  SkillsListContract,
} from "@comis/core";
import type { Command } from "commander";
import { callTyped, withClient } from "../client/rpc-client.js";
import { error, info, json, success } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderKeyValue, renderTable } from "../output/table.js";
import { ensureGatewayToken } from "./mcp-token.js";

type SkillScope = "local" | "shared";
type ImportSource = "github" | "archive" | "wellknown" | "registry";

interface CommonOptions {
  readonly agent?: string;
  readonly format?: string;
  readonly scope?: SkillScope;
  readonly token?: string;
}

interface ImportOptions extends CommonOptions {
  readonly source?: ImportSource;
  readonly registry?: string;
  readonly confirm?: boolean;
}

function hashPrefix(contentHash: string | undefined): string {
  return contentHash?.replace(/^sha256:/, "").slice(0, 12) ?? "—";
}

function resolveAutomaticSource(reference: string): ImportSource {
  if (reference.startsWith("wellknown:")) return "wellknown";
  if (reference.startsWith("registry:")) return "registry";
  if (reference.startsWith("http://") || reference.startsWith("https://")) {
    return reference.endsWith(".skill") || reference.endsWith(".zip") ? "archive" : "github";
  }
  return "archive";
}

function registryReference(
  reference: string,
  configuredId: string | undefined,
): { registry: string; ref: string } {
  if (configuredId !== undefined) return { registry: configuredId, ref: reference };
  if (!reference.startsWith("registry:")) {
    throw new Error("Registry imports require --registry <configured-id>");
  }
  const remainder = reference.slice("registry:".length);
  const separator = remainder.indexOf(":");
  if (separator <= 0 || separator === remainder.length - 1) {
    throw new Error("Use registry:<configured-id>:<slug[@version]> or pass --registry");
  }
  return {
    registry: remainder.slice(0, separator),
    ref: remainder.slice(separator + 1),
  };
}

function buildImportRequest(reference: string, options: ImportOptions) {
  const source = options.source ?? resolveAutomaticSource(reference);
  const common = {
    scope: options.scope ?? "local",
    ...(options.agent !== undefined && { agentId: options.agent }),
    ...(options.confirm === true && { force: true }),
  };
  switch (source) {
    case "github":
      return { source, url: reference, ...common } as const;
    case "wellknown":
      return { source, ref: reference, ...common } as const;
    case "registry": {
      const resolved = registryReference(reference, options.registry);
      return { source, ...resolved, ...common } as const;
    }
    case "archive":
      if (reference.startsWith("http://") || reference.startsWith("https://")) {
        return { source, archiveUrl: reference, ...common } as const;
      }
      return {
        source,
        archiveBase64: readFileSync(reference).toString("base64"),
        ...common,
      } as const;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function listInfoPairs(skill: Record<string, unknown>): Array<[string, string]> {
  const evidence = skill["evidence"] as Record<string, unknown> | undefined;
  const counts = skill["findingCounts"] as Record<string, unknown> | undefined;
  return [
    ["Name", String(skill["name"] ?? "—")],
    ["Description", String(skill["description"] ?? "—")],
    ["Location", String(skill["location"] ?? "—")],
    ["Scope", String(skill["scope"] ?? "unknown")],
    ["Source", String(skill["source"] ?? "unknown")],
    ["Reference", String(skill["ref"] ?? "—")],
    ["Trust", String(skill["trust"] ?? "unknown")],
    ["Verdict", String(skill["verdict"] ?? "unknown")],
    ["Content Hash", String(skill["contentHash"] ?? "—")],
    ["Imported At", String(skill["importedAt"] ?? "—")],
    ["Findings", counts === undefined ? "—" : `critical=${counts["critical"] ?? 0}, warn=${counts["warn"] ?? 0}`],
    ["Publisher", String(evidence?.["publisherHandle"] ?? "—")],
    ["Registry Security", String(evidence?.["securityStatus"] ?? "—")],
  ];
}

/** Register `comis skills list|import|remove|info`. */
export function registerSkillsCommand(program: Command): void {
  const skills = program.command("skills").description("Installed skill management");

  skills
    .command("list")
    .description("List installed skills with trust and provenance summaries")
    .option("--agent <agentId>", "Agent whose visible skills should be listed")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token")
    .action(async (options: CommonOptions) => {
      try {
        ensureGatewayToken(options.token);
        const result = await withSpinner("Fetching installed skills...", () =>
          withClient((client) =>
            callTyped(client, SkillsListContract, {
              ...(options.agent !== undefined && { agentId: options.agent }),
            }),
          ),
        );
        if (options.format === "json") {
          json(result);
          return;
        }
        if (result.skills.length === 0) {
          info("No installed skills found");
          return;
        }
        renderTable(
          ["Name", "Scope", "Source", "Trust", "Verdict", "Hash"],
          result.skills.map((skill) => [
            skill.name,
            skill.scope ?? "unknown",
            skill.source ?? "unknown",
            skill.trust ?? "unknown",
            skill.verdict ?? "unknown",
            hashPrefix(skill.contentHash),
          ]),
        );
      } catch (caught) {
        error(`Failed to list skills: ${caught instanceof Error ? caught.message : String(caught)}`);
        process.exit(1);
      }
    });

  skills
    .command("import <reference>")
    .description("Import a GitHub directory, archive, well-known reference, or configured registry skill")
    .option("--source <source>", "Source (github|archive|wellknown|registry)")
    .option("--registry <id>", "Configured registry id")
    .option("--scope <scope>", "Install scope (local|shared)", "local")
    .option("--agent <agentId>", "Calling agent id")
    .option("--confirm", "Confirm a caution verdict or replacement")
    .option("--format <format>", "Output format (text|json)", "text")
    .option("--token <token>", "Gateway token")
    .action(async (reference: string, options: ImportOptions) => {
      try {
        ensureGatewayToken(options.token);
        const request = buildImportRequest(reference, options);
        const result = await withSpinner("Importing skill...", () =>
          withClient((client) => callTyped(client, SkillsImportContract, request)),
        );
        if (options.format === "json") json(result);
        else success(`${result.unchanged === true ? "Already installed" : "Imported"}: ${result.name}`);
      } catch (caught) {
        error(`Failed to import skill: ${caught instanceof Error ? caught.message : String(caught)}`);
        process.exit(1);
      }
    });

  skills
    .command("remove <name>")
    .description("Remove one installed skill")
    .option("--scope <scope>", "Install scope (local|shared)", "local")
    .option("--agent <agentId>", "Calling agent id")
    .option("--token <token>", "Gateway token")
    .action(async (name: string, options: CommonOptions) => {
      try {
        ensureGatewayToken(options.token);
        await withSpinner("Removing skill...", () =>
          withClient((client) =>
            callTyped(client, SkillsDeleteContract, {
              name,
              scope: options.scope ?? "local",
              ...(options.agent !== undefined && { agentId: options.agent }),
            }),
          ),
        );
        success(`Removed: ${name}`);
      } catch (caught) {
        error(`Failed to remove skill: ${caught instanceof Error ? caught.message : String(caught)}`);
        process.exit(1);
      }
    });

  skills
    .command("info <name>")
    .description("Show provenance for one installed skill")
    .option("--agent <agentId>", "Agent whose visible skills should be inspected")
    .option("--format <format>", "Output format (table|json)", "table")
    .option("--token <token>", "Gateway token")
    .action(async (name: string, options: CommonOptions) => {
      try {
        ensureGatewayToken(options.token);
        const result = await withSpinner("Fetching skill provenance...", () =>
          withClient((client) =>
            callTyped(client, SkillsListContract, {
              ...(options.agent !== undefined && { agentId: options.agent }),
            }),
          ),
        );
        const skill = result.skills.find((candidate) => candidate.name === name);
        if (skill === undefined) throw new Error(`Skill not found: ${name}`);
        if (options.format === "json") json(skill);
        else renderKeyValue(listInfoPairs(skill));
      } catch (caught) {
        error(`Failed to inspect skill: ${caught instanceof Error ? caught.message : String(caught)}`);
        process.exit(1);
      }
    });
}
