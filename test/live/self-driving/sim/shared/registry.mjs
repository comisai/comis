// Loads a workload (tools.json + world.seed.json + handlers.mjs) and returns a
// uniform handle the MCP server and the CLI both drive. One world + one case-store
// per process — so a long-lived MCP server holds episode state across tool calls,
// while each `open_*` act starts an isolated case (two sessions can corroborate
// without interfering).

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { makeRng, hashSeed, grade } from "./world.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SIM_ROOT = join(HERE, "..");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} name  workload dir under sim/ (e.g. "threat-hunting")
 * @param {{seed?:string|number, variant?:string}} [opts]
 */
export async function loadWorkload(name, opts = {}) {
  const dir = join(SIM_ROOT, name);
  const tools = readJson(join(dir, "tools.json"), null);
  if (!tools || !Array.isArray(tools.tools)) {
    throw new Error(`workload "${name}": missing or invalid tools.json at ${dir}`);
  }
  const seedRaw = String(opts.seed ?? process.env.SIM_SEED ?? "42");
  const seed = /^-?\d+$/.test(seedRaw) ? Number(seedRaw) >>> 0 : hashSeed(seedRaw);
  const variant = String(opts.variant ?? process.env.SIM_VARIANT ?? "A");
  const rng = makeRng(seed);
  const seedWorld = readJson(join(dir, "world.seed.json"), {});

  const mod = await import(pathToFileURL(join(dir, "handlers.mjs")).href);
  const ctx = {
    rng,
    seed,
    variant,
    seedWorld,
    cases: new Map(),
    caseCounter: 0,
    lastCase: null,
    grade,
    log: (...a) => process.stderr.write(`[sim:${name}] ${a.join(" ")}\n`),
  };
  ctx.world = mod.setup ? mod.setup({ seedWorld, rng, variant, ctx }) : seedWorld;
  const handlers = mod.handlers || {};

  const call = (toolName, args = {}) => {
    const h = handlers[toolName];
    if (typeof h !== "function") throw new Error(`unknown tool: ${toolName}`);
    return h(args || {}, ctx);
  };

  return {
    name,
    server: tools.server || name,
    title: tools.title || name,
    toolMeta: tools.tools,
    ctx,
    /** MCP tools/list shape. */
    listTools: () =>
      tools.tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      })),
    call,
    /** Optional per-workload self-test: runs a golden path (→ success) and a naive
     *  path (→ failure) in one process to prove the success signal is reachable. */
    selftest: mod.selftest ? () => mod.selftest({ call, ctx }) : null,
  };
}
