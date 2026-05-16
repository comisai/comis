// SPDX-License-Identifier: Apache-2.0
/**
 * Exec command security — pre-pipeline sanitization gates
 * (Phase 43 split per FILE-SPLIT-11).
 *
 * Extracted from `exec-security.ts` (1,153L monolith) on 2026-05-16. Owns
 * the gates that run BEFORE compound-splitting in the validation pipeline:
 *   - sanitizeCommandInput (Gate 0: invisible-char detection)
 *   - extractHeredoc (heredoc auto-split for stdin interpreters)
 *   - detectShellSubstitutions (Gate 1)
 *   - detectDangerousPipeTargets (Gate 2 — pre-split, full-command scan)
 *   - detectIFSInjection (Gate 6)
 *   - detectBraceExpansion (Gate 8)
 *   - detectProcEnvironAccess (Gate 11)
 *   - detectCommentQuoteDesync (Gate 12)
 *
 * @module
 */

import { ShellQuoteTracker, splitCommandSegments } from "./exec-security-sandbox.js";

// --------------------------------------------------------------------------
// Shell substitution detection
// --------------------------------------------------------------------------

/**
 * Detect shell substitution patterns ($(), backticks, <()/>()) that could
 * enable injection. Single-quoted strings are excluded. Uses ShellQuoteTracker
 * for escape and quote-context awareness.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if dangerous substitution found, null if safe
 */
export function detectShellSubstitutions(command: string): string | null {
  const tracker = new ShellQuoteTracker();

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Check BEFORE feeding to tracker so we can use current state
    if (!tracker.escaped && !tracker.isInSingleQuote()) {
      // Command substitution: $(
      if (
        ch === "$" &&
        i + 1 < command.length &&
        command[i + 1] === "(" &&
        tracker.state !== "BACKTICK"
      ) {
        return "Shell command substitution $(...) detected";
      }

      // Backtick substitution (only in NORMAL or DOUBLE_QUOTE)
      if (
        ch === "`" &&
        (tracker.state === "NORMAL" || tracker.state === "DOUBLE_QUOTE")
      ) {
        return "Backtick substitution detected";
      }

      // Process substitution: <( or >(
      if (
        (ch === "<" || ch === ">") &&
        i + 1 < command.length &&
        command[i + 1] === "(" &&
        tracker.state === "NORMAL"
      ) {
        return "Process substitution detected";
      }

      // Zsh process substitution: =( at word boundary
      if (
        ch === "=" &&
        i + 1 < command.length &&
        command[i + 1] === "(" &&
        tracker.state === "NORMAL"
      ) {
        return "Zsh process substitution =(…) detected";
      }

      // Zsh equals expansion: =cmd at word start (not VAR=val)
      if (
        ch === "=" &&
        tracker.state === "NORMAL" &&
        (i === 0 || /[\s;&|]/.test(command[i - 1])) &&
        i + 1 < command.length &&
        /[a-zA-Z_]/.test(command[i + 1])
      ) {
        return "Zsh equals expansion (=cmd) detected";
      }
    }

    tracker.feed(ch);
  }

  return null;
}

// --------------------------------------------------------------------------
// Dangerous pipe target detection
// --------------------------------------------------------------------------

/**
 * Commands that are dangerous as pipe targets (data flows INTO them).
 * Standalone use is legitimate -- only the pipe-to pattern is suspicious.
 */
const DANGEROUS_PIPE_TARGETS = new Set([
  // Shell interpreters (migrated from Category C denylist)
  "sh", "bash", "zsh", "dash", "fish", "csh", "tcsh", "ksh",
  // Network exfiltration tools
  "nc", "ncat", "socat", "telnet", "curl", "wget",
]);

/**
 * Detect pipes to dangerous targets (shell interpreters, network tools).
 * Runs on the FULL command before compound splitting, because splitCommandSegments
 * splits on | and removes the pipe context from individual segments.
 *
 * @param command - The full raw shell command
 * @returns Error message if dangerous pipe target found, null if safe
 */
export function detectDangerousPipeTargets(command: string): string | null {
  if (!command.includes("|")) return null;

  const segments = splitCommandSegments(command);
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].trimStart();
    const firstWord = segment.split(/\s/)[0];
    const basename = firstWord.includes("/")
      ? firstWord.split("/").pop()!
      : firstWord;
    if (DANGEROUS_PIPE_TARGETS.has(basename)) {
      return `Pipe to '${basename}' detected (potential data exfiltration or remote code execution). Piping data to shell interpreters or network tools is blocked.`;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Gate 0: Invisible character sanitization
// --------------------------------------------------------------------------

/**
 * Regex matching invisible or ambiguous Unicode characters that can bypass
 * regex-based validation. Ranges carefully exclude tab (0x09) and CR (0x0d).
 *
 * Ranges:
 * - \x00-\x08: C0 controls before tab
 * - \x0a-\x0c: LF, VT, FF (newline in command = injection vector)
 * - \x0e-\x1f: C0 controls after CR (SO, SI, DLE, ..., US)
 * - \u00A0: non-breaking space
 * - \u00AD: soft hyphen
 * - \u200B-\u200F: zero-width space, ZWNJ, ZWJ, LTR mark, RTL mark
 * - \u2060: word joiner
 * - \uFEFF: BOM / zero-width no-break space
 * - \x7F: DEL character
 * - \u1680: Ogham space mark
 * - \u2000-\u200A: en/em/thin/hair/figure spaces
 * - \u2028: line separator
 * - \u2029: paragraph separator
 * - \u202F: narrow no-break space
 * - \u205F: medium mathematical space
 * - \u3000: ideographic space
 */
const INVISIBLE_CHAR_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0a-\x0c\x0e-\x1f\x7F\u00A0\u00AD\u1680\u200B-\u200F\u2000-\u200A\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]/;

/**
 * Detect shell patterns where the LLM is trying to write a file
 * (cat/tee/echo/printf heredoc, or a `>` redirection). Used to swap
 * the Gate-0 newline-rejection hint toward the `write` tool instead of
 * `python3 -` with stdin — pointing the LLM at the correct alternative
 * prevents it from retrying more cat-heredocs (observed NVDA run:
 * 12 consecutive `[invalid_value]` failures before the exec tool was
 * circuit-broken).
 */
const FILE_WRITE_HEURISTIC =
  /^\s*(?:cat|tee|echo|printf)\b|>\s*["']?[^|<&\s]+\s*(?:<<|$)/;

export function sanitizeCommandInput(command: string): string | null {
  const match = INVISIBLE_CHAR_REGEX.exec(command);
  if (match) {
    const cp = match[0].codePointAt(0)!;
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    let msg = `Command contains invisible/ambiguous character U+${hex} at position ${match.index}. This can bypass security validation. Remove the character and retry.`;
    if (cp === 0x0a) {
      // Disambiguate: is the LLM writing a file (use `write` tool) or
      // running a multi-line script (use python3/node/bash with stdin)?
      // The heuristic fires on the line the newline was rejected on, so
      // the hint matches the LLM's actual intent.
      const looksLikeFileWrite = FILE_WRITE_HEURISTIC.test(command);
      msg += looksLikeFileWrite
        ? ` To write files, use the 'write' tool (or 'edit' for targeted changes) instead of a shell heredoc in exec.`
        : ` For multi-line scripts, use command='python3 -' (or 'node -', 'bash -') with the 'input' parameter for the script body.`;
    }
    return msg;
  }
  return null;
}

/**
 * Auto-extract heredoc patterns into command + input before security validation.
 *
 * LLMs frequently send heredoc syntax like `python3 - <<'PY'\nscript\nPY` to the
 * exec tool's command parameter. Gate 0 blocks newlines in commands (correctly,
 * for injection prevention). This function detects the heredoc pattern and splits
 * it into a clean command (`python3 -`) and input (the script body), allowing
 * the existing `input` stdin parameter to carry the script content.
 *
 * Only matches known stdin-capable interpreters followed by ` -` (stdin marker).
 * Returns null if no heredoc detected or if input is already provided.
 */
export function extractHeredoc(
  command: string,
  input: string | undefined,
): { command: string; input: string } | null {
  if (input) return null;

  const match = command.match(
    /^((?:python3?|node|bash|sh|ruby|perl|php)\s+-)\s*<<-?['"]?([A-Za-z_]\w*)['"]?\n([\s\S]*)\n\2\s*$/,
  );
  if (!match) return null;

  return { command: match[1], input: match[3] };
}

// --------------------------------------------------------------------------
// Gate 6: IFS injection detection
// --------------------------------------------------------------------------

/**
 * Detect IFS variable usage that could bypass argument splitting security.
 * Blocks $IFS direct references and ${...IFS...} parameter expansions.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if IFS injection found, null if safe
 */
export function detectIFSInjection(command: string): string | null {
  if (/\$IFS|\$\{[^}]*IFS|\bIFS=/.test(command)) {
    return "Command contains IFS variable usage which could bypass security validation.";
  }
  return null;
}

// --------------------------------------------------------------------------
// Gate 8: Brace expansion detection
// --------------------------------------------------------------------------

/**
 * Check if position in string is backslash-escaped by counting consecutive
 * backslashes before it. Odd count = escaped.
 */
function isEscaped(content: string, pos: number): boolean {
  let count = 0;
  let i = pos - 1;
  while (i >= 0 && content[i] === "\\") {
    count++;
    i--;
  }
  return count % 2 === 1;
}

/**
 * Detect dangerous brace expansion patterns in unquoted shell context.
 * Blocks comma-based ({rm,-rf,/}) and range-based ({a..z}) patterns while
 * allowing parameter expansion (${HOME}), quoted braces, and single braces
 * without comma/dots.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if dangerous brace expansion found, null if safe
 */
export function detectBraceExpansion(command: string): string | null {
  const tracker = new ShellQuoteTracker();

  // Build string of unquoted content, tracking positions
  let unquoted = "";
  const posMap: number[] = []; // maps unquoted index -> original command index

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const wasNormal = tracker.state === "NORMAL" && !tracker.escaped;
    tracker.feed(ch);
    if (wasNormal && tracker.state === "NORMAL") {
      unquoted += ch;
      posMap.push(i);
    } else if (wasNormal) {
      // Character triggered state change (e.g., opening quote) -- not unquoted content
    }
  }

  // Scan unquoted content for brace expansion patterns
  let depth = 0;
  let outerStart = -1;

  for (let i = 0; i < unquoted.length; i++) {
    const ch = unquoted[i];

    if (ch === "{" && !isEscaped(unquoted, i)) {
      // Skip parameter expansion: ${ is NOT brace expansion
      if (i > 0 && unquoted[i - 1] === "$") continue;

      if (depth === 0) outerStart = i;
      depth++;
    } else if (ch === "}" && !isEscaped(unquoted, i) && depth > 0) {
      depth--;
      if (depth === 0 && outerStart >= 0) {
        // Extract content between outermost braces
        const inner = unquoted.slice(outerStart + 1, i);
        // Check for comma-based expansion: {a,b} or {rm,-rf,/}
        if (inner.includes(",")) {
          return `Brace expansion with comma pattern detected: {${inner.slice(0, 40)}}`;
        }
        // Check for range expansion: {a..z} or {1..10}
        if (/\.\./.test(inner)) {
          return `Brace expansion with range pattern detected: {${inner.slice(0, 40)}}`;
        }
        outerStart = -1;
      }
    }
  }

  return null;
}

// --------------------------------------------------------------------------
// Gate 11: /proc/environ access detection
// --------------------------------------------------------------------------

/**
 * Detect access to /proc/{pid}/environ which leaks environment variables
 * including secrets. Matches /proc/self/environ, /proc/1/environ, etc.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if proc environ access found, null if safe
 */
export function detectProcEnvironAccess(command: string): string | null {
  if (/\/proc\/.*\/environ/.test(command)) {
    return "Access to /proc/*/environ is blocked (environment variable exfiltration).";
  }
  return null;
}

// --------------------------------------------------------------------------
// Gate 12: Comment-quote desync detection
// --------------------------------------------------------------------------

/**
 * Detect comment-quote desync patterns where an unquoted # character is
 * followed by quote characters in the same line. This can be used to inject
 * commands via multi-line input where the first line's comment contains
 * unbalanced quotes that change parsing of subsequent lines.
 *
 * @param command - The raw shell command to analyze
 * @returns Error message if comment-quote desync found, null if safe
 */
export function detectCommentQuoteDesync(command: string): string | null {
  const tracker = new ShellQuoteTracker();

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Check for unquoted # (shell comment start)
    if (ch === "#" && tracker.state === "NORMAL" && !tracker.escaped) {
      // Scan rest of line for quote characters
      const rest = command.slice(i + 1);
      const lineEnd = rest.indexOf("\n");
      const commentContent = lineEnd >= 0 ? rest.slice(0, lineEnd) : rest;
      if (/['"]/.test(commentContent)) {
        return "Comment-quote desync detected: unquoted # followed by quote characters could enable injection.";
      }
      // Skip to end of line since it's a comment
      if (lineEnd >= 0) {
        i += lineEnd + 1;
        continue;
      }
      break; // rest of command is comment
    }

    tracker.feed(ch);
  }

  return null;
}
