import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildFtsQuery,
  searchByText,
  searchByVector,
  computeRRF,
  hybridSearch,
} from "./hybrid-search.js";
import { initSchema, isVecAvailable } from "./schema.js";

/** Helper to insert a memory row with minimal boilerplate. */
function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  opts?: {
    trustLevel?: string;
    memoryType?: string;
    tenantId?: string;
    userId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'agent', '[]', ?)`,
  ).run(
    id,
    opts?.tenantId ?? "default",
    opts?.userId ?? "u1",
    content,
    opts?.trustLevel ?? "learned",
    opts?.memoryType ?? "semantic",
    Date.now(),
  );
}

/** Helper to insert a vector embedding for a memory. */
function insertEmbedding(db: Database.Database, memoryId: string, embedding: number[]): void {
  const float32 = new Float32Array(embedding);
  db.prepare("INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)").run(memoryId, float32);
  db.prepare("UPDATE memories SET has_embedding = 1 WHERE id = ?").run(memoryId);
}

// ── buildFtsQuery ────────────────────────────────────────────────────

describe("buildFtsQuery", () => {
  it("produces quoted OR-joined query from normal text", () => {
    const result = buildFtsQuery("dentist appointment tomorrow");
    expect(result).toBe('"dentist" OR "appointment" OR "tomorrow"');
  });

  it("returns null for empty string", () => {
    expect(buildFtsQuery("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("strips special characters, keeps only alphanumeric tokens", () => {
    const result = buildFtsQuery("hello! @world #2024");
    expect(result).toBe('"hello" OR "world" OR "2024"');
  });

  it("removes double quotes to prevent FTS5 injection", () => {
    const result = buildFtsQuery('test "injected phrase" query');
    // Double quotes removed, words tokenized individually
    expect(result).toBe('"test" OR "injected" OR "phrase" OR "query"');
  });

  it("returns null for input with only special characters", () => {
    expect(buildFtsQuery("!@#$%^&*()")).toBeNull();
  });

  it("handles single word input", () => {
    expect(buildFtsQuery("hello")).toBe('"hello"');
  });

  it("filters out English stop words", () => {
    const result = buildFtsQuery("what have we built together");
    expect(result).toBe('"built" OR "together"');
  });

  it("returns null when all tokens are stop words", () => {
    expect(buildFtsQuery("what is the")).toBeNull();
  });

  it("stop word filtering is case-insensitive", () => {
    const result = buildFtsQuery("The Quick Fox");
    expect(result).toBe('"Quick" OR "Fox"');
  });

  it("preserves non-Latin tokens even if they match stop words", () => {
    // Cyrillic "и" means "and" but should NOT be filtered as English stop word
    const result = buildFtsQuery("Привет и мир");
    expect(result).toBe('"Привет" OR "и" OR "мир"');
  });

  it("filters Latin stop words while preserving CJK in mixed query", () => {
    const result = buildFtsQuery("the 日本語 is great");
    expect(result).toBe('"日本語" OR "great"');
  });

  it("preserves Hebrew tokens (non-Latin script)", () => {
    const result = buildFtsQuery("מה בנינו ביחד");
    expect(result).toBe('"מה" OR "בנינו" OR "ביחד"');
  });

  it("preserves Arabic tokens (non-Latin script)", () => {
    const result = buildFtsQuery("ماذا بنينا معا");
    expect(result).toBe('"ماذا" OR "بنينا" OR "معا"');
  });

  it("filters Latin stop words while preserving Hebrew in mixed query", () => {
    const result = buildFtsQuery("the משחק is built");
    expect(result).toBe('"משחק" OR "built"');
  });

  // ── Unicode word character support ───────────────────────────────

  it("preserves Cyrillic characters", () => {
    const result = buildFtsQuery("\u041F\u0440\u0438\u0432\u0435\u0442 \u043C\u0438\u0440");
    expect(result).toBe('"\u041F\u0440\u0438\u0432\u0435\u0442" OR "\u043C\u0438\u0440"');
  });

  it("preserves CJK characters", () => {
    const result = buildFtsQuery("\u65E5\u672C\u8A9E");
    expect(result).toBe('"\u65E5\u672C\u8A9E"');
  });

  it("handles mixed Latin and CJK", () => {
    const result = buildFtsQuery("cafe \u65E5\u672C\u8A9E");
    expect(result).toBe('"cafe" OR "\u65E5\u672C\u8A9E"');
  });

  it("preserves Arabic characters", () => {
    const result = buildFtsQuery("\u0645\u0631\u062D\u0628\u0627");
    expect(result).toBe('"\u0645\u0631\u062D\u0628\u0627"');
  });

  it("still returns null for only symbols (no Unicode letters or numbers)", () => {
    expect(buildFtsQuery("***")).toBeNull();
  });

  it("handles mixed alpha-numeric as before", () => {
    const result = buildFtsQuery("test 123");
    expect(result).toBe('"test" OR "123"');
  });
});

// ── searchByText ─────────────────────────────────────────────────────

describe("searchByText", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4); // Small dimension for tests
  });

  it("finds exact keyword match", () => {
    insertMemory(db, "m1", "the quick brown fox jumps over the lazy dog");
    insertMemory(db, "m2", "a cat sleeps on the couch");

    const results = searchByText(db, "fox", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("FTS5 porter stemmer matches 'running' for query 'run'", () => {
    insertMemory(db, "m1", "she is running through the park");
    insertMemory(db, "m2", "he enjoys swimming");

    const results = searchByText(db, "run", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("returns results ordered by BM25 rank", () => {
    // Memory with more keyword density should rank higher
    insertMemory(db, "m1", "the cat sits");
    insertMemory(db, "m2", "the cat chases the cat toy and the cat plays");

    const results = searchByText(db, "cat", 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // BM25 rank: lower is better match. m2 should have better (lower) rank
    expect(results[0]!.id).toBe("m2");
  });

  it("returns empty for no-match query", () => {
    insertMemory(db, "m1", "the quick brown fox");

    const results = searchByText(db, "elephant", 10);
    expect(results).toHaveLength(0);
  });

  it("limit parameter is respected", () => {
    insertMemory(db, "m1", "the cat sits on the mat");
    insertMemory(db, "m2", "the cat plays with yarn");
    insertMemory(db, "m3", "the cat sleeps in the sun");

    const results = searchByText(db, "cat", 2);
    expect(results).toHaveLength(2);
  });

  it("returns empty when query has no valid tokens", () => {
    insertMemory(db, "m1", "the quick brown fox");

    const results = searchByText(db, "!@#$%", 10);
    expect(results).toHaveLength(0);
  });
});

// ── searchByVector ───────────────────────────────────────────────────

describe("searchByVector", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4); // 4-dimensional vectors for testing
  });

  it("finds nearest neighbor by cosine distance", () => {
    if (!isVecAvailable()) return;

    insertMemory(db, "m1", "entry one");
    insertMemory(db, "m2", "entry two");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);
    insertEmbedding(db, "m2", [0, 1, 0, 0]);

    // Query embedding close to m1
    const results = searchByVector(db, [0.9, 0.1, 0, 0], 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("k parameter controls result count", () => {
    if (!isVecAvailable()) return;

    insertMemory(db, "m1", "entry one");
    insertMemory(db, "m2", "entry two");
    insertMemory(db, "m3", "entry three");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);
    insertEmbedding(db, "m2", [0, 1, 0, 0]);
    insertEmbedding(db, "m3", [0, 0, 1, 0]);

    const results = searchByVector(db, [1, 0, 0, 0], 2);
    expect(results).toHaveLength(2);
  });

  it("Float32Array conversion works (same embedding returns distance near 0)", () => {
    if (!isVecAvailable()) return;

    insertMemory(db, "m1", "exact match");
    insertEmbedding(db, "m1", [0.5, 0.5, 0.5, 0.5]);

    const results = searchByVector(db, [0.5, 0.5, 0.5, 0.5], 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
    // Cosine distance for identical vectors should be ~0
    expect(results[0]!.distance).toBeCloseTo(0, 3);
  });

  it("returns empty when no embeddings are stored", () => {
    if (!isVecAvailable()) return;

    // No memories inserted at all
    const results = searchByVector(db, [1, 0, 0, 0], 10);
    expect(results).toHaveLength(0);
  });
});

// ── computeRRF ───────────────────────────────────────────────────────

describe("computeRRF", () => {
  it("result from both FTS and vec gets higher score than single-source", () => {
    const fts = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ];
    const vec = [
      { id: "a", rank: 1 },
      { id: "c", rank: 2 },
    ];

    const results = computeRRF(fts, vec);

    // "a" appears in both sources, should have highest score
    expect(results[0]!.id).toBe("a");

    // "a" score > "b" score and "a" score > "c" score
    const aScore = results.find((r) => r.id === "a")!.rrfScore;
    const bScore = results.find((r) => r.id === "b")!.rrfScore;
    const cScore = results.find((r) => r.id === "c")!.rrfScore;
    expect(aScore).toBeGreaterThan(bScore);
    expect(aScore).toBeGreaterThan(cScore);
  });

  it("empty FTS results -- vec results still ranked", () => {
    const fts: Array<{ id: string; rank: number }> = [];
    const vec = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ];

    const results = computeRRF(fts, vec);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("a");
    expect(results[0]!.ftsRank).toBeNull();
    expect(results[0]!.vecRank).toBe(1);
  });

  it("empty vec results -- FTS results still ranked", () => {
    const fts = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ];
    const vec: Array<{ id: string; rank: number }> = [];

    const results = computeRRF(fts, vec);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("a");
    expect(results[0]!.vecRank).toBeNull();
    expect(results[0]!.ftsRank).toBe(1);
  });

  it("both empty -- returns empty", () => {
    const results = computeRRF([], []);
    expect(results).toHaveLength(0);
  });

  it("weight parameters affect ranking", () => {
    // "a" is FTS-only, "b" is vec-only, both at rank 1
    const fts = [{ id: "a", rank: 1 }];
    const vec = [{ id: "b", rank: 1 }];

    // With higher vec weight, "b" should score higher
    const results = computeRRF(fts, vec, 1.0, 3.0);
    expect(results[0]!.id).toBe("b");

    // With higher FTS weight, "a" should score higher
    const results2 = computeRRF(fts, vec, 3.0, 1.0);
    expect(results2[0]!.id).toBe("a");
  });

  it("tracks source ranks correctly for dual-source results", () => {
    const fts = [{ id: "x", rank: 2 }];
    const vec = [{ id: "x", rank: 3 }];

    const results = computeRRF(fts, vec);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("x");
    expect(results[0]!.ftsRank).toBe(2);
    expect(results[0]!.vecRank).toBe(3);
  });
});

// ── hybridSearch (integration) ───────────────────────────────────────

describe("hybridSearch", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4);
  });

  it("combines FTS and vector results for same query", () => {
    if (!isVecAvailable()) return;

    // m1: matches text "dentist" and has embedding close to query
    insertMemory(db, "m1", "visit the dentist for a checkup");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);

    // m2: matches text "dentist" but different embedding
    insertMemory(db, "m2", "the dentist said everything is fine");
    insertEmbedding(db, "m2", [0, 1, 0, 0]);

    // m3: no text match but embedding is close to query
    insertMemory(db, "m3", "oral health appointment scheduled");
    insertEmbedding(db, "m3", [0.9, 0.1, 0, 0]);

    const results = hybridSearch(db, "dentist", [0.95, 0.05, 0, 0], {
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);

    // m1 should rank highest: matches both text AND vector
    expect(results[0]!.id).toBe("m1");
  });

  it("falls back to FTS-only when no embedding provided", () => {
    insertMemory(db, "m1", "the quick brown fox");
    insertMemory(db, "m2", "lazy dog sleeps");

    const results = hybridSearch(db, "fox", undefined, { limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("falls back to FTS-only when zero-length embedding provided", () => {
    insertMemory(db, "m1", "the quick brown fox");
    insertMemory(db, "m2", "lazy dog sleeps");

    // Empty array simulates embedding provider returning [] for short/emoji input
    const results = hybridSearch(db, "fox", [], { limit: 10 });

    // Should NOT crash -- zero-length guard skips vector search path
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("zero-length embedding produces same results as undefined embedding", () => {
    insertMemory(db, "m1", "cat plays with yarn ball");
    insertMemory(db, "m2", "cat naps in the sun");
    insertMemory(db, "m3", "dog barks at the mailman");

    const undefinedResults = hybridSearch(db, "cat", undefined, { limit: 10 });
    const emptyResults = hybridSearch(db, "cat", [], { limit: 10 });

    // Both should produce identical FTS-only results
    expect(emptyResults).toHaveLength(undefinedResults.length);
    expect(emptyResults.map((r) => r.id)).toEqual(undefinedResults.map((r) => r.id));
  });

  it("respects limit parameter on final output", () => {
    insertMemory(db, "m1", "cat plays with yarn");
    insertMemory(db, "m2", "cat naps in the sun");
    insertMemory(db, "m3", "cat chases a mouse");

    const results = hybridSearch(db, "cat", undefined, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("filters by trustLevel", () => {
    insertMemory(db, "m1", "trusted cat memory", { trustLevel: "system" });
    insertMemory(db, "m2", "external cat data", { trustLevel: "external" });

    const results = hybridSearch(db, "cat", undefined, {
      limit: 10,
      trustLevel: "system",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("filters by memoryType", () => {
    insertMemory(db, "m1", "episodic cat event", { memoryType: "episodic" });
    insertMemory(db, "m2", "semantic cat fact", { memoryType: "semantic" });

    const results = hybridSearch(db, "cat", undefined, {
      limit: 10,
      memoryType: "episodic",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("filters by tenantId", () => {
    insertMemory(db, "m1", "tenant A cat", { tenantId: "tenantA" });
    insertMemory(db, "m2", "tenant B cat", { tenantId: "tenantB" });

    const results = hybridSearch(db, "cat", undefined, {
      limit: 10,
      tenantId: "tenantA",
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("returns empty when no memories match query", () => {
    insertMemory(db, "m1", "the quick brown fox");

    const results = hybridSearch(db, "elephant", undefined, { limit: 10 });
    expect(results).toHaveLength(0);
  });

  it("returns empty when query produces no valid tokens", () => {
    insertMemory(db, "m1", "the quick brown fox");

    const results = hybridSearch(db, "!@#$%", undefined, { limit: 10 });
    expect(results).toHaveLength(0);
  });

  it("returns vector-only results when FTS5 has no keyword matches", () => {
    if (!isVecAvailable()) return;

    insertMemory(db, "m1", "space shooter with asteroids");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);
    insertMemory(db, "m2", "underwater exploration game");
    insertEmbedding(db, "m2", [0, 1, 0, 0]);

    // Query has no keyword overlap but embedding is close to m1
    const results = hybridSearch(db, "cosmic blaster", [0.9, 0.1, 0, 0], { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe("m1");
  });

  it("vector weight boost ranks semantic matches higher", () => {
    if (!isVecAvailable()) return;

    // m1: weak FTS match (rank 2), strong vector match (rank 1)
    insertMemory(db, "m1", "space shooter void breaker game with depth");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);
    // m2: strong FTS match (rank 1), weak vector match (rank 2)
    insertMemory(db, "m2", "built a game together recently");
    insertEmbedding(db, "m2", [0, 1, 0, 0]);

    // Query embedding close to m1, text matches "game" in both
    const results = hybridSearch(db, "game", [0.95, 0.05, 0, 0], { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // m1 should rank higher due to vector weight boost (1.5x)
    expect(results[0]!.id).toBe("m1");
  });
});

// ── RRF score normalization ─────────────────────────────────────────

describe("RRF score normalization", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 4);
  });

  it("hybridSearch scores are normalized to 0-1 range", () => {
    if (!isVecAvailable()) return;

    insertMemory(db, "m1", "the dentist appointment next week");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);
    insertMemory(db, "m2", "dentist cleaning scheduled for monday");
    insertEmbedding(db, "m2", [0.8, 0.2, 0, 0]);
    insertMemory(db, "m3", "visit dentist for cavity filling");
    insertEmbedding(db, "m3", [0.6, 0.4, 0, 0]);

    const results = hybridSearch(db, "dentist", [0.95, 0.05, 0, 0], {
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("highest-ranked result has score near 1.0", () => {
    if (!isVecAvailable()) return;

    // m1 matches both FTS and vector at rank 1
    insertMemory(db, "m1", "dentist checkup tomorrow morning");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);
    insertMemory(db, "m2", "dentist said teeth are healthy");
    insertEmbedding(db, "m2", [0, 1, 0, 0]);

    const results = hybridSearch(db, "dentist", [0.99, 0.01, 0, 0], {
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    // After normalization, top result should score well above 0.5
    // (raw RRF would be ~0.041, proving normalization happened)
    expect(results[0]!.score).toBeGreaterThan(0.5);
  });

  it("FTS-only fallback scores are normalized to 0-1 range", () => {
    insertMemory(db, "m1", "cat plays with yarn ball");
    insertMemory(db, "m2", "cat naps in the sunny window");
    insertMemory(db, "m3", "cat chases a laser pointer");

    // No embedding provided -- FTS-only fallback
    const results = hybridSearch(db, "cat", undefined, { limit: 10 });

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("score ordering preserved after normalization", () => {
    if (!isVecAvailable()) return;

    // Varied relevance: m1 matches both strongly, m2 matches FTS only, m3 matches vec weakly
    insertMemory(db, "m1", "cat plays with yarn ball daily");
    insertEmbedding(db, "m1", [1, 0, 0, 0]);
    insertMemory(db, "m2", "cat naps in the sunny window all day");
    insertEmbedding(db, "m2", [0, 0, 1, 0]);
    insertMemory(db, "m3", "dog barks at the mailman");
    insertEmbedding(db, "m3", [0.9, 0.1, 0, 0]);

    const results = hybridSearch(db, "cat", [0.95, 0.05, 0, 0], {
      limit: 10,
    });

    // Scores must be in strictly descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("computeRRF raw scores are NOT normalized", () => {
    // computeRRF is the raw engine -- normalization happens in hybridSearch
    const fts = [{ id: "a", rank: 1 }];
    const vec = [{ id: "a", rank: 1 }];

    const results = computeRRF(fts, vec, 1.0, 1.5);

    expect(results).toHaveLength(1);
    // Raw RRF score: (1.0 / 61) + (1.5 / 61) = 2.5 / 61 = ~0.04098
    expect(results[0]!.rrfScore).toBeLessThan(0.05);
    expect(results[0]!.rrfScore).toBeGreaterThan(0);
  });
});
