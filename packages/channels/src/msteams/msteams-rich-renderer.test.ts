// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderMSTeamsCardAttachment } from "./msteams-rich-renderer.js";
import { MSTEAMS_APPROVAL_VERB } from "./msteams-actions.js";
import type { RichButton, RichCard } from "@comis/core";

// A representative signed callback wire (v1.<choice>.<shortId>.<hmac>) — neutral literal.
const SIGNED_CB = "v1.approve.Abc123Def456.QWERTYuiop123456";

function contentOf(attachment: Record<string, unknown>): Record<string, unknown> {
  return attachment.content as Record<string, unknown>;
}

function actionsOf(attachment: Record<string, unknown>): Record<string, unknown>[] {
  return contentOf(attachment).actions as Record<string, unknown>[];
}

function bodyOf(attachment: Record<string, unknown>): Record<string, unknown>[] {
  return contentOf(attachment).body as Record<string, unknown>[];
}

describe("renderMSTeamsCardAttachment attachment envelope", () => {
  it("wraps the card in the adaptive attachment contentType and v1.4 content", () => {
    const attachment = renderMSTeamsCardAttachment([{ title: "Status" }], []);

    expect(attachment.contentType).toBe("application/vnd.microsoft.card.adaptive");
    const content = contentOf(attachment);
    expect(content.type).toBe("AdaptiveCard");
    expect(content.version).toBe("1.4");
    expect(content.$schema).toBe("http://adaptivecards.io/schemas/adaptive-card.json");
  });
});

describe("renderMSTeamsCardAttachment action discriminants", () => {
  it("maps an interactive callback_data button to Action.Execute with the shared verb", () => {
    const buttons: RichButton[][] = [[{ text: "Approve", callback_data: SIGNED_CB }]];
    const actions = actionsOf(renderMSTeamsCardAttachment([], buttons));

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "Action.Execute",
      title: "Approve",
      verb: MSTEAMS_APPROVAL_VERB,
      data: { cb: SIGNED_CB },
    });
  });

  it("stamps the verb that equals the normalizer's rendered approval verb", () => {
    const buttons: RichButton[][] = [
      [{ text: "Deny", callback_data: "v1.deny.Abc123Def456.ZXCVbnmasdfghjkl0" }],
    ];
    const action = actionsOf(renderMSTeamsCardAttachment([], buttons))[0];

    expect(action.verb).toBe(MSTEAMS_APPROVAL_VERB);
  });

  it("maps a url button to Action.OpenUrl carrying the destination url", () => {
    const buttons: RichButton[][] = [[{ text: "Open", url: "https://example.com" }]];
    const action = actionsOf(renderMSTeamsCardAttachment([], buttons))[0];

    expect(action).toEqual({ type: "Action.OpenUrl", title: "Open", url: "https://example.com" });
  });

  it("maps a static button with no callback_data or url to Action.Submit", () => {
    const buttons: RichButton[][] = [[{ text: "Refresh" }]];
    const action = actionsOf(renderMSTeamsCardAttachment([], buttons))[0];

    expect(action).toEqual({ type: "Action.Submit", title: "Refresh" });
  });

  it("prefers Action.Execute when a button carries both callback_data and url", () => {
    const buttons: RichButton[][] = [
      [{ text: "Both", callback_data: SIGNED_CB, url: "https://example.com" }],
    ];
    const action = actionsOf(renderMSTeamsCardAttachment([], buttons))[0];

    expect(action.type).toBe("Action.Execute");
    expect(action.url).toBeUndefined();
  });

  it("flattens multiple button rows into a single actions array", () => {
    const buttons: RichButton[][] = [
      [{ text: "A", callback_data: "cb-a" }],
      [
        { text: "B", url: "https://example.com/b" },
        { text: "C" },
      ],
    ];
    const actions = actionsOf(renderMSTeamsCardAttachment([], buttons));

    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.type)).toEqual([
      "Action.Execute",
      "Action.OpenUrl",
      "Action.Submit",
    ]);
  });
});

describe("renderMSTeamsCardAttachment card body", () => {
  it("renders a card title as a Bolder Medium PascalCase TextBlock", () => {
    const cards: RichCard[] = [{ title: "Approval required" }];
    const body = bodyOf(renderMSTeamsCardAttachment(cards, []));

    expect(body[0]).toEqual({
      type: "TextBlock",
      text: "Approval required",
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    });
  });

  it("renders card fields as a FactSet of name/value facts", () => {
    const cards: RichCard[] = [
      {
        title: "Info",
        fields: [
          { name: "Tool", value: "bash" },
          { name: "Risk", value: "high" },
        ],
      },
    ];
    const body = bodyOf(renderMSTeamsCardAttachment(cards, []));
    const factSet = body.find((b) => b.type === "FactSet");

    expect(factSet).toEqual({
      type: "FactSet",
      facts: [
        { title: "Tool", value: "bash" },
        { title: "Risk", value: "high" },
      ],
    });
  });

  it("renders a card image_url as an Adaptive Card Image element", () => {
    const cards: RichCard[] = [{ image_url: "https://example.com/i.png" }];
    const body = bodyOf(renderMSTeamsCardAttachment(cards, []));

    expect(body).toContainEqual({ type: "Image", url: "https://example.com/i.png" });
  });
});

describe("renderMSTeamsCardAttachment nested card buttons", () => {
  it("renders a RichCard's nested button rows as card actions (not silently dropped)", () => {
    const cards: RichCard[] = [
      {
        title: "Choose",
        buttons: [[{ text: "Yes", callback_data: SIGNED_CB }, { text: "No" }]],
      },
    ];
    const actions = actionsOf(renderMSTeamsCardAttachment(cards, []));

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "Action.Execute", title: "Yes" });
    expect(actions[1]).toMatchObject({ type: "Action.Submit", title: "No" });
  });

  it("folds card-nested rows ahead of the top-level button rows into one actions array", () => {
    const cards: RichCard[] = [{ title: "T", buttons: [[{ text: "CardBtn" }]] }];
    const buttons: RichButton[][] = [[{ text: "TopBtn" }]];
    const actions = actionsOf(renderMSTeamsCardAttachment(cards, buttons));

    expect(actions.map((a) => a.title)).toEqual(["CardBtn", "TopBtn"]);
  });
});

describe("renderMSTeamsCardAttachment PascalCase enum enforcement", () => {
  it("maps a primary-style button to the PascalCase color Good", () => {
    const buttons: RichButton[][] = [
      [{ text: "Approve", callback_data: SIGNED_CB, style: "primary" }],
    ];
    const body = bodyOf(renderMSTeamsCardAttachment([], buttons));

    expect(body.some((b) => b.color === "Good")).toBe(true);
  });

  it("maps a danger-style button to the PascalCase color Attention", () => {
    const buttons: RichButton[][] = [
      [{ text: "Deny", callback_data: SIGNED_CB, style: "danger" }],
    ];
    const body = bodyOf(renderMSTeamsCardAttachment([], buttons));

    expect(body.some((b) => b.color === "Attention")).toBe(true);
  });

  it("falls back an unknown style to the PascalCase color Default", () => {
    // Cast an out-of-range style to prove the closed lookup never passes it through.
    const rogueStyle = "chartreuse" as unknown as RichButton["style"];
    const buttons: RichButton[][] = [
      [{ text: "X", callback_data: SIGNED_CB, style: rogueStyle }],
    ];
    const body = bodyOf(renderMSTeamsCardAttachment([], buttons));
    // The companion emphasis marker is the TextBlock spaced Small — never the label.
    const emphasis = body.find((b) => b.type === "TextBlock" && b.spacing === "Small");

    expect(emphasis?.color).toBe("Default");
  });

  it("never emits a lowercase enum literal on the serialized wire", () => {
    const cards: RichCard[] = [
      {
        title: "Approval required",
        description: "bash",
        fields: [{ name: "Risk", value: "high" }],
      },
    ];
    const buttons: RichButton[][] = [
      [
        { text: "Approve", callback_data: SIGNED_CB, style: "primary" },
        { text: "Deny", callback_data: "v1.deny.Abc123Def456.ZXCVbnmasdfghjkl0", style: "danger" },
        { text: "Docs", url: "https://example.com", style: "link" },
      ],
    ];
    const serialized = JSON.stringify(contentOf(renderMSTeamsCardAttachment(cards, buttons)));

    expect(serialized).not.toMatch(/"(weight|size|color|spacing)":"[a-z]/);
  });
});

describe("renderMSTeamsCardAttachment styled-button emphasis", () => {
  it("renders a styled button's label once — on the action title, not echoed in the body", () => {
    const buttons: RichButton[][] = [
      [{ text: "Approve", callback_data: SIGNED_CB, style: "primary" }],
    ];
    const attachment = renderMSTeamsCardAttachment([], buttons);
    const actions = actionsOf(attachment);
    const body = bodyOf(attachment);

    // The label lives on the action title …
    expect(actions[0]!.title).toBe("Approve");
    // … and is NOT echoed by a companion TextBlock (the pre-fix double-render).
    const labelEchoes = body.filter((b) => b.type === "TextBlock" && b.text === "Approve");
    expect(labelEchoes).toHaveLength(0);
    // Emphasis is still conveyed: a colored companion marker rides alongside.
    const emphasis = body.find((b) => b.type === "TextBlock" && b.spacing === "Small");
    expect(emphasis).toBeDefined();
    expect(emphasis!.color).toBe("Good");
  });

  it("gives each styled button exactly one companion emphasis marker (labels not duplicated)", () => {
    const buttons: RichButton[][] = [
      [
        { text: "Approve", callback_data: SIGNED_CB, style: "primary" },
        { text: "Deny", callback_data: "v1.deny.Abc123Def456.ZXCVbnmasdfghjkl0", style: "danger" },
      ],
    ];
    const body = bodyOf(renderMSTeamsCardAttachment([], buttons));
    const emphasis = body.filter((b) => b.type === "TextBlock" && b.spacing === "Small");
    // Two styled buttons → two emphasis markers, and neither repeats a label.
    expect(emphasis).toHaveLength(2);
    expect(emphasis.some((b) => b.text === "Approve" || b.text === "Deny")).toBe(false);
    expect(emphasis.map((b) => b.color)).toEqual(["Good", "Attention"]);
  });
});

describe("renderMSTeamsCardAttachment effect handling", () => {
  it("emits no spoiler or silent effect field in the card content", () => {
    const cards: RichCard[] = [{ title: "T", description: "D" }];
    const buttons: RichButton[][] = [[{ text: "Go", callback_data: SIGNED_CB }]];
    const serialized = JSON.stringify(renderMSTeamsCardAttachment(cards, buttons));

    expect(serialized).not.toContain("spoiler");
    expect(serialized).not.toContain("silent");
  });
});
