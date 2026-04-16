/**
 * LINE Flex Message Template Builder.
 *
 * Provides a simplified interface for building LINE Flex Messages.
 * Converts FlexTemplate objects into LINE SDK FlexContainer JSON
 * (bubble and carousel types).
 *
 * @module
 */

import type { messagingApi } from "@line/bot-sdk";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Simplified Flex Message action definition.
 */
export interface FlexAction {
  type: "uri" | "message" | "postback";
  label: string;
  data: string;
}

/**
 * Simplified Flex Message template for common bubble patterns.
 *
 * Produces a FlexBubble with optional header, required body, optional
 * footer with action buttons, and alt text for non-Flex clients.
 */
export interface FlexTemplate {
  altText: string;
  header?: string;
  body: string;
  footer?: string;
  actions?: FlexAction[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a FlexAction to a LINE SDK Action object.
 */
function mapAction(action: FlexAction): messagingApi.Action {
  switch (action.type) {
    case "uri":
      return {
        type: "uri",
        label: action.label.slice(0, 20),
        uri: action.data,
      };
    case "message":
      return {
        type: "message",
        label: action.label.slice(0, 20),
        text: action.data,
      };
    case "postback":
      return {
        type: "postback",
        label: action.label.slice(0, 20),
        data: action.data.slice(0, 300),
      };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a LINE FlexContainer (bubble) from a simplified FlexTemplate.
 *
 * Produces a FlexBubble with:
 * - header: optional box with bold text
 * - body: box with wrapping text
 * - footer: optional box with action buttons
 *
 * @param template - Simplified template with header/body/footer/actions
 * @returns A FlexContainer (FlexBubble) ready for pushMessage
 */
export function buildFlexMessage(template: FlexTemplate): messagingApi.FlexContainer {
  const bodyContents: messagingApi.FlexComponent[] = [
    {
      type: "text",
      text: template.body,
      wrap: true,
      size: "md",
      color: "#333333",
    } as messagingApi.FlexText,
  ];

  const bubble: messagingApi.FlexBubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: bodyContents,
      paddingAll: "lg",
    },
  };

  // Optional header
  if (template.header) {
    bubble.header = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: template.header,
          weight: "bold",
          size: "xl",
          color: "#111111",
          wrap: true,
        } as messagingApi.FlexText,
      ],
      paddingAll: "lg",
    };
  }

  // Footer with optional text and action buttons
  const footerContents: messagingApi.FlexComponent[] = [];

  if (template.footer) {
    footerContents.push({
      type: "text",
      text: template.footer,
      size: "xs",
      color: "#AAAAAA",
      wrap: true,
      align: "center",
    } as messagingApi.FlexText);
  }

  if (template.actions && template.actions.length > 0) {
    for (const [index, action] of template.actions.entries()) {
      footerContents.push({
        type: "button",
        action: mapAction(action),
        style: index === 0 ? "primary" : "secondary",
        margin: index > 0 ? "sm" : undefined,
      } as messagingApi.FlexButton);
    }
  }

  if (footerContents.length > 0) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: footerContents,
      paddingAll: "lg",
    };
  }

  return bubble;
}

/**
 * Build a LINE FlexContainer (carousel) from multiple FlexTemplates.
 *
 * LINE allows a maximum of 12 bubbles in a carousel.
 *
 * @param items - Array of FlexTemplates (max 12)
 * @returns A FlexContainer (FlexCarousel) ready for pushMessage
 */
export function buildFlexCarousel(items: FlexTemplate[]): messagingApi.FlexContainer {
  const bubbles = items.slice(0, 12).map((item) => buildFlexMessage(item) as messagingApi.FlexBubble);

  return {
    type: "carousel",
    contents: bubbles,
  } as messagingApi.FlexCarousel;
}
