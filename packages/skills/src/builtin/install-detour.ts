// SPDX-License-Identifier: Apache-2.0
/**
 * Install-detour parser: detect pip/npm/pnpm/yarn install commands that
 * overlap connected MCP servers or visible prompt skills (design §8.1).
 *
 * Pure parser — no IO, no per-call state beyond inputs. Returns `null` on
 * parser-bail (unbalanced quotes, no install form found, no overlap detected)
 * to signal "let the command run unchanged."
 *
 * Consumed by:
 * - packages/skills/src/builtin/exec-tool.ts (Plan 22-03 mode policy gate)
 * - packages/skills/src/builtin/process-tool.ts (Plan 22-03 advise-mode retroactive hint)
 * - packages/skills/src/builtin/process-registry.ts (Plan 22-02 InstallDetourDecision type for ProcessSession field)
 *
 * Design anchor: §8.1 (parser + tokenization), §8.2 (consumer integration).
 * Privacy invariant (Pitfall 11; INSTALL-DTR-25): the parser produces only
 * sanitized identifiers (`commandDigest`, `packages[].normalizedName`,
 * `overlaps[].sourceName`). Raw command text NEVER leaves this module.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { ToolCapabilityPort } from "@comis/core";
import { ShellQuoteTracker } from "./exec-security.js";

// --------------------------------------------------------------------------
// Public types (consumed by exec-tool.ts, process-tool.ts, process-registry.ts)
// --------------------------------------------------------------------------

/**
 * One overlap entry — links a parsed install package back to the connected
 * MCP server or visible prompt skill that should be used instead.
 *
 * The 4 `reason` literals are pinned to match the closed event shape at
 * `packages/core/src/event-bus/events-agent.ts:120-159` (Phase 17). Do NOT
 * add new literals here without updating the event type in core.
 */
export interface DetourOverlap {
  /** Normalized package name (PEP-503 for python, lowercase + scope-preserving for npm). */
  readonly packageName: string;
  readonly sourceType: "mcp" | "skill";
  /** Connected MCP server name OR visible prompt-skill name. Never a tool name. */
  readonly sourceName: string;
  /** Cluster (used by soft-stop error template; from getMcpServerHint/getSkillHint/getClusterConfig). */
  readonly cluster?: string;
  readonly reason:
    | "direct-server-name"
    | "mcp-operator-alias"
    | "skill-comis-alias"
    | "skill-operator-alias";
}

/**
 * Parser decision — returned non-null only when an install form was matched
 * AND at least one overlap was detected. Returns `null` on every other path
 * (parser-bail, no install form, no overlap), so callers branch via
 * `if (decision !== null)` rather than checking `overlaps.length`.
 */
export interface InstallDetourDecision {
  readonly packageManager: "pip" | "npm" | "pnpm" | "yarn";
  /** Sorted alphabetically — required for `commandDigest` stability (RESEARCH §19 Q5). */
  readonly packages: readonly string[];
  readonly overlaps: readonly DetourOverlap[];
  /** SHA-256 of `${packageManager}:${sortedPackages.join(",")}` truncated to 16 hex chars. */
  readonly commandDigest: string;
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

/**
 * Parse a shell command for install-detour overlap. Pure function — no IO,
 * no module state, no memoization. Built fresh per call from the port's
 * runtime state to avoid Pitfall 5 (skill-visibility race).
 *
 * Returns `null` when:
 * - `splitTopLevelSegments` bails (unbalanced quotes anywhere) — INSTALL-DTR-07
 * - No top-level segment matches the leading-token rule — INSTALL-DTR-06
 * - The matched segment yields no parsed packages after token classification
 * - `overlaps.length === 0` (no detected overlap)
 *
 * @param command - Raw shell command (caller passes verbatim — parser does not sanitize)
 * @param port - ToolCapabilityPort (runtime view of connected servers + visible skills)
 */
export function parseInstallDetour(
  command: string,
  port: ToolCapabilityPort,
): InstallDetourDecision | null {
  const segments = splitTopLevelSegments(command);
  if (segments === null) return null;     // unbalanced quotes — INSTALL-DTR-07

  // Try each top-level segment until one matches an install form
  for (const segment of segments) {
    const parsed = parseInstallSegment(segment);
    if (parsed === null) continue;
    const { packageManager, rawPackages } = parsed;

    // Token classification: drop URL/VCS/path/file specs; strip versions; keep registry names
    const ecosystem = packageManager === "pip" ? "python" : "node";
    const cleanedNames: string[] = [];
    for (const tok of rawPackages) {
      const cleaned = classifyPackageToken(tok, ecosystem);
      if (cleaned !== null) cleanedNames.push(cleaned);
    }
    if (cleanedNames.length === 0) continue;       // no install-target tokens

    // Normalize names per ecosystem
    const normalize = ecosystem === "python" ? normalizePythonName : normalizeNpmName;
    const packages = [...new Set(cleanedNames.map(normalize))].sort();
    if (packages.length === 0) continue;

    // Build alias map FRESH per call (RESEARCH §15 Risk 5 — no memoization)
    const { pythonAliases, npmAliases } = buildPackageAliasMap(port);
    const aliasMap = ecosystem === "python" ? pythonAliases : npmAliases;
    const connectedServersNorm = new Set(
      port.getConnectedMcpServers().map(normalize),
    );

    // Detect overlaps for each package: direct-server first, then alias-map
    const overlaps: DetourOverlap[] = [];
    for (const pkgN of packages) {
      if (connectedServersNorm.has(pkgN)) {
        // Find the original (un-normalized) server name for the sourceName field
        const serverName = port.getConnectedMcpServers().find((s) => normalize(s) === pkgN);
        if (serverName) {
          const hint = port.getMcpServerHint(serverName);
          overlaps.push({
            packageName: pkgN,
            sourceType: "mcp",
            sourceName: serverName,
            cluster: hint?.cluster,
            reason: "direct-server-name",
          });
          continue;
        }
      }
      const aliasHit = aliasMap.get(pkgN);
      if (aliasHit) overlaps.push(aliasHit);
    }

    if (overlaps.length === 0) return null;  // no overlap → no event → run unchanged

    // First-match-wins on segments: return on the first segment producing overlap
    return {
      packageManager,
      packages,
      overlaps,
      commandDigest: buildCommandDigest(packageManager, packages),
    };
  }

  return null;  // no segment matched an install form
}

// --------------------------------------------------------------------------
// Private helpers (NOT exported — internal to install-detour module)
// --------------------------------------------------------------------------

/**
 * Split a command on top-level `;` `&&` `||` `|` `&` (outside quotes). Reuses
 * `ShellQuoteTracker` from `exec-security.ts:21-74`. Returns `null` on
 * unbalanced quotes anywhere — the parser-bail signal (INSTALL-DTR-07).
 *
 * Deliberately separate from `exec-security.ts:splitCommandSegments`:
 * - Splits on `&` AS WELL — POSIX background-and-continue is a command terminator
 *   (CR-02; same operator class as `;`). See exec-security.ts:184 for the
 *   canonical reference and 22-VERIFICATION.md gap CR-02 for the rationale.
 * - Returns `null` on unbalanced quotes (vs returning collected-so-far).
 * Two helpers, no shared abstraction (RESEARCH §4.3, KISS-consistent).
 */
function splitTopLevelSegments(command: string): readonly string[] | null {
  const tracker = new ShellQuoteTracker();
  const segments: string[] = [];
  let current = "";

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;

    if (!tracker.escaped && tracker.state === "NORMAL") {
      // Two-char operators first
      if (i + 1 < command.length) {
        const two = ch + (command[i + 1] as string);
        if (two === "&&" || two === "||") {
          segments.push(current.trim());
          current = "";
          i++; // skip second char
          continue;
        }
      }
      // Single-char operators. `&` is a POSIX command terminator (background-and-continue),
      // same class as `;` — see CR-02 in 22-VERIFICATION.md and exec-security.ts:184.
      // The two-char `&&` lookahead above runs first, so `&&` is never reached here.
      if (ch === ";" || ch === "|" || ch === "&") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }

    tracker.feed(ch);
    current += ch;
  }

  // Bail on unbalanced quotes
  if (tracker.state !== "NORMAL" || tracker.escaped) {
    return null;
  }

  segments.push(current.trim());
  return segments.filter((s) => s.length > 0);
}

/**
 * Identify the install form (if any) of a single top-level segment by its
 * leading token. Returns the matched package manager + the raw remaining
 * tokens (after the install verb) when a form is found.
 *
 * Per design §8.1 leading-token rule — ONLY these forms are recognized:
 *   pip install …
 *   pip3 install …
 *   python -m pip install …
 *   python3 -m pip install …
 *   npm install … | npm i … | npm add …
 *   pnpm install … | pnpm add …
 *   yarn add …
 *
 * Quoted strings, command substitution, heredocs, and `npx`/`pwsh -c`
 * fall through to the `null` branch.
 */
function parseInstallSegment(
  segment: string,
): { packageManager: "pip" | "npm" | "pnpm" | "yarn"; rawPackages: string[] } | null {
  // Whitespace-tokenize the segment. We deliberately do NOT re-tokenize
  // with quote-awareness here — the leading-token rule only inspects the
  // first whitespace-delimited token, and shell quoting at this layer is
  // already consistent (parent splitTopLevelSegments left us a balanced
  // segment). This is the design's "no recursive descent" position.
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const lead = tokens[0] as string;
  if (lead === "pip" || lead === "pip3") {
    if (tokens[1] !== "install") return null;
    return { packageManager: "pip", rawPackages: tokens.slice(2) };
  }
  if (lead === "python" || lead === "python3") {
    // python -m pip install …
    if (tokens[1] !== "-m" || tokens[2] !== "pip" || tokens[3] !== "install") return null;
    return { packageManager: "pip", rawPackages: tokens.slice(4) };
  }
  if (lead === "npm") {
    const verb = tokens[1];
    if (verb !== "install" && verb !== "i" && verb !== "add") return null;
    return { packageManager: "npm", rawPackages: tokens.slice(2) };
  }
  if (lead === "pnpm") {
    const verb = tokens[1];
    if (verb !== "install" && verb !== "add") return null;
    return { packageManager: "pnpm", rawPackages: tokens.slice(2) };
  }
  if (lead === "yarn") {
    if (tokens[1] !== "add") return null;
    return { packageManager: "yarn", rawPackages: tokens.slice(2) };
  }
  return null;
}

/**
 * Classify one raw token from the install args:
 * - Returns `null` if it's a flag (starts with `-`).
 * - Returns `null` if it's URL/VCS/local-path/file spec (design §8.1 rule 7).
 * - Returns the package name with version stripped for unscoped names.
 * - Preserves `@scope/name` and strips `@version` only at the SECOND `@`.
 */
function classifyPackageToken(
  token: string,
  ecosystem: "python" | "node",
): string | null {
  if (token.startsWith("-")) return null;        // flag — skip

  // URL / VCS / local-path / file spec rejection (design §8.1 rule 7)
  if (
    token.includes("://") ||
    token.startsWith("git+") ||
    token.startsWith("file:") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.endsWith(".tar.gz") ||
    token.endsWith(".whl") ||
    token.endsWith(".zip")
  ) {
    return null;
  }

  // Scoped npm preservation: @scope/name or @scope/name@1.2.3
  if (ecosystem === "node" && token.startsWith("@")) {
    const slashIdx = token.indexOf("/");
    if (slashIdx <= 0) return null;              // malformed @scope without name
    const afterSlash = token.slice(slashIdx + 1);
    const versionAt = afterSlash.indexOf("@");
    const namePart = versionAt >= 0
      ? afterSlash.slice(0, versionAt)
      : afterSlash;
    if (namePart.length === 0) return null;
    return token.slice(0, slashIdx + 1) + namePart;   // "@scope/name"
  }

  // Unscoped: strip version specifiers from the FIRST occurrence of
  // any of `==`, `>=`, `<=`, `<`, `>`, `!=`, `~=`, or `@`.
  const versionRegex = /(==|>=|<=|!=|~=|<|>|@)/;
  const match = token.search(versionRegex);
  const namePart = match >= 0 ? token.slice(0, match) : token;
  if (namePart.length === 0) return null;
  return namePart;
}

/** PEP 503 strict normalization: lowercase + collapse `-`/`_`/`.` runs to single `-` (RESEARCH §A1). */
function normalizePythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** npm: lowercase only; `@scope/name` preserved exactly. */
function normalizeNpmName(name: string): string {
  return name.toLowerCase();
}

/**
 * SHA-256 of `${pm}:${sortedPackages.join(",")}` truncated to 16 hex chars.
 * Stable, order-insensitive, distinct for distinct PMs/packages.
 * Mirrors `file-state-tracker.ts:160-163` crypto pattern + the
 * `SYSTEM_PROMPT_HASH_LENGTH = 16` truncation convention from
 * `packages/agent/src/context-engine/constants.ts:163`.
 */
function buildCommandDigest(pm: string, packages: readonly string[]): string {
  const sorted = [...packages].sort();
  return createHash("sha256")
    .update(`${pm}:${sorted.join(",")}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Build per-call alias maps from the port's runtime view. NEVER memoize
 * across calls (RESEARCH §15 Risk 5 — skill-visibility race).
 *
 * Two SEPARATE maps keyed by ecosystem to avoid cross-ecosystem aliasing
 * collisions when an operator declares `replacesPackages: ["foo_bar"]`
 * (Python normalizes to `foo-bar`; npm preserves `foo_bar`). The parser
 * picks the appropriate map based on detected `packageManager`.
 */
function buildPackageAliasMap(port: ToolCapabilityPort): {
  pythonAliases: Map<string, DetourOverlap>;
  npmAliases: Map<string, DetourOverlap>;
} {
  const pythonAliases = new Map<string, DetourOverlap>();
  const npmAliases = new Map<string, DetourOverlap>();

  // 1. MCP operator hints (tooling.mcp.capabilityHints[*].replacesPackages)
  for (const server of port.getConnectedMcpServers()) {
    const hint = port.getMcpServerHint(server);
    if (!hint) continue;
    for (const pkg of hint.replacesPackages) {
      const overlap: DetourOverlap = {
        packageName: pkg.toLowerCase(),
        sourceType: "mcp",
        sourceName: server,
        cluster: hint.cluster,
        reason: "mcp-operator-alias",
      };
      const pyKey = normalizePythonName(pkg);
      const npmKey = normalizeNpmName(pkg);
      if (!pythonAliases.has(pyKey)) {
        pythonAliases.set(pyKey, { ...overlap, packageName: pyKey });
      }
      if (!npmAliases.has(npmKey)) {
        npmAliases.set(npmKey, { ...overlap, packageName: npmKey });
      }
    }
  }

  // 2. Skill aliases (operator hints + comis.capability — both pre-merged
  //    by port.getPromptSkillCapabilities() per Phase 17 contract).
  //    Visibility filter (allowed/denied/eligibility/disableModelInvocation)
  //    is already applied at the port level — no re-filter here.
  for (const skill of port.getPromptSkillCapabilities()) {
    // Discriminate operator-alias vs comis-alias: if port.getSkillHint
    // returns truthy for this skill, the operator hint is the source.
    const operatorHint = port.getSkillHint(skill.name, skill.skillKey);
    const reason: DetourOverlap["reason"] = operatorHint
      ? "skill-operator-alias"
      : "skill-comis-alias";
    for (const pkg of skill.replacesPackages) {
      const overlap: DetourOverlap = {
        packageName: pkg.toLowerCase(),
        sourceType: "skill",
        sourceName: skill.name,
        cluster: skill.cluster,
        reason,
      };
      const pyKey = normalizePythonName(pkg);
      const npmKey = normalizeNpmName(pkg);
      // first-source-wins precedence: MCP entries already in the map are not overwritten
      if (!pythonAliases.has(pyKey)) {
        pythonAliases.set(pyKey, { ...overlap, packageName: pyKey });
      }
      if (!npmAliases.has(npmKey)) {
        npmAliases.set(npmKey, { ...overlap, packageName: npmKey });
      }
    }
  }

  return { pythonAliases, npmAliases };
}
