import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/**
 * Format a timestamp as a relative time string.
 * @param timestampMs - Unix timestamp in milliseconds.
 * @param now - Current time in milliseconds (for testability).
 */
function formatRelative(timestampMs: number, now: number): string {
  if (timestampMs <= 0) return "";

  const diffMs = now - timestampMs;
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Auto-updating relative timestamp display.
 *
 * Converts a Unix timestamp (ms) to a human-readable relative time
 * string (e.g., "5m ago") and auto-refreshes at a configurable interval.
 *
 * @example
 * ```html
 * <ic-relative-time .timestamp=${Date.now() - 300000}></ic-relative-time>
 * ```
 */
@customElement("ic-relative-time")
export class IcRelativeTime extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: inline-block;
      }

      time {
        color: var(--ic-text-muted);
        font-size: var(--ic-text-xs);
      }
    `,
  ];

  /** Unix millisecond timestamp. */
  @property({ type: Number }) timestamp = 0;

  /** Refresh interval in milliseconds (default: 1 minute). */
  @property({ type: Number }) updateInterval = 60000;

  private _intervalId: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._startTimer();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._clearTimer();
  }

  private _startTimer(): void {
    this._clearTimer();
    this._intervalId = setInterval(() => {
      this.requestUpdate();
    }, this.updateInterval);
  }

  private _clearTimer(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  override render() {
    if (this.timestamp <= 0) {
      return html``;
    }

    const now = Date.now();
    const isoString = new Date(this.timestamp).toISOString();
    const fullDate = new Date(this.timestamp).toLocaleString();
    const relative = formatRelative(this.timestamp, now);

    return html`
      <time datetime=${isoString} title=${fullDate}>${relative}</time>
    `;
  }
}

/** Exported for testing. */
export { formatRelative };

declare global {
  interface HTMLElementTagNameMap {
    "ic-relative-time": IcRelativeTime;
  }
}
