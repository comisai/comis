// SPDX-License-Identifier: Apache-2.0
/**
 * Interactive configuration editor command.
 *
 * Provides `comis configure` that lets operators interactively edit
 * configuration sections using Clack prompts driven by field metadata.
 * Uses getFieldMetadata() from @comis/core to discover editable fields
 * and presents type-appropriate prompts (boolean, string, number).
 *
 * @module
 */

import type { Command } from "commander";
import * as p from "@clack/prompts";
import * as fs from "node:fs";
import { Document, parseDocument } from "yaml";
import {
  getConfigSections,
  getFieldMetadata,
  validatePartial,
  loadConfigFile,
} from "@comis/core";
import type { FieldMetadata } from "@comis/core";

/** Default config file path. */
const DEFAULT_CONFIG_PATH = "/etc/comis/config.yaml";

/**
 * Get the current value from a config object at a dot-notation path.
 *
 * @param config - Config object to read from
 * @param dotPath - Dot-notation path (e.g., "gateway.host")
 * @returns The value at the path, or undefined if not found
 */
function getNestedValue(config: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Determine if a field type is editable via simple prompts.
 *
 * Only string, number, and boolean fields are editable interactively.
 * Complex types (object, array, unknown) are skipped.
 */
function isEditableType(type: string): boolean {
  return type === "string" || type === "number" || type === "boolean" || type === "integer";
}

/**
 * Set a value on a YAML Document at a dot-notation path.
 *
 * Uses the yaml library's Document API to set values while
 * preserving existing formatting and comments.
 *
 * @param doc - YAML Document to modify
 * @param dotPath - Dot-notation path (e.g., "gateway.host")
 * @param value - Value to set
 */
function setDocumentValue(doc: Document, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  doc.setIn(parts, value);
}

/**
 * Present the appropriate Clack prompt for a field based on its type.
 *
 * @param field - Field metadata describing the field
 * @param currentValue - Current value of the field (for defaults)
 * @returns The user's input value, or the cancel symbol
 */
async function promptForField(
  field: FieldMetadata,
  currentValue: unknown,
): Promise<unknown> {
  const label = field.description ?? field.path;

  if (field.type === "boolean") {
    return p.confirm({
      message: label,
      initialValue: typeof currentValue === "boolean" ? currentValue : (field.default as boolean | undefined) ?? false,
    });
  }

  if (field.type === "number" || field.type === "integer") {
    const result = await p.text({
      message: label,
      defaultValue: currentValue !== undefined ? String(currentValue) : (field.default !== undefined ? String(field.default) : ""),
      validate: (v) => {
        if (!v || v.length === 0) return undefined; // allow empty for optional
        return isNaN(Number(v)) ? "Must be a number" : undefined;
      },
    });
    if (p.isCancel(result)) return result;
    if (typeof result === "string" && result.length > 0) {
      return Number(result);
    }
    return currentValue;
  }

  // Default: string
  return p.text({
    message: label,
    defaultValue: currentValue !== undefined ? String(currentValue) : (field.default !== undefined ? String(field.default) : ""),
  });
}

/**
 * Register the `configure` command on the program.
 *
 * Provides interactive section-based config editing using Clack prompts
 * driven by field metadata from @comis/core.
 *
 * @param program - The root Commander program
 */
export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .description("Interactively manage configuration")
    .option("-c, --config <path>", "Config file path", DEFAULT_CONFIG_PATH)
    .option("--section <section>", "Jump directly to a specific section")
    .action(async (options: { config: string; section?: string }) => {
      // Non-TTY detection
      if (!process.stdin.isTTY) {
        console.error("Configure requires an interactive terminal");
        process.exit(1);
      }

      p.intro("Comis Configuration Editor");

      // Load current config
      let currentConfig: Record<string, unknown> = {};
      const configPath = options.config;

      const loadResult = loadConfigFile(configPath);
      if (loadResult.ok) {
        currentConfig = loadResult.value;
        p.log.info(`Loaded configuration from ${configPath}`);
      } else {
        if (loadResult.error.code === "FILE_NOT_FOUND") {
          p.log.warn(`Config file not found at ${configPath}. Starting with empty config.`);
        } else {
          p.log.error(`Failed to load config: ${loadResult.error.message}`);
          process.exit(1);
        }
      }

      // Get available sections
      const sections = getConfigSections();

      let continueEditing = true;

      while (continueEditing) {
        // Section selection
        let selectedSection: string;

        if (options.section) {
          // Direct section jump (only first time)
          if (!sections.includes(options.section)) {
            p.log.error(`Unknown section: ${options.section}`);
            p.log.info(`Available sections: ${sections.join(", ")}`);
            process.exit(1);
          }
          selectedSection = options.section;
          options.section = undefined; // Clear for next iteration
        } else {
          const sectionChoice = await p.select({
            message: "Select a configuration section to edit:",
            options: sections.map((s) => ({
              value: s,
              label: s,
            })),
          });

          if (p.isCancel(sectionChoice)) {
            p.cancel("Configuration cancelled.");
            return;
          }

          selectedSection = sectionChoice as string;
        }

        p.log.step(`Editing section: ${selectedSection}`);

        // Get field metadata for this section
        const fields = getFieldMetadata(selectedSection);

        // Filter to editable fields: exclude immutable and complex types
        const editableFields = fields.filter(
          (f) => !f.immutable && isEditableType(f.type) && f.path !== selectedSection,
        );

        if (editableFields.length === 0) {
          p.log.warn(`No editable fields in section "${selectedSection}".`);
        } else {
          const updates: Record<string, unknown> = {};
          let cancelled = false;

          for (const field of editableFields) {
            const currentValue = getNestedValue(currentConfig, field.path);
            const result = await promptForField(field, currentValue);

            if (p.isCancel(result)) {
              cancelled = true;
              p.log.warn("Editing cancelled. Changes collected so far will be validated.");
              break;
            }

            // Only record if value changed
            if (result !== currentValue) {
              updates[field.path] = result;
            }
          }

          // Apply updates if any
          if (Object.keys(updates).length > 0) {
            // Build a partial config for validation
            const partialConfig: Record<string, unknown> = {};
            const sectionConfig = (currentConfig[selectedSection] ?? {}) as Record<string, unknown>;
            const updatedSection = { ...sectionConfig };

            for (const [dotPath, value] of Object.entries(updates)) {
              // Remove section prefix to get the key within the section
              const sectionPrefix = selectedSection + ".";
              const key = dotPath.startsWith(sectionPrefix)
                ? dotPath.slice(sectionPrefix.length)
                : dotPath;

              // Handle nested keys within the section
              const keyParts = key.split(".");
              if (keyParts.length === 1) {
                updatedSection[key] = value;
              } else {
                // Nested path within section
                let target = updatedSection;
                for (let i = 0; i < keyParts.length - 1; i++) {
                  const part = keyParts[i]!;
                  if (!target[part] || typeof target[part] !== "object") {
                    target[part] = {};
                  }
                  target = target[part] as Record<string, unknown>;
                }
                target[keyParts[keyParts.length - 1]!] = value;
              }
            }

            partialConfig[selectedSection] = updatedSection;

            // Validate the section
            const validation = validatePartial(partialConfig);

            if (validation.errors.length > 0) {
              p.log.error("Validation failed:");
              for (const err of validation.errors) {
                p.log.error(`  ${err.section}: ${err.error.message}`);
              }
            } else {
              // Write config preserving YAML formatting
              let doc: Document;
              try {
                const rawYaml = fs.readFileSync(configPath, "utf-8");
                doc = parseDocument(rawYaml);
              } catch {
                // No existing file or parse error -- start fresh
                doc = new Document({});
              }

              // Apply each update to the YAML document
              for (const [dotPath, value] of Object.entries(updates)) {
                setDocumentValue(doc, dotPath, value);
              }

              // Write back to file
              const dir = configPath.substring(0, configPath.lastIndexOf("/"));
              if (dir) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
              }
              fs.writeFileSync(configPath, doc.toString(), { mode: 0o600 });

              // Update in-memory config for subsequent edits
              currentConfig[selectedSection] = updatedSection;

              p.log.success("Configuration updated. Daemon will restart to apply changes.");
            }
          } else {
            p.log.info("No changes made.");
          }

          if (cancelled) {
            continueEditing = false;
            continue;
          }
        }

        // Offer to edit another section
        const another = await p.confirm({
          message: "Edit another section?",
          initialValue: false,
        });

        if (p.isCancel(another) || !another) {
          continueEditing = false;
        }
      }

      p.outro("Done.");
    });
}
