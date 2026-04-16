/**
 * Skills code scanning security check.
 *
 * Scans skill JavaScript files for dangerous patterns beyond the
 * baseline AST scanner: network access, process manipulation, and
 * obfuscation techniques.
 *
 * @module
 */

import { readdirSync, readFileSync } from "node:fs";
import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Extended dangerous patterns to detect in skill code. */
const DANGEROUS_PATTERNS: ReadonlyArray<{
  name: string;
  regex: RegExp;
  code: string;
  label: string;
}> = [
  // Network access
  {
    name: "fetch-call",
    regex: /\bfetch\s*\(/,
    code: "SEC-SKILL-001",
    label: "Network access via fetch()",
  },
  {
    name: "xmlhttprequest",
    regex: /\bnew\s+XMLHttpRequest/,
    code: "SEC-SKILL-001",
    label: "Network access via XMLHttpRequest",
  },
  {
    name: "http-require",
    regex: /\brequire\s*\(\s*['"]https?['"]\s*\)/,
    code: "SEC-SKILL-001",
    label: "Network access via require('http/https')",
  },
  // Process manipulation
  {
    name: "process-exit",
    regex: /\bprocess\.exit/,
    code: "SEC-SKILL-002",
    label: "Process termination via process.exit",
  },
  {
    name: "child-process",
    regex: /\bchild_process/,
    code: "SEC-SKILL-002",
    label: "Process spawning via child_process",
  },
  {
    name: "exec-sync",
    regex: /\bexecSync/,
    code: "SEC-SKILL-002",
    label: "Synchronous process execution via execSync",
  },
  {
    name: "spawn-sync",
    regex: /\bspawnSync/,
    code: "SEC-SKILL-002",
    label: "Synchronous process spawning via spawnSync",
  },
  // Obfuscation
  {
    name: "atob-decode",
    regex: /\batob\s*\(/,
    code: "SEC-SKILL-003",
    label: "Base64 decoding via atob() (potential obfuscation)",
  },
  {
    name: "buffer-base64",
    regex: /\bBuffer\.from\s*\([^,]+,\s*['"]base64['"]\)/,
    code: "SEC-SKILL-003",
    label: "Base64 decoding via Buffer.from() (potential obfuscation)",
  },
];

/**
 * Recursively collect .js files from a directory.
 *
 * Uses string concatenation with "/" for path building (no path.join).
 */
function collectJsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".js")) {
        // Build path using "/" concatenation (not path.join per security rules)
        const parentPath = entry.parentPath ?? entry.path ?? dir;
        files.push(parentPath + "/" + entry.name);
      }
    }
  } catch {
    // Directory doesn't exist or not readable -- skip silently
  }
  return files;
}

/**
 * Skills code scanning check.
 *
 * For each skills directory, scans .js files for extended dangerous
 * patterns beyond the baseline AST scanner. Returns a warning for
 * each match with the file path and pattern name.
 */
export const skillsCodeCheck: SecurityCheck = {
  id: "skills-code",
  name: "Skills Code Scan",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (context.skillsPaths.length === 0) {
      return findings;
    }

    for (const skillsDir of context.skillsPaths) {
      const jsFiles = collectJsFiles(skillsDir);

      for (const filePath of jsFiles) {
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          // File not readable -- skip
          continue;
        }

        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.regex.test(content)) {
            findings.push({
              category: "skills-code",
              severity: "warning",
              message: `${pattern.label} in ${filePath}`,
              remediation:
                "Review this skill for necessity of the flagged pattern; ensure sandbox isolation is sufficient",
              code: pattern.code,
              path: filePath,
            });
          }
        }
      }
    }

    return findings;
  },
};
