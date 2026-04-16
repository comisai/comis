import { describe, it, expect, vi } from "vitest";
import {
  createIdentityLinkResolver,
  type IdentityLinkResolverDeps,
} from "./identity-link-resolver.js";

function createMockStore(
  links: Array<{ provider: string; providerUserId: string; canonicalId: string }> = [],
): IdentityLinkResolverDeps["store"] & {
  resolveCalls: Array<[string, string]>;
  listAllCalls: number;
} {
  const resolveCalls: Array<[string, string]> = [];
  let listAllCalls = 0;
  const linkMap = new Map<string, string>();
  for (const link of links) {
    linkMap.set(`${link.provider}:${link.providerUserId}`, link.canonicalId);
  }

  return {
    resolveCalls,
    listAllCalls,
    resolve(provider: string, providerUserId: string): string | undefined {
      resolveCalls.push([provider, providerUserId]);
      return linkMap.get(`${provider}:${providerUserId}`);
    },
    listAll() {
      listAllCalls++;
      // Must use property to track since closure captures aren't reactive on the returned object
      this.listAllCalls = listAllCalls;
      return links;
    },
  };
}

describe("createIdentityLinkResolver", () => {
  it("resolve returns canonical ID from pre-populated cache (no extra store.resolve call)", () => {
    const store = createMockStore([
      { provider: "discord", providerUserId: "u1", canonicalId: "canonical-1" },
      { provider: "telegram", providerUserId: "u2", canonicalId: "canonical-1" },
    ]);

    const resolver = createIdentityLinkResolver({ store });

    const result = resolver.resolve("discord", "u1");
    expect(result).toBe("canonical-1");
    // Should NOT have called store.resolve since it was in cache
    expect(store.resolveCalls).toHaveLength(0);
  });

  it("resolve falls back to store.resolve for cache miss, then caches the result", () => {
    // Start with empty cache but store has the link
    const store = createMockStore([]);
    // Add to store's internal map after creation (simulating a link added after cache load)
    const originalResolve = store.resolve.bind(store);
    store.resolve = (provider: string, providerUserId: string) => {
      store.resolveCalls.push([provider, providerUserId]);
      if (provider === "slack" && providerUserId === "u3") {
        return "canonical-3";
      }
      return undefined;
    };

    const resolver = createIdentityLinkResolver({ store });

    // First call: cache miss -> falls through to store
    const result1 = resolver.resolve("slack", "u3");
    expect(result1).toBe("canonical-3");
    expect(store.resolveCalls).toHaveLength(1);

    // Second call: should be cached now, no additional store.resolve call
    const result2 = resolver.resolve("slack", "u3");
    expect(result2).toBe("canonical-3");
    expect(store.resolveCalls).toHaveLength(1); // Still just 1 call
  });

  it("resolve returns undefined for unknown provider identity (store returns undefined)", () => {
    const store = createMockStore([
      { provider: "discord", providerUserId: "u1", canonicalId: "canonical-1" },
    ]);

    const resolver = createIdentityLinkResolver({ store });

    const result = resolver.resolve("whatsapp", "unknown-user");
    expect(result).toBeUndefined();
    // Should have tried the store after cache miss
    expect(store.resolveCalls).toHaveLength(1);
  });

  it("invalidateCache clears cache, next resolve goes to store again", () => {
    const store = createMockStore([
      { provider: "discord", providerUserId: "u1", canonicalId: "canonical-1" },
    ]);

    const resolver = createIdentityLinkResolver({ store });

    // First resolve from cache (no store call)
    resolver.resolve("discord", "u1");
    expect(store.resolveCalls).toHaveLength(0);

    // Invalidate cache
    resolver.invalidateCache();

    // Now resolve should fall through to store
    resolver.resolve("discord", "u1");
    expect(store.resolveCalls).toHaveLength(1);
  });

  it("refreshCache reloads all links from store.listAll", () => {
    const links = [
      { provider: "discord", providerUserId: "u1", canonicalId: "canonical-1" },
    ];
    const store = createMockStore(links);

    const resolver = createIdentityLinkResolver({ store });
    // Constructor calls refreshCache once
    expect(store.listAllCalls).toBe(1);

    // Call refreshCache again
    resolver.refreshCache();
    expect(store.listAllCalls).toBe(2);

    // Should still resolve from cache
    const result = resolver.resolve("discord", "u1");
    expect(result).toBe("canonical-1");
    expect(store.resolveCalls).toHaveLength(0);
  });

  it("constructor calls refreshCache on creation", () => {
    const store = createMockStore([
      { provider: "discord", providerUserId: "u1", canonicalId: "canonical-1" },
    ]);

    // Just creating the resolver should call listAll once
    const resolver = createIdentityLinkResolver({ store });
    expect(store.listAllCalls).toBe(1);
  });
});
