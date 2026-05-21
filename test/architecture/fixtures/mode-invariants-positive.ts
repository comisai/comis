// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: POSITIVE — observability-mode-invariants rule should flag every
 * callable below. Walker assertion: ≥ 8 violations covering each branch of
 * the strict-literal classifier (no mode / wrong literal / variable /
 * ternary / bitwise / fs.promises.* shape / bare-import variant).
 */

import * as fs from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";

declare const someVar: number;
declare const cond: boolean;

// VIOLATION 1: fs.mkdirSync with no mode option
fs.mkdirSync("/tmp/test1", { recursive: true });

// VIOLATION 2: fs.mkdirSync with WRONG literal mode (0o755 instead of 0o700)
fs.mkdirSync("/tmp/test2", { recursive: true, mode: 0o755 });

// VIOLATION 3: fs.mkdirSync with VARIABLE-reference mode (strict-literal per D-07)
fs.mkdirSync("/tmp/test3", { recursive: true, mode: someVar });

// VIOLATION 4: fs.mkdirSync with BITWISE-expression mode (strict-literal per D-07)
fs.mkdirSync("/tmp/test4", { recursive: true, mode: 0o777 & ~0o077 });

// VIOLATION 5: fs.mkdirSync with TERNARY-expression mode (strict-literal per D-07)
fs.mkdirSync("/tmp/test4t", { recursive: true, mode: cond ? 0o700 : 0o755 });

// VIOLATION 6: fs.writeFileSync with no mode option
fs.writeFileSync("/tmp/file1", "content");

// VIOLATION 7: fs.writeFileSync with WRONG literal mode (0o644 instead of 0o600)
fs.writeFileSync("/tmp/file2", "content", { mode: 0o644 });

// VIOLATION 8: fs.promises.mkdir with no mode
void fs.promises.mkdir("/tmp/test5", { recursive: true });

// VIOLATION 9: fs.promises.writeFile with no mode
void fs.promises.writeFile("/tmp/file3", "content");

// VIOLATION 10: bare-import mkdirSync with no mode
mkdirSync("/tmp/test6", { recursive: true });

// VIOLATION 11: bare-import writeFileSync with no mode
writeFileSync("/tmp/file4", "content");
