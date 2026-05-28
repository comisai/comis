// SPDX-License-Identifier: Apache-2.0
/**
 * Vitest setup for @comis/web (happy-dom environment).
 *
 * Several views download a blob by building an `<a download href={objectUrl}>`
 * and calling `a.click()`. happy-dom (20.x) treats that click as a frame
 * navigation and, inside its detached-frame navigator, evaluates
 * `new URL(href)`. Multiple view tests mock the blob helpers with
 * `vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL })`, which
 * replaces the `URL` CONSTRUCTOR with a plain object — so the navigation throws
 * `TypeError: URL is not a constructor`. That throw is asynchronous, so vitest
 * attributes it to whichever test happens to be running, producing flaky
 * cross-file failures (e.g. an unrelated suite "fails" with this stack).
 *
 * Real browsers treat an `<a download>` click as a file download, NOT a
 * navigation, so suppressing the navigation here is correct behavior emulation
 * — there is nowhere to download to in a headless env. We no-op `click()` ONLY
 * for download anchors and defer to the native click for everything else (nav
 * links, buttons, etc.), so click-handler tests are unaffected.
 */

const nativeAnchorClick = HTMLAnchorElement.prototype.click;

HTMLAnchorElement.prototype.click = function patchedClick(
  this: HTMLAnchorElement,
): void {
  // Download anchors trigger a browser download, not a navigation. Skip
  // happy-dom's (crash-prone) navigation for them; pass through otherwise.
  if (this.hasAttribute("download")) {
    return;
  }
  nativeAnchorClick.call(this);
};
