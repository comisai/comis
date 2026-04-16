#!/usr/bin/env node

/**
 * CLI entry point for the `comis` command via the comisai npm package.
 *
 * When installed globally (`npm i -g comisai`), this provides the `comis` command
 * by delegating to the @comis/cli package's Commander.js-based CLI.
 *
 * @module
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cliPkgPath = require.resolve("@comis/cli/package.json");
await import(join(dirname(cliPkgPath), "dist", "cli.js"));
