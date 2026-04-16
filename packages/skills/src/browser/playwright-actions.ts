/**
 * Browser UI interaction actions.
 *
 * Provides an executeAction() dispatcher that handles all browser
 * interaction kinds: click, type, press, hover, drag, select, fill,
 * and close. Elements are resolved by ref (e.g., "e12" from a
 * snapshot) or CSS selector.
 *
 * Ported from Comis browser/pw-tools-core.interactions.ts +
 * pw-tools-core.shared.ts, adapted for Comis's in-process pattern.
 *
 * @module
 */

import type { Page } from "playwright-core";
import {
  ensurePageState,
  refLocator,
} from "./playwright-session.js";

// ── Types ────────────────────────────────────────────────────────────

/** A form field for batch fill operations. */
export type FormField = {
  ref: string;
  type: string;
  value: string | number | boolean;
};

/** Base action parameters with optional targetId. */
export type ActionBase = {
  targetId?: string;
};

export type ClickAction = ActionBase & {
  kind: "click";
  ref: string;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
};

export type TypeAction = ActionBase & {
  kind: "type";
  ref: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
};

export type PressAction = ActionBase & {
  kind: "press";
  key: string;
  delayMs?: number;
};

export type HoverAction = ActionBase & {
  kind: "hover";
  ref: string;
};

export type DragAction = ActionBase & {
  kind: "drag";
  startRef: string;
  endRef: string;
};

export type SelectAction = ActionBase & {
  kind: "select";
  ref: string;
  values: string[];
};

export type FillAction = ActionBase & {
  kind: "fill";
  fields: FormField[];
};

export type CloseAction = ActionBase & {
  kind: "close";
};

export type BrowserAction =
  | ClickAction
  | TypeAction
  | PressAction
  | HoverAction
  | DragAction
  | SelectAction
  | FillAction
  | CloseAction;

export type ActionResult = {
  ok: boolean;
  action: string;
  error?: string;
};

// ── Helpers ──────────────────────────────────────────────────────────

const DEFAULT_ACTION_TIMEOUT = 8_000;

function normalizeTimeout(timeoutMs?: number): number {
  return Math.max(500, Math.min(60_000, timeoutMs ?? DEFAULT_ACTION_TIMEOUT));
}

function requireRef(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const ref = raw.startsWith("@") ? raw.slice(1) : raw;
  if (!ref) throw new Error("ref is required");
  return ref;
}

/**
 * Convert Playwright errors to user-friendly messages for AI agents.
 */
function toFriendlyError(error: unknown, selector: string): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("strict mode violation")) {
    const countMatch = message.match(/resolved to (\d+) elements/);
    const count = countMatch ? countMatch[1] : "multiple";
    return new Error(
      `Selector "${selector}" matched ${count} elements. ` +
        "Run a new snapshot to get updated refs, or use a different ref.",
    );
  }

  if (
    (message.includes("Timeout") || message.includes("waiting for")) &&
    (message.includes("to be visible") || message.includes("not visible"))
  ) {
    return new Error(
      `Element "${selector}" not found or not visible. ` +
        "Run a new snapshot to see current page elements.",
    );
  }

  if (
    message.includes("intercepts pointer events") ||
    message.includes("not visible") ||
    message.includes("not receive pointer events")
  ) {
    return new Error(
      `Element "${selector}" is not interactable (hidden or covered). ` +
        "Try scrolling it into view, closing overlays, or re-snapshotting.",
    );
  }

  return error instanceof Error ? error : new Error(message);
}

// ── Action Handlers ──────────────────────────────────────────────────

async function handleClick(page: Page, action: ClickAction): Promise<void> {
  const ref = requireRef(action.ref);
  const locator = refLocator(page, ref);
  const timeout = normalizeTimeout();
  try {
    if (action.doubleClick) {
      await locator.dblclick({
        timeout,
        button: action.button,
        modifiers: action.modifiers,
      });
    } else {
      await locator.click({
        timeout,
        button: action.button,
        modifiers: action.modifiers,
      });
    }
  } catch (err) {
    throw toFriendlyError(err, ref);
  }
}

async function handleType(page: Page, action: TypeAction): Promise<void> {
  const ref = requireRef(action.ref);
  const locator = refLocator(page, ref);
  const text = String(action.text ?? "");
  const timeout = normalizeTimeout();
  try {
    if (action.slowly) {
      await locator.click({ timeout });
      await locator.type(text, { timeout, delay: 75 });
    } else {
      await locator.fill(text, { timeout });
    }
    if (action.submit) {
      await locator.press("Enter", { timeout });
    }
  } catch (err) {
    throw toFriendlyError(err, ref);
  }
}

async function handlePress(page: Page, action: PressAction): Promise<void> {
  const key = String(action.key ?? "").trim();
  if (!key) throw new Error("key is required");
  await page.keyboard.press(key, {
    delay: Math.max(0, Math.floor(action.delayMs ?? 0)),
  });
}

async function handleHover(page: Page, action: HoverAction): Promise<void> {
  const ref = requireRef(action.ref);
  try {
    await refLocator(page, ref).hover({
      timeout: normalizeTimeout(),
    });
  } catch (err) {
    throw toFriendlyError(err, ref);
  }
}

async function handleDrag(page: Page, action: DragAction): Promise<void> {
  const startRef = requireRef(action.startRef);
  const endRef = requireRef(action.endRef);
  try {
    await refLocator(page, startRef).dragTo(refLocator(page, endRef), {
      timeout: normalizeTimeout(),
    });
  } catch (err) {
    throw toFriendlyError(err, `${startRef} -> ${endRef}`);
  }
}

async function handleSelect(page: Page, action: SelectAction): Promise<void> {
  const ref = requireRef(action.ref);
  if (!action.values?.length) throw new Error("values are required");
  try {
    await refLocator(page, ref).selectOption(action.values, {
      timeout: normalizeTimeout(),
    });
  } catch (err) {
    throw toFriendlyError(err, ref);
  }
}

async function handleFill(page: Page, action: FillAction): Promise<void> {
  const timeout = normalizeTimeout();
  for (const field of action.fields) {
    const ref = field.ref.trim();
    const type = field.type.trim();
    const rawValue = field.value;
    const value =
      typeof rawValue === "string"
        ? rawValue
        : typeof rawValue === "number" || typeof rawValue === "boolean"
          ? String(rawValue)
          : "";
    if (!ref || !type) continue;

    const locator = refLocator(page, ref);
    if (type === "checkbox" || type === "radio") {
      const checked =
        rawValue === true ||
        rawValue === 1 ||
        rawValue === "1" ||
        rawValue === "true";
      try {
        await locator.setChecked(checked, { timeout });
      } catch (err) {
        throw toFriendlyError(err, ref);
      }
      continue;
    }
    try {
      await locator.fill(value, { timeout });
    } catch (err) {
      throw toFriendlyError(err, ref);
    }
  }
}

async function handleClose(page: Page): Promise<void> {
  await page.close();
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Execute a browser interaction action on a page.
 *
 * @param page - Playwright Page instance
 * @param action - The action to execute
 * @returns ActionResult with ok status and action kind
 */
export async function executeAction(
  page: Page,
  action: BrowserAction,
): Promise<ActionResult> {
  ensurePageState(page);

  try {
    switch (action.kind) {
      case "click":
        await handleClick(page, action);
        break;
      case "type":
        await handleType(page, action);
        break;
      case "press":
        await handlePress(page, action);
        break;
      case "hover":
        await handleHover(page, action);
        break;
      case "drag":
        await handleDrag(page, action);
        break;
      case "select":
        await handleSelect(page, action);
        break;
      case "fill":
        await handleFill(page, action);
        break;
      case "close":
        await handleClose(page);
        break;
      default:
        return {
          ok: false,
          action: (action as { kind: string }).kind ?? "unknown",
          error: `Unknown action kind: ${(action as { kind: string }).kind}`,
        };
    }

    return { ok: true, action: action.kind };
  } catch (error) {
    return {
      ok: false,
      action: action.kind,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
