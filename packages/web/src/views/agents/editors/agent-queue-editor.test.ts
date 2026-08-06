// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigChangeDetail,
  IcAgentQueueEditor,
} from "./agent-queue-editor.js";
import "./agent-queue-editor.js";

async function createEditor(
  config: Record<string, unknown>,
): Promise<IcAgentQueueEditor> {
  const editor = document.createElement("ic-agent-queue-editor") as IcAgentQueueEditor;
  editor.config = config;
  document.body.appendChild(editor);
  await editor.updateComplete;
  return editor;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("agent queue editor", () => {
  it("edits the live collect debounce key without rendering removed buffer controls", async () => {
    const editor = await createEditor({ defaultDebounceMs: 250 });
    const input = editor.shadowRoot?.querySelector<HTMLInputElement>(
      "#field-defaultDebounceMs",
    );

    expect(input?.value).toBe("250");
    expect(editor.shadowRoot?.textContent).toContain("Collect Debounce");
    expect(editor.shadowRoot?.querySelector("#field-windowMs")).toBeNull();
    expect(editor.shadowRoot?.textContent).not.toContain("Max Buffered Messages");
    expect(editor.shadowRoot?.textContent).not.toContain("First Message Immediate");

    const changed = vi.fn<(event: CustomEvent<ConfigChangeDetail>) => void>();
    editor.addEventListener("config-change", changed as EventListener);
    input!.value = "400";
    input!.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]?.[0].detail).toEqual({
      section: "queue",
      key: "defaultDebounceMs",
      value: 400,
    });
  });
});
