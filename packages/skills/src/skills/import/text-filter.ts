// SPDX-License-Identifier: Apache-2.0
/**
 * Text-only filter for the staged skill import.
 *
 * Import is prompt-only: a skill is its Markdown instructions plus supporting
 * text (references, templates). This pure, in-memory pass takes the unpacked
 * entry set and keeps ONLY UTF-8 text files, dropping everything that could
 * carry an execution vector:
 *   - anything under a `scripts/` directory (the conventional executable dir),
 *   - any entry that arrived with a Unix exec bit,
 *   - any known executable / script / binary file extension, and
 *   - any file whose bytes are not valid UTF-8.
 *
 * Each drop is reported with a reason naming the exact trigger so the pipeline
 * can WARN it. The pipeline then writes ONLY the kept files to staging — a
 * dropped file is never decoded into the kept set and therefore never reaches
 * disk (so the live skill directory can only ever contain post-filter text).
 *
 * @module
 */

/** One unpacked entry to filter (the shape the archive reader returns). */
export interface TextFilterEntry {
  /** Path relative to the located skill root. */
  readonly relPath: string;
  /** Whether the source entry carried a Unix exec bit. */
  readonly execBit: boolean;
  /** Uncompressed file bytes. */
  readonly bytes: Buffer;
}

/** A file kept as UTF-8 text, decoded once for scanning + writing. */
export interface KeptTextFile {
  readonly relPath: string;
  /** The file bytes decoded as strict UTF-8. */
  readonly content: string;
}

/** A dropped entry plus the reason naming its trigger. */
export interface DroppedEntry {
  readonly relPath: string;
  readonly reason: string;
}

/** The filter outcome: survivors + reasoned drops. */
export interface TextFilterResult {
  readonly kept: KeptTextFile[];
  readonly drops: DroppedEntry[];
}

/**
 * File extensions that indicate an executable, script, or compiled/binary
 * payload. Import never keeps any of these (prompt-only). The check is on the
 * lowercased final extension segment.
 */
const EXECUTABLE_OR_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // shells + interpreted scripts
  "sh", "bash", "zsh", "fish", "ksh", "csh", "ps1", "psm1", "bat", "cmd", "com",
  "py", "pyc", "pyo", "pyw", "rb", "pl", "pm", "php", "phar", "lua", "tcl", "r",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "coffee", "vbs", "vbe", "wsf", "jse",
  // compiled / native / bytecode / packaged
  "exe", "dll", "so", "dylib", "o", "a", "obj", "lib", "wasm", "bin", "class",
  "jar", "elf", "out", "app", "msi", "deb", "rpm", "apk", "dmg", "pkg", "scpt",
  "command", "action", "workflow", "reg",
]);

/** The lowercased final extension of a path, or `undefined` (no ext / dotfile). */
function extensionOf(relPath: string): string | undefined {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // `dot <= 0` covers both "no dot" and a leading-dot dotfile (".gitignore").
  if (dot <= 0) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

/** Non-empty, forward-slash path segments. */
function segmentsOf(relPath: string): string[] {
  return relPath.split("/").filter((s) => s.length > 0);
}

/**
 * Apply the text-only drop rules to an in-memory entry set. Pure: no I/O,
 * no mutation of the input. Every dropped entry carries a reason naming the
 * trigger; every kept entry is valid UTF-8 text decoded once.
 */
export function applyTextFilter(entries: readonly TextFilterEntry[]): TextFilterResult {
  const kept: KeptTextFile[] = [];
  const drops: DroppedEntry[] = [];

  for (const entry of entries) {
    if (segmentsOf(entry.relPath).includes("scripts")) {
      drops.push({
        relPath: entry.relPath,
        reason: "sits under a scripts/ directory (import is prompt-only; executables are not kept)",
      });
      continue;
    }
    if (entry.execBit) {
      drops.push({
        relPath: entry.relPath,
        reason: "carries a Unix exec bit (import is prompt-only; executables are not kept)",
      });
      continue;
    }
    const ext = extensionOf(entry.relPath);
    if (ext !== undefined && EXECUTABLE_OR_BINARY_EXTENSIONS.has(ext)) {
      drops.push({
        relPath: entry.relPath,
        reason: `has the executable/binary file extension .${ext} (import keeps text only)`,
      });
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes);
    } catch {
      drops.push({
        relPath: entry.relPath,
        reason: "is not valid UTF-8 text (import keeps text only)",
      });
      continue;
    }
    kept.push({ relPath: entry.relPath, content });
  }

  return { kept, drops };
}
