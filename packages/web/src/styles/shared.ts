import { css } from "lit";

/**
 * Base reset styles for all Comis web components.
 * Apply via `static styles = [sharedStyles, ...]` in Lit elements.
 */
export const sharedStyles = css`
  :host {
    font-family: var(--ic-font-sans);
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  :host {
    color: var(--ic-text);
  }
`;

/**
 * Focus ring styles for interactive elements.
 * Apply alongside sharedStyles in components with buttons, links, or inputs.
 */
export const focusStyles = css`
  .focusable:focus-visible,
  button:focus-visible,
  a:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--ic-accent);
    outline-offset: 2px;
  }
`;

/**
 * Responsive breakpoint media query strings.
 * Use inside Lit css tagged templates: `@media ${breakpoints.mobile} { ... }`
 * Or in JS for matchMedia: `window.matchMedia(breakpoints.desktopUp)`
 */
export const breakpoints = {
  mobile: "(max-width: 767px)",
  tablet: "(min-width: 768px) and (max-width: 1023px)",
  desktop: "(min-width: 1024px) and (max-width: 1439px)",
  wide: "(min-width: 1440px)",
  tabletUp: "(min-width: 768px)",
  desktopUp: "(min-width: 1024px)",
  wideUp: "(min-width: 1440px)",
} as const;

/**
 * Screen-reader-only utility class.
 * Apply `.sr-only` to elements that should be hidden visually but readable by assistive tech.
 */
export const srOnly = css`
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
`;
