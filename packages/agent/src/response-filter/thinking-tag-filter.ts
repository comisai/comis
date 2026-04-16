/**
 * 7-state streaming thinking tag filter with code-region protection
 * and enforceFinalTag mode.
 *
 * Strips `<think>`, `<thinking>`, `<thought>`, `<antThinking>` blocks from
 * streaming deltas using a character-level state machine. Handles tags split
 * across chunk boundaries by buffering partial tag sequences.
 *
 * When `enforceFinalTag` is enabled, all text outside `<final>` blocks is
 * suppressed and only content inside `<final>` blocks is emitted.
 *
 * Code-region protection preserves tags inside backtick code blocks
 * (fenced and inline) during streaming.
 *
 * @module
 */

/** Streaming thinking tag filter interface. */
export interface ThinkingTagFilter {
  /** Process a streaming delta, returning only visible text. */
  feed(delta: string): string;
  /** Flush any buffered partial tag text (call at stream end). */
  flush(): string;
  /** Reset state for a new message. */
  reset(): void;
}

/** Options for creating a thinking tag filter. */
export interface ThinkingTagFilterOptions {
  /** When true, suppress all text except content inside `<final>` blocks. */
  enforceFinalTag?: boolean;
}

/** Recognized thinking tag names (lowercased). */
const THINKING_TAGS = new Set(["think", "thinking", "thought", "antthinking"]);

/** Recognized final tag names (lowercased). */
const FINAL_TAGS = new Set(["final"]);

/** Union of all recognized tags for buffer classification. */
const ALL_RECOGNIZED_TAGS = new Set([...THINKING_TAGS, ...FINAL_TAGS]);

/** Maximum buffer length before giving up on tag matching. */
const MAX_BUFFER = 24;

type State =
  | "passthrough"
  | "suppressed"
  | "buffering"
  | "inside_block"
  | "close_buffering"
  | "inside_final"
  | "final_buffering";

type BufferResult =
  | { type: "open"; tagName: string; kind: "thinking" | "final" }
  | { type: "close"; tagName: string; kind: "thinking" | "final" }
  | { type: "not_tag" }
  | { type: "partial" };

/**
 * Classify the buffer as a tag open, tag close, not a tag, or partial.
 * Checks against ALL_RECOGNIZED_TAGS and returns a `kind` discriminator.
 */
function classifyBuffer(buf: string): BufferResult {
  if (!buf.startsWith("<")) return { type: "not_tag" };

  const lower = buf.toLowerCase();

  // Check for closing tag pattern: </tagname>
  if (lower.length >= 2 && lower[1] === "/") {
    const rest = lower.slice(2);
    if (rest.endsWith(">")) {
      const tagName = rest.slice(0, -1);
      if (THINKING_TAGS.has(tagName)) {
        return { type: "close", tagName, kind: "thinking" };
      }
      if (FINAL_TAGS.has(tagName)) {
        return { type: "close", tagName, kind: "final" };
      }
      return { type: "not_tag" };
    }
    // Still could be partial
    for (const tag of ALL_RECOGNIZED_TAGS) {
      if (tag.startsWith(rest) || rest.startsWith(tag)) {
        return { type: "partial" };
      }
    }
    return { type: "not_tag" };
  }

  // Check for opening tag pattern: <tagname> or <tagname/>
  const rest = lower.slice(1);

  if (rest.endsWith(">")) {
    let tagName = rest.slice(0, -1);
    if (tagName.endsWith("/")) {
      tagName = tagName.slice(0, -1);
    }
    if (THINKING_TAGS.has(tagName)) {
      return { type: "open", tagName, kind: "thinking" };
    }
    if (FINAL_TAGS.has(tagName)) {
      return { type: "open", tagName, kind: "final" };
    }
    return { type: "not_tag" };
  }

  // Still accumulating -- check if any recognized tag could match
  for (const tag of ALL_RECOGNIZED_TAGS) {
    if (tag.startsWith(rest)) {
      return { type: "partial" };
    }
    if (rest.startsWith(tag) && (rest.length === tag.length || rest[tag.length] === "/")) {
      return { type: "partial" };
    }
  }

  return { type: "not_tag" };
}

/**
 * Create a thinking tag filter that strips thinking blocks from streaming deltas.
 *
 * 7-state FSM:
 * - `passthrough`: Normal text flows through (initial when enforceFinalTag=false)
 * - `suppressed`: All text suppressed (initial when enforceFinalTag=true)
 * - `buffering`: Accumulating chars after `<` to identify a tag
 * - `inside_block`: Inside a thinking tag, all text suppressed
 * - `close_buffering`: Inside a block, checking for matching closing tag
 * - `inside_final`: Inside `<final>`, text emitted (enforceFinalTag only)
 * - `final_buffering`: Inside final, checking for `</final>` or `<thinking>`
 */
export function createThinkingTagFilter(options?: ThinkingTagFilterOptions): ThinkingTagFilter {
  const enforceFinalTag = options?.enforceFinalTag ?? false;
  const initialState: State = enforceFinalTag ? "suppressed" : "passthrough";

  let state: State = initialState;
  let buffer = "";
  let activeTag = "";
  let returnState: State = initialState;
  let returnStateContext: State = initialState; // Tracks parent state when entering buffering
  let seenFinal = false;

  // Code-region tracking
  let inFencedCode = false;
  let inInlineCode = false;
  let consecutiveBackticks = 0;
  let atLineStart = true; // Start of stream counts as line start

  /**
   * Handle a backtick character for code-region tracking.
   * Returns true if the character was consumed by code-region logic
   * and should be emitted directly.
   */
  function handleBacktick(): void {
    consecutiveBackticks++;
  }

  /**
   * Finalize backtick run when a non-backtick character arrives.
   */
  function finalizeBacktickRun(): void {
    if (consecutiveBackticks === 0) return;

    const count = consecutiveBackticks;
    consecutiveBackticks = 0;

    if (count >= 3 && atLineStart) {
      // Toggle fenced code block
      inFencedCode = !inFencedCode;
      if (inFencedCode) {
        inInlineCode = false; // Fenced takes precedence
      }
    } else if (!inFencedCode) {
      // Toggle inline code (only outside fenced blocks)
      // Each backtick toggles; for simplicity odd count toggles
      if (count % 2 === 1) {
        inInlineCode = !inInlineCode;
      }
    }
  }

  function isInCodeRegion(): boolean {
    return inFencedCode || inInlineCode;
  }

  /**
   * Emit buffer content based on current context state.
   * In passthrough/inside_final: emit (push to output).
   * In suppressed: discard.
   */
  function emitBuffer(output: string[], buf: string, contextState: State): void {
    if (contextState === "passthrough" || contextState === "inside_final") {
      output.push(buf);
    }
    // suppressed: discard
  }

  function processChar(ch: string, output: string[]): void {
    // Track backticks and newlines for code-region detection
    if (ch === "`") {
      handleBacktick();
    } else {
      finalizeBacktickRun();
    }

    if (ch === "\n") {
      atLineStart = true;
    } else if (ch !== "`") {
      atLineStart = false;
    }

    // Code-region protection: emit all characters directly when in code
    if (isInCodeRegion()) {
      // Always emit in code regions, regardless of FSM state
      output.push(ch);
      return;
    }

    switch (state) {
      case "passthrough":
        if (ch === "<") {
          buffer = "<";
          returnStateContext = "passthrough";
          state = "buffering";
        } else {
          output.push(ch);
        }
        break;

      case "suppressed":
        if (ch === "<") {
          buffer = "<";
          returnStateContext = "suppressed";
          state = "buffering";
        }
        // else: suppress character
        break;

      case "buffering":
        buffer += ch;

        // Safety limit
        if (buffer.length > MAX_BUFFER) {
          emitBuffer(output, buffer, returnStateContext);
          buffer = "";
          state = returnStateContext;
          break;
        }

        {
          const result = classifyBuffer(buffer);
          if (result.type === "open") {
            if (result.kind === "thinking") {
              activeTag = result.tagName;
              returnState = returnStateContext;
              buffer = "";
              state = "inside_block";
            } else if (result.kind === "final") {
              if (enforceFinalTag) {
                seenFinal = true;
                buffer = "";
                state = "inside_final";
              } else {
                // In default mode, <final> passes through as text
                emitBuffer(output, buffer, returnStateContext);
                buffer = "";
                state = returnStateContext;
              }
            }
          } else if (result.type === "close") {
            if (result.kind === "final" && enforceFinalTag) {
              // Closing </final> outside final block -- discard
              buffer = "";
              state = returnStateContext;
            } else {
              // Closing tag outside a block or non-final close -- emit as text
              emitBuffer(output, buffer, returnStateContext);
              buffer = "";
              state = returnStateContext;
            }
          } else if (result.type === "not_tag") {
            emitBuffer(output, buffer, returnStateContext);
            buffer = "";
            state = returnStateContext;
          }
          // "partial" -- keep buffering
        }
        break;

      case "inside_block":
        if (ch === "<") {
          buffer = "<";
          state = "close_buffering";
        }
        // else: suppress character
        break;

      case "close_buffering":
        buffer += ch;

        // Safety limit
        if (buffer.length > MAX_BUFFER) {
          buffer = "";
          state = "inside_block";
          break;
        }

        {
          const result = classifyBuffer(buffer);
          if (result.type === "close" && result.tagName === activeTag) {
            // Matching closing tag found -- exit block
            buffer = "";
            activeTag = "";
            state = returnState;
          } else if (result.type === "close" || result.type === "open" || result.type === "not_tag") {
            // Non-matching -- stay inside block
            buffer = "";
            state = "inside_block";
          }
          // "partial" -- keep buffering
        }
        break;

      case "inside_final":
        if (ch === "<") {
          buffer = "<";
          returnStateContext = "inside_final";
          state = "final_buffering";
        } else {
          output.push(ch);
        }
        break;

      case "final_buffering":
        buffer += ch;

        // Safety limit
        if (buffer.length > MAX_BUFFER) {
          output.push(buffer);
          buffer = "";
          state = "inside_final";
          break;
        }

        {
          const result = classifyBuffer(buffer);
          if (result.type === "close" && result.kind === "final") {
            // </final> -- exit final block back to suppressed
            buffer = "";
            state = "suppressed";
          } else if (result.type === "open" && result.kind === "thinking") {
            // <thinking> inside <final> -- enter block with returnState=inside_final
            activeTag = result.tagName;
            returnState = "inside_final";
            buffer = "";
            state = "inside_block";
          } else if (result.type === "open" && result.kind === "final") {
            // Nested <final> -- emit as text (unusual but safe)
            output.push(buffer);
            buffer = "";
            state = "inside_final";
          } else if (result.type === "close" && result.kind === "thinking") {
            // Stray thinking close tag inside final -- emit as text
            output.push(buffer);
            buffer = "";
            state = "inside_final";
          } else if (result.type === "not_tag") {
            output.push(buffer);
            buffer = "";
            state = "inside_final";
          }
          // "partial" -- keep buffering
        }
        break;
    }
  }

  return {
    feed(delta: string): string {
      const output: string[] = [];
      for (let i = 0; i < delta.length; i++) {
        processChar(delta[i]!, output);
      }
      return output.join("");
    },

    flush(): string {
      // Finalize any pending backtick run
      finalizeBacktickRun();

      switch (state) {
        case "passthrough":
        case "suppressed":
          return "";

        case "buffering": {
          const result = buffer;
          buffer = "";
          state = returnStateContext;
          // Only emit if context allows it
          if (returnStateContext === "passthrough" || returnStateContext === "inside_final") {
            return result;
          }
          return "";
        }

        case "inside_block":
        case "close_buffering":
          // Discard unclosed thinking content
          buffer = "";
          state = returnState;
          activeTag = "";
          return "";

        case "inside_final":
          // Content already emitted via feed
          return "";

        case "final_buffering": {
          // Partial tag inside <final> -- best-effort emit
          const result = buffer;
          buffer = "";
          state = "inside_final";
          return result;
        }
      }
    },

    reset(): void {
      state = initialState;
      buffer = "";
      activeTag = "";
      returnState = initialState;
      returnStateContext = initialState;
      seenFinal = false;
      inFencedCode = false;
      inInlineCode = false;
      consecutiveBackticks = 0;
      atLineStart = true;
    },
  };
}
