#!/usr/bin/env node

/**
 * CLI entry point for the `comis` command via the comisai npm package.
 *
 * When installed globally (`npm i -g comisai`), this provides the `comis` command
 * by delegating to the @comis/cli package's Commander.js-based CLI.
 *
 * @module
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve @comis/cli index via ESM, then derive cli.js from the same dist/ dir
const cliIndexUrl = import.meta.resolve("@comis/cli");
const cliDistDir = dirname(fileURLToPath(cliIndexUrl));
await import(join(cliDistDir, "cli.js"));
