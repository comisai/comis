// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception). ensureGatewayToken throws a named-env-var error the subcommand's catch converts to error()/process.exit(1).
/**
 * Skill management commands: `comis skills import`.
 *
 * `comis skills import <ref>` imports a skill from a GitHub directory URL
 * (source=github, the default) or an archive URL (source=archive) through the
 * daemon's staged pipeline — the content scan + the MCP Phase-A check run
 * PRE-write, and a successful import is stamped the `imported` trust tier and
 * pinned in the provenance store. The command dispatches `skills.import`
 * through the architecture-mandated typed dispatcher `callTyped(client,
 * SkillsImportContract, params)` inside a `withClient` socket lifetime.
 *
 * Token resolution: `ensureGatewayToken(opts.token)` runs BEFORE the socket
 * opens so a missing gateway token surfaces a friendly error naming
 * `COMIS_GATEWAY_TOKEN` rather than a generic 401 from the handshake. The
 * `--token` flag overrides the env var (read from `~/.comis/.env`).
 *
 * @module
 */

import { SkillsImportContract } from "@comis/core";
import type { Command } from "commander";
import { withClient, callTyped } from "../client/rpc-client.js";
import { success, error, info, json } from "../output/format.js";
import { ensureGatewayToken } from "./mcp-token.js";

interface ImportOptions {
  source?: string;
  registry?: string;
  scope?: string;
  confirm?: boolean;
  format: string;
  token?: string;
}

/**
 * Register the `skills` subcommand group on the program.
 *
 * @param program - The root Commander program.
 */
export function registerSkillsCommand(program: Command): void {
  const skills = program.command("skills").description("Skill management");

  skills
    .command("import <ref>")
    .description(
      "Import a skill from a GitHub directory URL (source=github), an archive URL (source=archive), " +
        "or by name from an allowlisted registry (source=wellknown, --registry <origin>). " +
        "Scanned + Phase-A-checked pre-write; stamped imported.",
    )
    .option(
      "--source <source>",
      "Acquisition channel: github (a directory URL), archive (a .skill/zip/tar URL), " +
        "or wellknown (resolve <ref> as a skill name from --registry). Defaults to github.",
    )
    .option(
      "--registry <registry>",
      "Registry origin (https://host[:port]) to resolve the skill <ref> from — required with --source wellknown. " +
        "Must be allowlisted in skills.import.registries.",
    )
    .option(
      "--scope <scope>",
      "Skill scope: local (this agent's workspace) or shared (all agents; default agent only).",
    )
    .option(
      "--confirm",
      "Confirm a re-import that diverges from the pinned content hash of a prior import of the same source. " +
        "Never overrides a name collision on an unprovenanced or foreign-source skill (delete it first).",
    )
    .option("--format <format>", "Output format (table|json)", "table")
    .option(
      "--token <token>",
      "Gateway token (overrides COMIS_GATEWAY_TOKEN env var). Prefer COMIS_GATEWAY_TOKEN or ~/.comis/.env — a token on the command line is visible via ps/proc and shell history.",
    )
    .action(async (ref: string, options: ImportOptions) => {
      try {
        ensureGatewayToken(options.token);
        const source = options.source;
        const result = await withClient((client) =>
          callTyped(client, SkillsImportContract, {
            // Route <ref> by source: wellknown ⇒ skill name (the registry
            // index-lookup key, resolved from --registry); archive ⇒ archive
            // URL; github/default ⇒ GitHub directory URL.
            ...(source === "wellknown"
              ? { name: ref, ...(options.registry !== undefined && { registry: options.registry }) }
              : source === "archive"
                ? { archiveUrl: ref }
                : { url: ref }),
            ...(source !== undefined && { source: source as "github" | "archive" | "wellknown" }),
            ...(options.scope !== undefined && { scope: options.scope as "local" | "shared" }),
            ...(options.confirm === true && { confirm: true }),
          }),
        );

        if (options.format === "json") {
          json(result);
          return;
        }

        success(`Imported skill "${result.name}" (source: ${result.source})`);
        info(`Path: ${result.path}`);
        info(`Files: ${result.fileCount}`);
        info(`Agent: ${result.resolvedAgentId}`);
      } catch (err) {
        error(`Failed to import skill: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
