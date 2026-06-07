// SPDX-License-Identifier: Apache-2.0
/**
 * Render Comis's REAL prompts (system + tools + orchestration + memory) to text
 * files so we can feed them to qwen3.6 and measure comprehension (the
 * "do the models understand our prompts?" audit). Reads from the built dist.
 *
 *   node scripts/bench-small-model/extract-prompts.mjs
 *
 * Output: scripts/bench-small-model/prompts/{system-full.txt, tools.txt,
 *   orchestration.txt, memory-prompts.txt} + a sizes summary on stdout.
 * @module
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const OUT = join(HERE, "prompts");
mkdirSync(OUT, { recursive: true });
const CHARS_PER_TOK = 3.5;
const tok = (s) => Math.round(s.length / CHARS_PER_TOK);

const boot = await import(join(ROOT, "packages/agent/dist/bootstrap/index.js"));
const td = await import(join(ROOT, "packages/agent/dist/bootstrap/sections/tool-descriptions.js"));

// Representative tool set spanning every category a real agent sees.
const toolNames = [
  "read", "edit", "write", "apply_patch", "grep", "find", "ls", "exec", "process",
  "message", "memory_search", "memory_store", "memory_get", "memory_ask",
  "web_search", "web_fetch", "browser", "discover_tools",
  "sessions_spawn", "pipeline", "agents_manage", "cron", "gateway",
  "image_analyze", "discord_action",
];

const sysFull = boot.assembleRichSystemPrompt({
  promptMode: "full",
  agentName: "Comis",
  toolNames,
  hasMemoryTools: true,
  workspaceDir: "/home/user/.comis/workspace",
  reasoningEnabled: true,
  reasoningTagHint: true,
  dagModeEnabled: true,
  sepEnabled: false,
  outboundMediaEnabled: true,
  mediaPersistenceEnabled: true,
  runtimeInfo: { agentId: "comis-main", host: "localhost", os: "darwin", arch: "arm64", model: "qwen3.6:35b", nodeVersion: "22", shell: "/bin/zsh" },
  bootstrapFiles: [{ path: "SOUL.md", content: "You are Comis, a helpful security-first assistant." }],
  subAgentToolNames: ["read", "write", "edit", "exec", "web_fetch"],
});

const sysMinimal = boot.assembleRichSystemPrompt({
  promptMode: "minimal", agentName: "Comis", toolNames, hasMemoryTools: true,
  workspaceDir: "/home/user/.comis/workspace", runtimeInfo: { agentId: "comis-main", os: "darwin", model: "qwen3.6:35b" },
});

// Tools: summaries + lean descriptions + the orchestration guides.
const lean = (name) => {
  const d = td.LEAN_TOOL_DESCRIPTIONS?.[name];
  return typeof d === "function" ? d({ modelTier: "small" }) : (d ?? td.TOOL_SUMMARIES?.[name] ?? "");
};
const toolsText = toolNames.map((n) => `### ${n}\n${lean(n)}`).join("\n\n");
const orchestration = ["pipeline", "sessions_spawn", "agents_manage"]
  .map((n) => `### TOOL_GUIDE: ${n}\n${td.TOOL_GUIDES?.[n] ?? "(no guide)"}`).join("\n\n---\n\n")
  + "\n\n=== SYSTEM_PROMPT_GUIDES (deferred, injected on first use) ===\n"
  + Object.entries(td.SYSTEM_PROMPT_GUIDES ?? {}).map(([k, v]) => `\n## ${k}\n${v}`).join("\n");

// Memory prompts (cheap-model contracts).
let memText = "";
for (const [mod, names] of [
  ["packages/agent/dist/memory/memory-consolidation-prompt.js", ["CONSOLIDATION_PROMPT"]],
  ["packages/agent/dist/memory/memory-reasoning-prompt.js", ["DEDUCTIVE_PROMPT", "INDUCTIVE_PROMPT"]],
]) {
  try {
    const m = await import(join(ROOT, mod));
    for (const n of names) if (m[n]) memText += `\n=== ${n} ===\n${m[n]}\n`;
  } catch (e) { memText += `\n(could not load ${mod}: ${e.message})\n`; }
}
try {
  const dia = await import(join(ROOT, "packages/agent/dist/memory/memory-dialectic-prompt.js"));
  if (dia.buildDialecticPrompt) memText += `\n=== DIALECTIC_PROMPT ===\n${dia.buildDialecticPrompt()}\n`;
} catch (e) { memText += `\n(dialectic load err: ${e.message})\n`; }

writeFileSync(join(OUT, "system-full.txt"), sysFull);
writeFileSync(join(OUT, "system-minimal.txt"), sysMinimal);
writeFileSync(join(OUT, "tools.txt"), toolsText);
writeFileSync(join(OUT, "orchestration.txt"), orchestration);
writeFileSync(join(OUT, "memory-prompts.txt"), memText);

console.log("=== rendered Comis prompt sizes (chars / ~tokens) ===");
for (const [label, s] of [
  ["system FULL", sysFull], ["system MINIMAL", sysMinimal], ["tools (lean, 25)", toolsText],
  ["orchestration guides", orchestration], ["memory prompts", memText],
]) console.log(`${label.padEnd(22)} ${String(s.length).padStart(7)} chars  ~${tok(s)} tok`);
console.log(`\nwrote ${OUT}/{system-full,system-minimal,tools,orchestration,memory-prompts}.txt`);
