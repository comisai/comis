// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { buildFlexMessage, buildFlexCarousel, type FlexTemplate } from "./flex-builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(overrides?: Partial<FlexTemplate>): FlexTemplate {
  return {
    altText: "Test message",
    body: "Hello World",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildFlexMessage", () => {
  it("body-only template: returns FlexBubble with body box containing text", () => {
    const result = buildFlexMessage(makeTemplate()) as any;

    expect(result.type).toBe("bubble");
    expect(result.body.type).toBe("box");
    expect(result.body.layout).toBe("vertical");
    expect(result.body.contents).toHaveLength(1);
    expect(result.body.contents[0]).toMatchObject({
      type: "text",
      text: "Hello World",
      wrap: true,
      size: "md",
    });
    expect(result.header).toBeUndefined();
    expect(result.footer).toBeUndefined();
  });

  it("with header: returns FlexBubble with header box containing bold text", () => {
    const result = buildFlexMessage(makeTemplate({ header: "My Title" })) as any;

    expect(result.header).toBeDefined();
    expect(result.header.type).toBe("box");
    expect(result.header.contents[0]).toMatchObject({
      type: "text",
      text: "My Title",
      weight: "bold",
      size: "xl",
    });
  });

  it("with footer text: returns FlexBubble with footer box containing small text", () => {
    const result = buildFlexMessage(makeTemplate({ footer: "Fine print" })) as any;

    expect(result.footer).toBeDefined();
    expect(result.footer.type).toBe("box");
    expect(result.footer.contents[0]).toMatchObject({
      type: "text",
      text: "Fine print",
      size: "xs",
      align: "center",
    });
  });

  it("with actions: returns footer with buttons, first primary, rest secondary", () => {
    const result = buildFlexMessage(
      makeTemplate({
        actions: [
          { type: "uri", label: "Open", data: "https://example.com" },
          { type: "message", label: "Say Hi", data: "Hello" },
        ],
      }),
    ) as any;

    expect(result.footer).toBeDefined();
    const buttons = result.footer.contents;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].style).toBe("primary");
    expect(buttons[0].action.type).toBe("uri");
    expect(buttons[0].action.uri).toBe("https://example.com");
    expect(buttons[1].style).toBe("secondary");
    expect(buttons[1].action.type).toBe("message");
    expect(buttons[1].action.text).toBe("Hello");
  });

  it("uri action: maps to uri action with correct fields", () => {
    const result = buildFlexMessage(
      makeTemplate({
        actions: [{ type: "uri", label: "Visit", data: "https://example.com" }],
      }),
    ) as any;

    const action = result.footer.contents[0].action;
    expect(action.type).toBe("uri");
    expect(action.label).toBe("Visit");
    expect(action.uri).toBe("https://example.com");
  });

  it("message action: maps to message action with text field", () => {
    const result = buildFlexMessage(
      makeTemplate({
        actions: [{ type: "message", label: "Reply", data: "Yes please" }],
      }),
    ) as any;

    const action = result.footer.contents[0].action;
    expect(action.type).toBe("message");
    expect(action.label).toBe("Reply");
    expect(action.text).toBe("Yes please");
  });

  it("postback action: maps to postback action with data field", () => {
    const result = buildFlexMessage(
      makeTemplate({
        actions: [{ type: "postback", label: "Action", data: "action=buy" }],
      }),
    ) as any;

    const action = result.footer.contents[0].action;
    expect(action.type).toBe("postback");
    expect(action.label).toBe("Action");
    expect(action.data).toBe("action=buy");
  });

  it("action label truncation: labels truncated to 20 chars", () => {
    const longLabel = "A".repeat(30);
    const result = buildFlexMessage(
      makeTemplate({
        actions: [{ type: "uri", label: longLabel, data: "https://example.com" }],
      }),
    ) as any;

    expect(result.footer.contents[0].action.label).toBe("A".repeat(20));
  });

  it("postback data truncation: data truncated to 300 chars", () => {
    const longData = "D".repeat(400);
    const result = buildFlexMessage(
      makeTemplate({
        actions: [{ type: "postback", label: "PB", data: longData }],
      }),
    ) as any;

    expect(result.footer.contents[0].action.data).toBe("D".repeat(300));
  });

  it("with header + body + footer + actions: returns complete bubble", () => {
    const result = buildFlexMessage({
      altText: "Full message",
      header: "Title",
      body: "Content here",
      footer: "Note",
      actions: [{ type: "uri", label: "Click", data: "https://example.com" }],
    }) as any;

    expect(result.type).toBe("bubble");
    expect(result.header).toBeDefined();
    expect(result.body).toBeDefined();
    expect(result.footer).toBeDefined();
    // Footer should have the text + 1 button
    expect(result.footer.contents).toHaveLength(2);
    expect(result.footer.contents[0].type).toBe("text");
    expect(result.footer.contents[1].type).toBe("button");
  });
});

describe("buildFlexCarousel", () => {
  it("multiple items: returns FlexCarousel with contents array of bubbles", () => {
    const items = [
      makeTemplate({ body: "Item 1" }),
      makeTemplate({ body: "Item 2" }),
      makeTemplate({ body: "Item 3" }),
    ];
    const result = buildFlexCarousel(items) as any;

    expect(result.type).toBe("carousel");
    expect(result.contents).toHaveLength(3);
    expect(result.contents[0].type).toBe("bubble");
    expect(result.contents[1].type).toBe("bubble");
    expect(result.contents[2].type).toBe("bubble");
  });

  it("max 12 items: input with >12 items produces exactly 12 bubbles", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      makeTemplate({ body: `Item ${i + 1}` }),
    );
    const result = buildFlexCarousel(items) as any;

    expect(result.type).toBe("carousel");
    expect(result.contents).toHaveLength(12);
  });

  it("single item: returns carousel with one bubble", () => {
    const result = buildFlexCarousel([makeTemplate()]) as any;

    expect(result.type).toBe("carousel");
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].type).toBe("bubble");
  });
});
