// SPDX-License-Identifier: Apache-2.0

interface TerminalProcessEntry {
  readonly outputFile: string;
  readonly sourcePath: string;
}

export const TERMINAL_PROCESS_ENTRIES = Object.freeze({
  worker: {
    outputFile: "terminal-worker-main.js",
    sourcePath: "packages/skills/src/tools/builtin/terminal-driver/terminal-worker-main.ts",
  },
  egressProxy: {
    outputFile: "terminal-egress-proxy-main.js",
    sourcePath: "packages/skills/src/tools/builtin/terminal-driver/terminal-egress-proxy-main.ts",
  },
} as const satisfies Record<string, TerminalProcessEntry>);
