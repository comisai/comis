import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRichMenuManager, type RichMenuInput } from "./rich-menu-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient() {
  return {
    createRichMenu: vi.fn(),
    setDefaultRichMenu: vi.fn(),
    linkRichMenuIdToUser: vi.fn(),
    deleteRichMenu: vi.fn(),
    getRichMenuList: vi.fn(),
  };
}

function makeMenuInput(overrides?: Partial<RichMenuInput>): RichMenuInput {
  return {
    name: "Test Menu",
    chatBarText: "Tap here",
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 843 },
        action: { type: "message", label: "Hello", data: "hello" },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRichMenuManager", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeMockClient();
  });

  // -----------------------------------------------------------------------
  // create()
  // -----------------------------------------------------------------------

  describe("create()", () => {
    it("calls client.createRichMenu with correct request shape and returns ok(richMenuId)", async () => {
      client.createRichMenu.mockResolvedValue({ richMenuId: "rm-001" });

      const manager = createRichMenuManager(client as any);
      const result = await manager.create(makeMenuInput());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("rm-001");
      }
      expect(client.createRichMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Menu",
          chatBarText: "Tap here",
          selected: false,
          size: { width: 2500, height: 843 },
        }),
      );
    });

    it("uses default size (2500x843) when not specified", async () => {
      client.createRichMenu.mockResolvedValue({ richMenuId: "rm-002" });

      const manager = createRichMenuManager(client as any);
      await manager.create(makeMenuInput());

      expect(client.createRichMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          size: { width: 2500, height: 843 },
        }),
      );
    });

    it("uses specified size when provided", async () => {
      client.createRichMenu.mockResolvedValue({ richMenuId: "rm-003" });

      const manager = createRichMenuManager(client as any);
      await manager.create(makeMenuInput({ size: { width: 2500, height: 1686 } }));

      expect(client.createRichMenu).toHaveBeenCalledWith(
        expect.objectContaining({
          size: { width: 2500, height: 1686 },
        }),
      );
    });

    it("truncates name to 300 chars", async () => {
      client.createRichMenu.mockResolvedValue({ richMenuId: "rm-004" });

      const longName = "N".repeat(400);
      const manager = createRichMenuManager(client as any);
      await manager.create(makeMenuInput({ name: longName }));

      const calledWith = client.createRichMenu.mock.calls[0][0];
      expect(calledWith.name).toBe("N".repeat(300));
    });

    it("truncates chatBarText to 14 chars", async () => {
      client.createRichMenu.mockResolvedValue({ richMenuId: "rm-005" });

      const longText = "C".repeat(20);
      const manager = createRichMenuManager(client as any);
      await manager.create(makeMenuInput({ chatBarText: longText }));

      const calledWith = client.createRichMenu.mock.calls[0][0];
      expect(calledWith.chatBarText).toBe("C".repeat(14));
    });

    it("returns err when client throws", async () => {
      client.createRichMenu.mockRejectedValue(new Error("API limit"));

      const manager = createRichMenuManager(client as any);
      const result = await manager.create(makeMenuInput());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to create rich menu");
        expect(result.error.message).toContain("API limit");
      }
    });
  });

  // -----------------------------------------------------------------------
  // setDefault()
  // -----------------------------------------------------------------------

  describe("setDefault()", () => {
    it("calls client.setDefaultRichMenu(menuId) and returns ok", async () => {
      client.setDefaultRichMenu.mockResolvedValue({});

      const manager = createRichMenuManager(client as any);
      const result = await manager.setDefault("rm-001");

      expect(result.ok).toBe(true);
      expect(client.setDefaultRichMenu).toHaveBeenCalledWith("rm-001");
    });

    it("returns err when client throws", async () => {
      client.setDefaultRichMenu.mockRejectedValue(new Error("Not found"));

      const manager = createRichMenuManager(client as any);
      const result = await manager.setDefault("rm-bad");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to set default rich menu");
      }
    });
  });

  // -----------------------------------------------------------------------
  // linkToUser()
  // -----------------------------------------------------------------------

  describe("linkToUser()", () => {
    it("calls client.linkRichMenuIdToUser(userId, menuId) and returns ok", async () => {
      client.linkRichMenuIdToUser.mockResolvedValue({});

      const manager = createRichMenuManager(client as any);
      const result = await manager.linkToUser("U1234", "rm-001");

      expect(result.ok).toBe(true);
      expect(client.linkRichMenuIdToUser).toHaveBeenCalledWith("U1234", "rm-001");
    });

    it("returns err when client throws", async () => {
      client.linkRichMenuIdToUser.mockRejectedValue(new Error("User not found"));

      const manager = createRichMenuManager(client as any);
      const result = await manager.linkToUser("U-bad", "rm-001");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to link rich menu to user");
      }
    });
  });

  // -----------------------------------------------------------------------
  // delete()
  // -----------------------------------------------------------------------

  describe("delete()", () => {
    it("calls client.deleteRichMenu(menuId) and returns ok", async () => {
      client.deleteRichMenu.mockResolvedValue({});

      const manager = createRichMenuManager(client as any);
      const result = await manager.delete("rm-001");

      expect(result.ok).toBe(true);
      expect(client.deleteRichMenu).toHaveBeenCalledWith("rm-001");
    });

    it("returns err when client throws", async () => {
      client.deleteRichMenu.mockRejectedValue(new Error("Cannot delete"));

      const manager = createRichMenuManager(client as any);
      const result = await manager.delete("rm-bad");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to delete rich menu");
      }
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe("list()", () => {
    it("calls client.getRichMenuList, maps response to RichMenuSummary[], returns ok", async () => {
      client.getRichMenuList.mockResolvedValue({
        richmenus: [
          {
            richMenuId: "rm-001",
            name: "Menu A",
            chatBarText: "Open",
            selected: true,
            size: { width: 2500, height: 843 },
            areas: [
              {
                bounds: { x: 0, y: 0, width: 2500, height: 843 },
                action: { type: "message", label: "Hi", text: "hello" },
              },
            ],
          },
        ],
      });

      const manager = createRichMenuManager(client as any);
      const result = await manager.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]).toMatchObject({
          richMenuId: "rm-001",
          name: "Menu A",
          chatBarText: "Open",
          selected: true,
          size: { width: 2500, height: 843 },
        });
        expect(result.value[0].areas[0].action).toMatchObject({
          type: "message",
          label: "Hi",
          data: "hello",
        });
      }
    });

    it("handles empty richmenus array", async () => {
      client.getRichMenuList.mockResolvedValue({ richmenus: [] });

      const manager = createRichMenuManager(client as any);
      const result = await manager.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("handles undefined richmenus (null fallback)", async () => {
      client.getRichMenuList.mockResolvedValue({});

      const manager = createRichMenuManager(client as any);
      const result = await manager.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("returns err when client throws", async () => {
      client.getRichMenuList.mockRejectedValue(new Error("Unauthorized"));

      const manager = createRichMenuManager(client as any);
      const result = await manager.list();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to list rich menus");
      }
    });
  });
});
