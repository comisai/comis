import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

/**
 * Represents a single line in the diff output with its change status.
 */
interface DiffLine {
  text: string;
  status: "unchanged" | "added" | "removed";
}

/**
 * Compute a simple line-by-line diff between two text blocks.
 *
 * Lines only in oldText are marked "removed", lines only in newText
 * are marked "added", and shared lines are "unchanged". Uses a
 * longest common subsequence approach for correct ordering.
 */
function computeLineDiff(
  oldText: string,
  newText: string,
): { oldLines: DiffLine[]; newLines: DiffLine[] } {
  const oldArr = oldText.split("\n");
  const newArr = newText.split("\n");

  // Build LCS table
  const m = oldArr.length;
  const n = newArr.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldArr[i - 1] === newArr[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const _oldLines: DiffLine[] = [];
  const _newLines: DiffLine[] = [];
  let i = m;
  let j = n;

  const oldResult: DiffLine[] = [];
  const newResult: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldArr[i - 1] === newArr[j - 1]) {
      oldResult.push({ text: oldArr[i - 1], status: "unchanged" });
      newResult.push({ text: newArr[j - 1], status: "unchanged" });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      newResult.push({ text: newArr[j - 1], status: "added" });
      oldResult.push({ text: "", status: "unchanged" }); // blank spacer
      j--;
    } else {
      oldResult.push({ text: oldArr[i - 1], status: "removed" });
      newResult.push({ text: "", status: "unchanged" }); // blank spacer
      i--;
    }
  }

  oldResult.reverse();
  newResult.reverse();

  return { oldLines: oldResult, newLines: newResult };
}

/**
 * Side-by-side diff viewer for comparing two text blocks.
 *
 * Renders a two-column layout with line-based diff highlighting.
 * Lines only in the old text get a red/deletion background, lines
 * only in the new text get a green/addition background, and shared
 * lines have the default background.
 *
 * Both columns scroll in sync via shared scroll event handling.
 *
 * @example
 * ```html
 * <ic-diff-viewer
 *   .oldText=${"key: old-value"}
 *   .newText=${"key: new-value"}
 *   oldLabel="Current"
 *   newLabel="Pending"
 * ></ic-diff-viewer>
 * ```
 */
@customElement("ic-diff-viewer")
export class IcDiffViewer extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .diff-container {
        display: grid;
        grid-template-columns: 1fr 1fr;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
        background: var(--ic-bg-card, var(--ic-surface));
      }

      .diff-panel {
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow: hidden;
      }

      .diff-panel + .diff-panel {
        border-left: 1px solid var(--ic-border);
      }

      .diff-header {
        padding: var(--ic-space-xs) var(--ic-space-md);
        background: var(--ic-surface-2);
        border-bottom: 1px solid var(--ic-border);
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .diff-body {
        overflow: auto;
        max-height: 24rem;
      }

      pre {
        margin: 0;
        padding: 0;
      }

      code {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm);
        line-height: 1.6;
        white-space: pre;
        tab-size: 2;
        display: block;
      }

      .line {
        display: block;
        padding: 0 var(--ic-space-md);
        min-height: 1.6em;
      }

      .line--removed {
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
        color: var(--ic-text);
      }

      .line--added {
        background: color-mix(in srgb, var(--ic-success) 15%, transparent);
        color: var(--ic-text);
      }

      .line--spacer {
        opacity: 0.3;
      }

      .no-changes {
        padding: var(--ic-space-lg);
        text-align: center;
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        grid-column: 1 / -1;
      }
    `,
  ];

  /** The original/old text content. */
  @property() oldText = "";

  /** The new/modified text content. */
  @property() newText = "";

  /** Label for the old (left) column. */
  @property() oldLabel = "Current";

  /** Label for the new (right) column. */
  @property() newLabel = "Pending";

  @state() private _syncing = false;

  private _handleScroll(e: Event, targetClass: string): void {
    if (this._syncing) return;
    this._syncing = true;

    const source = e.target as HTMLElement;
    const other = this.shadowRoot?.querySelector(`.${targetClass}`) as HTMLElement | null;

    if (other) {
      other.scrollTop = source.scrollTop;
      other.scrollLeft = source.scrollLeft;
    }

    requestAnimationFrame(() => {
      this._syncing = false;
    });
  }

  private _renderLines(lines: DiffLine[]) {
    return lines.map((line) => {
      let cls = "line";
      if (line.status === "removed") cls += " line--removed";
      else if (line.status === "added") cls += " line--added";
      else if (line.text === "") cls += " line--spacer";
      return html`<span class=${cls}>${line.text || " "}</span>`;
    });
  }

  override render() {
    if (this.oldText === this.newText) {
      return html`
        <div class="diff-container">
          <div class="no-changes">No changes detected</div>
        </div>
      `;
    }

    const { oldLines, newLines } = computeLineDiff(this.oldText, this.newText);

    return html`
      <div class="diff-container">
        <div class="diff-panel">
          <div class="diff-header">${this.oldLabel}</div>
          <div
            class="diff-body diff-body--old"
            @scroll=${(e: Event) => this._handleScroll(e, "diff-body--new")}
          >
            <pre><code>${this._renderLines(oldLines)}</code></pre>
          </div>
        </div>
        <div class="diff-panel">
          <div class="diff-header">${this.newLabel}</div>
          <div
            class="diff-body diff-body--new"
            @scroll=${(e: Event) => this._handleScroll(e, "diff-body--old")}
          >
            <pre><code>${this._renderLines(newLines)}</code></pre>
          </div>
        </div>
      </div>
    `;
  }
}

/** Exported for testing. */
export { computeLineDiff };

declare global {
  interface HTMLElementTagNameMap {
    "ic-diff-viewer": IcDiffViewer;
  }
}
