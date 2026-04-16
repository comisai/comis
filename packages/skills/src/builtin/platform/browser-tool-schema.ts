/**
 * TypeBox schema for the browser platform tool parameters.
 *
 * Ported from Comis's browser-tool.schema.ts. Uses a flattened object
 * schema (not nested unions) for Claude/OpenAI function calling compatibility.
 *
 * @module
 */

import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BROWSER_ACT_KINDS = [
  "click",
  "type",
  "press",
  "hover",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
] as const;

const BROWSER_TOOL_ACTIONS = [
  "status",
  "start",
  "stop",
  "profiles",
  "tabs",
  "open",
  "focus",
  "close",
  "snapshot",
  "screenshot",
  "navigate",
  "console",
  "pdf",
  "upload",
  "dialog",
  "act",
] as const;

const BROWSER_SNAPSHOT_FORMATS = ["aria", "ai"] as const;
const BROWSER_SNAPSHOT_MODES = ["efficient"] as const;
const BROWSER_SNAPSHOT_REFS = ["role", "aria"] as const;
const BROWSER_IMAGE_TYPES = ["png", "jpeg"] as const;

// ---------------------------------------------------------------------------
// Act sub-schema
// ---------------------------------------------------------------------------

/**
 * Flattened act request schema. The `kind` discriminator determines which
 * fields are relevant; runtime validates per-kind requirements.
 */
export const BrowserActSchema = Type.Object({
  kind: Type.Union(
    BROWSER_ACT_KINDS.map((v) => Type.Literal(v)),
    { description: "Interaction kind. Valid values: click (click element), type (enter text), press (press key), hover (mouse over), drag (drag between elements), select (choose dropdown option), fill (fill form fields), resize (change viewport size), wait (pause or wait for condition), evaluate (run JavaScript), close (close current tab)" },
  ),
  // Common fields
  targetId: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  // click
  doubleClick: Type.Optional(Type.Boolean()),
  button: Type.Optional(Type.String()),
  modifiers: Type.Optional(Type.Array(Type.String())),
  // type
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  slowly: Type.Optional(Type.Boolean()),
  // press
  key: Type.Optional(Type.String()),
  // drag
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  // select
  values: Type.Optional(Type.Array(Type.String())),
  // fill - permissive array of objects
  fields: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
  // resize
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  // wait
  timeMs: Type.Optional(Type.Number()),
  textGone: Type.Optional(Type.String()),
  // evaluate
  fn: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Top-level browser tool schema
// ---------------------------------------------------------------------------

/**
 * Browser tool parameter schema. Flattened object with `action` discriminator.
 *
 * Uses a flat structure (not anyOf/oneOf) because Claude API on Vertex AI
 * rejects nested anyOf schemas as invalid JSON Schema.
 */
export const BrowserToolSchema = Type.Object({
  action: Type.Union(
    BROWSER_TOOL_ACTIONS.map((v) => Type.Literal(v)),
    { description: "Browser control action. Valid values: status (check browser state), start (launch browser), stop (close browser), profiles (list browser profiles), tabs (list open tabs), open (new tab with URL), focus (switch to tab), close (close tab), snapshot (get page accessibility tree), screenshot (capture page image), navigate (go to URL), console (read console logs), pdf (export page as PDF), upload (upload file to input), dialog (handle browser dialog), act (perform page interaction)" },
  ),
  profile: Type.Optional(Type.String()),
  targetUrl: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  maxChars: Type.Optional(Type.Number()),
  mode: Type.Optional(Type.Union(
    BROWSER_SNAPSHOT_MODES.map((v) => Type.Literal(v)),
    { description: "Snapshot mode. Valid values: efficient (compact output for LLM)" },
  )),
  snapshotFormat: Type.Optional(Type.Union(
    BROWSER_SNAPSHOT_FORMATS.map((v) => Type.Literal(v)),
    { description: "Snapshot format. Valid values: aria (ARIA accessibility tree), ai (LLM-optimized format)" },
  )),
  refs: Type.Optional(Type.Union(
    BROWSER_SNAPSHOT_REFS.map((v) => Type.Literal(v)),
    { description: "Element reference type. Valid values: role (ARIA role references), aria (ARIA label references)" },
  )),
  interactive: Type.Optional(Type.Boolean()),
  compact: Type.Optional(Type.Boolean()),
  depth: Type.Optional(Type.Number()),
  selector: Type.Optional(Type.String()),
  frame: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Boolean()),
  fullPage: Type.Optional(Type.Boolean()),
  ref: Type.Optional(Type.String()),
  element: Type.Optional(Type.String()),
  type: Type.Optional(Type.Union(
    BROWSER_IMAGE_TYPES.map((v) => Type.Literal(v)),
    { description: "Screenshot image format. Valid values: png (lossless), jpeg (compressed)" },
  )),
  level: Type.Optional(Type.String()),
  paths: Type.Optional(Type.Array(Type.String())),
  inputRef: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  accept: Type.Optional(Type.Boolean()),
  promptText: Type.Optional(Type.String()),
  request: Type.Optional(BrowserActSchema),
});
