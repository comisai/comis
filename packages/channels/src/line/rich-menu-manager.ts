// SPDX-License-Identifier: Apache-2.0
/**
 * LINE Rich Menu Manager: CRUD operations for LINE rich menus.
 *
 * Wraps @line/bot-sdk MessagingApiClient rich menu methods with
 * Result returns for composable error handling.
 *
 * @module
 */

import { ok, err, fromPromise, type Result } from "@comis/shared";
import type { messagingApi } from "@line/bot-sdk";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Simplified rich menu input for creation.
 */
export interface RichMenuInput {
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
  /** Menu size. Defaults to half-screen (2500x843). */
  size?: { width: 2500; height: 1686 | 843 };
  /** Whether the menu is initially selected. Defaults to false. */
  selected?: boolean;
}

/**
 * Rich menu tap area definition.
 */
export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action: { type: string; label: string; data: string };
}

/**
 * Summary of a rich menu returned by list().
 */
export interface RichMenuSummary {
  richMenuId: string;
  name: string;
  chatBarText: string;
  selected: boolean;
  size: { width: number; height: number };
  areas: RichMenuArea[];
}

/**
 * Rich menu manager interface.
 */
export interface RichMenuManager {
  /** Create a rich menu. Returns the menu ID. */
  create(menu: RichMenuInput): Promise<Result<string, Error>>;
  /** Set a rich menu as the default for all users. */
  setDefault(menuId: string): Promise<Result<void, Error>>;
  /** Link a rich menu to a specific user. */
  linkToUser(userId: string, menuId: string): Promise<Result<void, Error>>;
  /** Delete a rich menu. */
  delete(menuId: string): Promise<Result<void, Error>>;
  /** List all rich menus. */
  list(): Promise<Result<RichMenuSummary[], Error>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a rich menu manager wrapping LINE SDK CRUD operations.
 *
 * All methods return Result types for composable error handling.
 *
 * @param client - MessagingApiClient instance with valid channel access token
 * @returns RichMenuManager interface
 */
export function createRichMenuManager(client: messagingApi.MessagingApiClient): RichMenuManager {
  return {
    async create(menu: RichMenuInput): Promise<Result<string, Error>> {
      const size = menu.size ?? { width: 2500, height: 843 };
      const richMenuRequest: messagingApi.RichMenuRequest = {
        size,
        selected: menu.selected ?? false,
        name: menu.name.slice(0, 300), // LINE limit
        chatBarText: menu.chatBarText.slice(0, 14), // LINE limit
        areas: menu.areas.map((area) => ({
          bounds: area.bounds,
          action: area.action as messagingApi.Action,
        })),
      };

      const result = await fromPromise(client.createRichMenu(richMenuRequest));
      if (!result.ok) {
        return err(new Error(`Failed to create rich menu: ${result.error instanceof Error ? result.error.message : String(result.error)}`));
      }

      return ok(result.value.richMenuId);
    },

    async setDefault(menuId: string): Promise<Result<void, Error>> {
      const result = await fromPromise(client.setDefaultRichMenu(menuId));
      if (!result.ok) {
        return err(new Error(`Failed to set default rich menu: ${result.error instanceof Error ? result.error.message : String(result.error)}`));
      }
      return ok(undefined);
    },

    async linkToUser(userId: string, menuId: string): Promise<Result<void, Error>> {
      const result = await fromPromise(client.linkRichMenuIdToUser(userId, menuId));
      if (!result.ok) {
        return err(new Error(`Failed to link rich menu to user: ${result.error instanceof Error ? result.error.message : String(result.error)}`));
      }
      return ok(undefined);
    },

    async delete(menuId: string): Promise<Result<void, Error>> {
      const result = await fromPromise(client.deleteRichMenu(menuId));
      if (!result.ok) {
        return err(new Error(`Failed to delete rich menu: ${result.error instanceof Error ? result.error.message : String(result.error)}`));
      }
      return ok(undefined);
    },

    async list(): Promise<Result<RichMenuSummary[], Error>> {
      const result = await fromPromise(client.getRichMenuList());
      if (!result.ok) {
        return err(new Error(`Failed to list rich menus: ${result.error instanceof Error ? result.error.message : String(result.error)}`));
      }

      const menus = result.value.richmenus ?? [];
      const summaries: RichMenuSummary[] = menus.map((m) => ({
        richMenuId: m.richMenuId,
        name: m.name,
        chatBarText: m.chatBarText,
        selected: m.selected,
        size: { width: Number(m.size.width ?? 2500), height: Number(m.size.height ?? 843) },
        areas: m.areas.map((a) => ({
          bounds: a.bounds as { x: number; y: number; width: number; height: number },
          action: {
            type: (a.action as { type: string }).type,
            label: (a.action as { label?: string }).label ?? "",
            data: (a.action as { data?: string; uri?: string; text?: string }).data
              ?? (a.action as { uri?: string }).uri
              ?? (a.action as { text?: string }).text
              ?? "",
          },
        })),
      }));

      return ok(summaries);
    },
  };
}
