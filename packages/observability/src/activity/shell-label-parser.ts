// SPDX-License-Identifier: Apache-2.0
/**
 * shell-label-parser — a deterministic summarizer for known shell exec commands.
 *
 * `bash`/`exec`/`shell` tool calls carry a free-form command string. This pure
 * parser turns it into a concise human label so the activity stream can render
 * `bash "head -20 file.ts | sed -n '1,80p'"` as
 * `"show first 20 lines of file.ts (+1 steps)"`. Deterministic — no LLM, no
 * dynamic code execution, no command execution: the command string is only
 * ever tokenized and matched, never run.
 *
 * Pipelines (`a | b | c`) summarize the FIRST stage and append a `(+N steps)`
 * counter for the remaining stages. Long arguments are truncated so the label
 * stays bounded.
 *
 * Secret redaction: the produced label is run through the core
 * `redactValue` primitive before it is returned, so a secret-bearing operand
 * that flows into the label (e.g. a `grep 'Bearer …'` pattern, a file path) is
 * masked to `<redacted>`. The parser itself never executes the command — it
 * only ever tokenizes and matches the string. Redaction here is the primary
 * defense (there is no separate re-redaction of an arbitrary already-rendered
 * label downstream — the ActivityStream redacts params, not parser output).
 *
 * @module
 */
import { redactValue } from "@comis/core";

/** Hard cap on the produced label so a pathological command cannot blow up a render. */
const MAX_LABEL_LENGTH = 120;
/** Per-argument truncation so a single huge token cannot dominate the label. */
const MAX_ARG_LENGTH = 40;

/**
 * Summarize a shell command string into a concise activity label.
 *
 * @param cmd - the raw command string (already neutral — no secrets in inputs)
 * @returns a bounded human label; pipelines append `(+N steps)`
 */
export function parseShellCommand(cmd: string): string {
  const stages = splitPipeline(cmd);
  const first = stages[0] ?? "";
  const extra = stages.length - 1;

  let label = summarizeStage(first);
  if (extra > 0) {
    label = `${label} (+${extra} steps)`;
  }
  // Mask any secret / PII / absolute-path shape that flowed into
  // the label (e.g. a grep pattern or file operand) before returning. redactValue
  // on a string leaf returns the redacted string in `.value` (pure, non-throwing,
  // no homeDir needed here — $HOME compaction is applied at the param emit site).
  const redacted = redactValue(label).value;
  label = typeof redacted === "string" ? redacted : label;
  // Bound AFTER redaction so the final label stays within the cap even when a
  // `<redacted>` substitution lengthened it.
  if (label.length > MAX_LABEL_LENGTH) {
    label = label.slice(0, MAX_LABEL_LENGTH - 1).trimEnd() + "…";
  }
  return label;
}

// ---------------------------------------------------------------------------
// Stage summarizers (one per recognized utility)
// ---------------------------------------------------------------------------

/**
 * Summarize a single (non-piped) command stage. Recognizes head/tail/sed/grep;
 * everything else falls back to `run \`<cmd>\``.
 */
function summarizeStage(stage: string): string {
  const tokens = tokenize(stage);
  const cmd = tokens[0] ?? "";

  switch (cmd) {
    case "head":
      return summarizeHead(tokens);
    case "tail":
      return summarizeTail(tokens);
    case "sed":
      return summarizeSed(tokens);
    case "grep":
      return summarizeGrep(tokens);
    case "cat":
      return summarizeCat(tokens);
    default:
      return `run \`${truncateArg(cmd || "command")}\``;
  }
}

/** `head -n N file` / `head -N file` → "show first N lines of file". */
function summarizeHead(tokens: readonly string[]): string {
  const n = extractCount(tokens);
  const file = lastFileArg(tokens);
  const lines = n !== undefined ? `${n} lines` : "lines";
  return file !== undefined ? `show first ${lines} of ${file}` : `show first ${lines}`;
}

/** `tail -f file` → "follow file"; `tail -n N file` → "show last N lines of file". */
function summarizeTail(tokens: readonly string[]): string {
  const file = lastFileArg(tokens);
  if (tokens.includes("-f") || tokens.includes("--follow")) {
    return file !== undefined ? `follow ${file}` : "follow stream";
  }
  const n = extractCount(tokens);
  const lines = n !== undefined ? `${n} lines` : "lines";
  return file !== undefined ? `show last ${lines} of ${file}` : `show last ${lines}`;
}

/** `sed -n '1,30p' file` → "print lines 1-30 of file". */
function summarizeSed(tokens: readonly string[]): string {
  const file = lastFileArg(tokens);
  for (const tok of tokens) {
    const range = parseSedRange(tok);
    if (range !== undefined) {
      return file !== undefined
        ? `print lines ${range} of ${file}`
        : `print lines ${range}`;
    }
  }
  return file !== undefined ? `edit ${file} with sed` : "run sed";
}

/** `grep [-r] pattern target` → "search for `pattern` in target". */
function summarizeGrep(tokens: readonly string[]): string {
  // First non-flag token after `grep` is the pattern; the next is the target.
  const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
  const pattern = operands[0];
  const target = operands[1];
  if (pattern === undefined) return "search with grep";
  const where = target !== undefined ? ` in ${truncateArg(target)}` : "";
  return `search for \`${truncateArg(pattern)}\`${where}`;
}

/** `cat file` → "show file". */
function summarizeCat(tokens: readonly string[]): string {
  const file = lastFileArg(tokens);
  return file !== undefined ? `show ${file}` : "show stdin";
}

// ---------------------------------------------------------------------------
// Tokenization + parsing helpers (pure string transforms — never run code)
// ---------------------------------------------------------------------------

/**
 * Split a command string on top-level `|` pipes. Pipes inside single or double
 * quotes do not split (so `sed -n '1,80p'` is one stage even if it held a `|`).
 */
function splitPipeline(cmd: string): string[] {
  const stages: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const ch of cmd) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|") {
      stages.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) stages.push(current.trim());
  return stages;
}

/**
 * Tokenize a single stage into whitespace-separated tokens, preserving quoted
 * spans as one token (with quotes stripped). Pure — never executes anything.
 */
function tokenize(stage: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let sawAny = false;
  for (const ch of stage) {
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      sawAny = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawAny = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (sawAny) {
        tokens.push(current);
        current = "";
        sawAny = false;
      }
      continue;
    }
    current += ch;
    sawAny = true;
  }
  if (sawAny) tokens.push(current);
  return tokens;
}

/**
 * Extract a numeric line count from `-n N`, `-nN`, or `-N` short flags.
 * Returns undefined when no count flag is present.
 */
function extractCount(tokens: readonly string[]): number | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-n" || tok === "--lines") {
      const next = tokens[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) return Number(next);
    }
    // `-n20`
    const nMatch = /^-n(\d+)$/.exec(tok);
    if (nMatch) return Number(nMatch[1]);
    // bare `-20`
    const shortMatch = /^-(\d+)$/.exec(tok);
    if (shortMatch) return Number(shortMatch[1]);
  }
  return undefined;
}

/** Parse a `sed -n '1,30p'` range token → "1-30". Returns undefined if not a range. */
function parseSedRange(tok: string): string | undefined {
  const m = /^(\d+),(\d+)p$/.exec(tok);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}`;
}

/**
 * The last positional (non-flag) argument — the file operand for head/tail/cat.
 * `.` (the grep recursive-dir operand) and pure flags are excluded.
 */
function lastFileArg(tokens: readonly string[]): string | undefined {
  for (let i = tokens.length - 1; i >= 1; i--) {
    const tok = tokens[i];
    if (tok.startsWith("-")) continue;
    if (/^\d+$/.test(tok)) continue; // a bare count consumed by -n
    return truncateArg(tok);
  }
  return undefined;
}

/** Bound a single argument so one huge token cannot dominate the label. */
function truncateArg(arg: string): string {
  if (arg.length <= MAX_ARG_LENGTH) return arg;
  return arg.slice(0, MAX_ARG_LENGTH - 1) + "…";
}
