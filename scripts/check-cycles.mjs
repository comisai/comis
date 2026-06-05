// SPDX-License-Identifier: Apache-2.0
/**
 * Circular-dependency gate (dist-mode), replacing the `madge --circular` CLI.
 *
 * Equivalent detection to `madge --circular --extensions ts packages/*\/dist`,
 * but via madge's programmatic API. The madge 8.0.0 CLI (`bin/cli.js`)
 * unconditionally constructs an `ora` spinner whose bundled version throws on
 * construction in a non-interactive shell (`Cannot read properties of undefined
 * (reading 'interval')`), which crashed `pnpm cycles` — and therefore the whole
 * `pnpm validate` gate and the pre-push hook — in any non-TTY environment.
 * The programmatic API never touches `ora`, so this runs everywhere.
 *
 * @module
 */
import madge from "madge";
import { globSync } from "node:fs";

const dirs = globSync("packages/*/dist");
if (dirs.length === 0) {
  console.error("check-cycles: no packages/*/dist found — run `pnpm build` first.");
  process.exit(1);
}

const circular = (await madge(dirs, { fileExtensions: ["ts"] })).circular();

if (circular.length > 0) {
  console.error(`check-cycles: found ${circular.length} circular dependencies:`);
  console.error(JSON.stringify(circular, null, 2));
  process.exit(1);
}

console.log(`check-cycles: 0 circular dependencies across ${dirs.length} dist packages`);
