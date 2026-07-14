import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { McpServerEntrySchema } from "../packages/core/src/config/schema-integrations.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = resolve(root, "docs", "skills", "mcp.mdx");
const source = readFileSync(docPath, "utf8");
const yamlBlocks = [...source.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
  (match) => match[1] ?? "",
);
const failures: string[] = [];

if (yamlBlocks.length === 0) {
  failures.push("docs/skills/mcp.mdx must contain at least one YAML example");
}

for (const [blockIndex, yaml] of yamlBlocks.entries()) {
  const label = `docs/skills/mcp.mdx YAML block ${blockIndex + 1}`;

  if (yaml.includes("{{secret:")) {
    failures.push(
      `${label} uses unsupported {{secret:...}} syntax; use \${UPPERCASE_NAME}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(yaml);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label} is not valid YAML: ${message}`);
    continue;
  }

  const servers = (
    parsed as {
      integrations?: { mcp?: { servers?: unknown } };
    }
  )?.integrations?.mcp?.servers;

  if (!Array.isArray(servers)) {
    failures.push(
      `${label} must define integrations.mcp.servers as an array`,
    );
    continue;
  }

  for (const [serverIndex, server] of servers.entries()) {
    const result = McpServerEntrySchema.safeParse(server);
    if (!result.success) {
      failures.push(
        `${label}, server ${serverIndex + 1} does not match McpServerEntrySchema: ${result.error.message}`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${yamlBlocks.length} MCP documentation YAML examples against McpServerEntrySchema`,
  );
}
