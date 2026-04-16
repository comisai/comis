import { LitElement, html, svg, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "../../styles/shared.js";

/**
 * Focused SVG path data for the 8 supported chat platforms.
 * Duplicated from ic-icon.ts to keep this component lightweight
 * (only 8 paths vs. 40+ in the full icon map).
 */
const PLATFORM_PATHS: Record<string, string> = {
  telegram:
    "M20.3 3.5L2.6 10.3c-1.2.5-1.2 1.2-.2 1.5l4.5 1.4 1.7 5.3c.2.6.1.8.7.8.4 0 .7-.2.9-.4l2.2-2.1 4.5 3.3c.8.5 1.4.2 1.6-.8l2.9-13.6c.3-1.3-.5-1.9-1.6-1.2zM8.4 13l8.7-5.4c.4-.3.8-.1.5.2l-7.1 6.4-.3 3.1-1.8-4.3z",
  discord:
    "M19.5 5.6A16 16 0 0015.5 4a12 12 0 00-.5 1.1 15 15 0 00-6 0A12 12 0 008.5 4 16 16 0 004.5 5.6 17 17 0 002 18.6a16 16 0 005 2.5c.4-.6.8-1.2 1.1-1.8a10 10 0 01-1.7-1l.4-.3a11.5 11.5 0 0010.4 0l.4.3c-.5.4-1.1.7-1.7 1 .3.6.7 1.2 1.1 1.8a16 16 0 005-2.5A17 17 0 0019.5 5.6zM8.3 16c-1 0-1.8-1-1.8-2.1s.8-2.1 1.8-2.1 1.9 1 1.8 2.1S9.4 16 8.3 16zm7.4 0c-1 0-1.8-1-1.8-2.1s.8-2.1 1.8-2.1 1.9 1 1.8 2.1S16.8 16 15.7 16z",
  slack:
    "M5.1 15c0 1-.8 1.8-1.8 1.8S1.5 16 1.5 15s.8-1.8 1.8-1.8h1.8V15zm.9 0c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8v4.5c0 1-.8 1.8-1.8 1.8S6 20.5 6 19.5V15zM9 5.1c-1 0-1.8-.8-1.8-1.8S8 1.5 9 1.5s1.8.8 1.8 1.8v1.8H9zm0 .9c1 0 1.8.8 1.8 1.8S10 9.6 9 9.6H4.5c-1 0-1.8-.8-1.8-1.8S3.5 6 4.5 6H9zm9.9 1.8c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8-.8 1.8-1.8 1.8h-1.8V7.8zm-.9 0c0 1-.8 1.8-1.8 1.8S14.4 8.8 14.4 7.8V3.3c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8v4.5zM15 18.9c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8-1.8-.8-1.8-1.8v-1.8H15zm0-.9c-1 0-1.8-.8-1.8-1.8s.8-1.8 1.8-1.8h4.5c1 0 1.8.8 1.8 1.8s-.8 1.8-1.8 1.8H15z",
  whatsapp:
    "M17.5 14.4c-.3-.1-1.6-.8-1.9-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.4-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.2-.5.1-.2 0-.3 0-.5s-.7-1.6-.9-2.2c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.3-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5 4.5.7.3 1.3.5 1.7.6.7.2 1.3.2 1.8.1.6-.1 1.6-.7 1.9-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3zM12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.3 4.9L2 22l5.2-1.4c1.4.8 3 1.2 4.8 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2z",
  line: "M22 10.8c0-4.8-4.8-8.7-10.8-8.7S.4 6 .4 10.8c0 4.3 3.8 7.9 9 8.6.3.1.8.2.9.5.1.3.1.6 0 .9l-.1.9c0 .3-.2 1.1.9.6s6.2-3.7 8.5-6.3c1.6-1.6 2.4-3.4 2.4-5.2zM7.5 13.3H5.7c-.3 0-.5-.2-.5-.5V9.2c0-.3.2-.5.5-.5s.5.2.5.5v3.1h1.3c.3 0 .5.2.5.5s-.2.5-.5.5zm1.9-.5c0 .3-.2.5-.5.5s-.5-.2-.5-.5V9.2c0-.3.2-.5.5-.5s.5.2.5.5v3.6zm5 0c0 .2-.1.4-.3.4l-.2.1-2.5-3.4v3c0 .3-.2.5-.5.5s-.5-.2-.5-.5V9.2c0-.2.1-.4.3-.4h.1l2.6 3.5V9.2c0-.3.2-.5.5-.5s.5.2.5.5v3.6zm3.5.5h-1.8c-.3 0-.5-.2-.5-.5V9.2c0-.3.2-.5.5-.5s.5.2.5.5v3.1h1.3c.3 0 .5.2.5.5s-.2.5-.5.5z",
  signal:
    "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 3c3.9 0 7 3.1 7 7s-3.1 7-7 7-7-3.1-7-7 3.1-7 7-7zm0 3a4 4 0 100 8 4 4 0 000-8zm0 2.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z",
  imessage:
    "M12 2C6.5 2 2 5.8 2 10.5c0 2.7 1.5 5.1 3.8 6.7-.2 1-.6 2.5-1.8 3.8 2.1-.3 3.8-1.1 4.8-1.8.9.2 2 .3 3.2.3 5.5 0 10-3.8 10-8.5S17.5 2 12 2z",
  irc: "M4 4h16v12H5.2L4 17.2V4zm2 2v8h12V6H6zm2 2h8v1H8V8zm0 3h6v1H8v-1z",
};

/** Platform-specific colors matching ic-tag design token naming. */
const PLATFORM_COLORS: Record<string, string> = {
  telegram: "var(--ic-telegram)",
  discord: "var(--ic-discord)",
  slack: "var(--ic-slack)",
  whatsapp: "var(--ic-whatsapp)",
  line: "var(--ic-line)",
  signal: "var(--ic-signal)",
  imessage: "var(--ic-imessage)",
  irc: "var(--ic-irc)",
};

/** Fallback circle icon for unknown platforms. */
const FALLBACK_PATH = "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z";

/**
 * Platform-specific SVG icon component.
 *
 * Renders inline SVG icons for the 8 supported chat platforms
 * with platform-specific fill colors. Unknown platforms render
 * a generic circle in muted color.
 *
 * @example
 * ```html
 * <ic-platform-icon platform="telegram"></ic-platform-icon>
 * <ic-platform-icon platform="discord" size="24px"></ic-platform-icon>
 * ```
 */
@customElement("ic-platform-icon")
export class IcPlatformIcon extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
      }

      svg {
        display: block;
      }
    `,
  ];

  /** Platform identifier (telegram, discord, slack, whatsapp, line, signal, imessage, irc). */
  @property() platform = "";

  /** CSS size applied to both width and height. */
  @property() size = "20px";

  override render() {
    const key = this.platform.toLowerCase();
    const path = PLATFORM_PATHS[key] ?? FALLBACK_PATH;
    const color = PLATFORM_COLORS[key] ?? "var(--ic-text-dim)";

    return html`
      <svg
        width=${this.size}
        height=${this.size}
        viewBox="0 0 24 24"
        fill=${color}
        aria-hidden="true"
      >
        ${svg`<path d=${path} />`}
      </svg>
    `;
  }
}

/** Supported platform names for testing. */
export const platformNames = Object.keys(PLATFORM_PATHS);

declare global {
  interface HTMLElementTagNameMap {
    "ic-platform-icon": IcPlatformIcon;
  }
}
