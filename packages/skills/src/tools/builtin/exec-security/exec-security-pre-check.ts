// SPDX-License-Identifier: Apache-2.0
/**
 * Exec command security — pre-pipeline sanitization gates.
 *
 * Owns the gates that run BEFORE compound-splitting in the validation
 * pipeline:
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
      // $( command substitution — but NOT $(( arithmetic (F-18; a nested $(cmd) is still caught at its own position).
      if (
        ch === "$" &&
        i + 1 < command.length &&
        command[i + 1] === "(" &&
        command[i + 2] !== "(" &&
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
 * curl/wget as pipe targets are allowed ONLY when no upload/data flag is present.
 * All other DANGEROUS_PIPE_TARGETS remain unconditionally blocked.
 */
const READ_ONLY_PIPE_TARGETS = new Set(["curl", "wget"]);

/**
 * Flags that transform a curl/wget pipe target into a data-exfiltration risk.
 * Conservative: any flag that sends data to a remote server.
 *
 * Detection strategy:
 *   1. Short-flag cluster containing an upload letter (d/F/T), caught ANYWHERE in the cluster —
 *      e.g. `-sd`, `-fsSd`, `-kT`, `-sF`, and attached-value forms `-Fs=@-`/`-ds=@-`/`-Ts=@-`.
 *      curl lets the first value-taking letter consume the cluster remainder as its argument
 *      (`-Fs=@-` ≡ `-F s=@-`, a multipart upload of stdin — verified vs curl 8.7.1), so there is
 *      NO trailing `\b`: `(?:^|\s)-[A-Za-z]*[dFT]` matches the letter mid-cluster; the leading
 *      `(?:^|\s)-` still avoids `-`-prefixed filenames. Case-sensitive (lowercase d, uppercase
 *      F/T). NOT matched: `-o`/`-O`/`-s`/`-S`/`-k`/`-L`/`-f`/`-G`/`-I`/`-D` (read-only/benign).
 *   2. Long-form upload flags: `--upload-file`, `--data*`, `--form`, `--post-data`,
 *      `--post-file`, `--body-data`, `--body-file` (wget-specific).
 *   3. `-X POST`/`-X PUT` with optional space (covers both `-X POST` and `-XPOST`).
 *   4. `--method=POST`/`--method=PUT`.
 *
 * Residual known gap (accepted design): `-H "…"` header injection is allowed because
 * `-H` is required for legitimate read-only API calls (Accept, Authorization).
 * The egress allowlist (exec-security-allowlist.ts) is the backstop for that vector.
 */
const CURL_UPLOAD_FLAGS =
  // 1. Bundled short-flag cluster with upload letter d (data), F (form), or T (upload-file),
  //    caught ANYWHERE in the cluster — including before an attached value (`-Fs=@-`). No trailing
  //    `\b`: requiring the letter at cluster end missed attached-value forms (verified vs curl 8.7.1).
  //    Case-sensitive: uppercase D is --dump-header, not data; uppercase O/I/L/G stay read-only.
  /(?:^|\s)-[A-Za-z]*[dFT]|(?:^|\s)(?:--upload-file|--data(?:-raw|-binary|-urlencode)?|--form|--post-data|--post-file|--body-(?:data|file))\b|(?:^|\s)-X\s*(?:POST|PUT)\b|--method=(?:POST|PUT)\b/;

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
      // curl/wget: allow ONLY when no upload/data flag is present in the segment.
      // nc/ncat/socat/telnet/sh/bash/...: unconditionally blocked (not in READ_ONLY_PIPE_TARGETS).
      if (READ_ONLY_PIPE_TARGETS.has(basename) && !CURL_UPLOAD_FLAGS.test(segment)) {
        continue; // read-only pipe target — no upload/data flag found
      }
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
  const tracker = new ShellQuoteTracker();
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // CRITICAL: capture quote state BEFORE feeding — tracker.feed() mutates state
    // immediately on quote chars, so checking state AFTER feed would incorrectly
    // treat the opening quote character itself as "inside a quote" (check-before-feed
    // mirrors validateRedirectTargets:288 pattern).
    //
    // A pending backslash escape (tracker.escaped) is NOT a quoted context. In bash,
    // `\` + newline is a line continuation that joins the next physical line as
    // executable code — exactly the injection vector Gate 0 must block. Only suppress
    // newline rejection when genuinely inside single/double quotes (state !== "NORMAL").
    const inQuote = tracker.state !== "NORMAL";

    if (ch === "\n") {
      // U+000A: only reject when NOT inside a quoted context.
      // A newline inside single/double quotes is legitimate (multi-line script body).
      if (!inQuote) {
        const looksLikeFileWrite = FILE_WRITE_HEURISTIC.test(command);
        let msg = `Command contains invisible/ambiguous character U+000A at position ${i}. This can bypass security validation. Remove the character and retry.`;
        msg += looksLikeFileWrite
          ? ` To write files, use the 'write' tool (or 'edit' for targeted changes) instead of a shell heredoc in exec.`
          : ` For multi-line scripts, use command='python3 -' (or 'node -', 'bash -') with the 'input' parameter for the script body.`;
        return msg;
      }
      // In a quoted context: allow and continue.
    } else {
      // For all non-newline chars: apply the full INVISIBLE_CHAR_REGEX without quote context.
      // These characters (zero-width spaces, BOM, soft hyphen, etc.) have no legitimate use
      // even inside quoted strings, so quote context is irrelevant for them.
      const singleMatch = INVISIBLE_CHAR_REGEX.exec(ch);
      if (singleMatch) {
        const cp = ch.codePointAt(0)!;
        const hex = cp.toString(16).toUpperCase().padStart(4, "0");
        return `Command contains invisible/ambiguous character U+${hex} at position ${i}. This can bypass security validation. Remove the character and retry.`;
      }
    }

    tracker.feed(ch);
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

/**
 * Auto-rewrite `<interp> -c "<multiline body>"` to the stdin form
 * (`<interp> -` + `input: <body>`) before security validation.
 *
 * LLMs frequently send `python3 -c "import x\nprint(1)"` patterns where the
 * quoted body contains a literal `\n` newline character. Gate 0 correctly
 * blocks newlines in commands (injection prevention), so the call fails with
 * `[invalid_value]`. The LLM then retries the same pattern several times.
 *
 * This rewrite extracts the body and routes it via stdin (the same
 * mechanism `extractHeredoc` uses) so the script runs without hitting the
 * newline gate. The body is preserved verbatim — `\n` is the literal
 * U+000A character the LLM emitted inside the quotes; we do NOT unescape
 * `\n` / `\t` (the LLM either meant a real newline or a literal backslash-n,
 * and the former is the common case that triggers Gate 0).
 *
 * Only rewrites when ALL of:
 *   - the interpreter is in the allowed set (python/python3, node, bash, sh,
 *     ruby, perl, php) — the same set extractHeredoc accepts;
 *   - the captured body contains at least one `\n` (single-line `-c` calls
 *     are not the source of Gate-0 retries and stay untouched);
 *   - the caller's `input` parameter is undefined (do not clobber caller-
 *     supplied stdin — that would silently change semantics).
 *
 * A command that contains BOTH `-c "..."` AND a heredoc is malformed and
 * falls through to Gate-0; the caller should use one form or the other.
 *
 * Returns null if no rewrite applies.
 */
export function extractDashCArg(
  command: string,
  input: string | undefined,
): { command: string; input: string } | null {
  if (input !== undefined) return null;

  // Anchored at start; trailing whitespace tolerated. Capture groups:
  //   1: interpreter prefix (incl. trailing whitespace)
  //   2: opening quote character (single or double)
  //   3: body — anything until the matching closing quote on the same string
  const match = command.match(
    /^((?:python3?|node|bash|sh|ruby|perl|php)\s+)-c\s+(["'])([\s\S]*?)\2\s*$/,
  );
  if (!match) return null;

  const interpreter = match[1].trim();
  const body = match[3];

  // Single-line bodies are not the Gate-0 retry source; leave them.
  if (!body.includes("\n")) return null;

  return { command: `${interpreter} -`, input: body };
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
