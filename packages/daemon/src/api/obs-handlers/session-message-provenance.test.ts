// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { OriginalInboundMessage } from "@comis/core";
import {
  createProvenanceAssembler,
  type DecodedProvenanceRecord,
} from "./session-message-provenance.js";

const message: OriginalInboundMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "chat-a",
  channelType: "telegram",
  senderId: "sender-a",
  text: "physical body",
  timestamp: 1_789_000_000_001,
};

function chunk(chunkIndex: number): DecodedProvenanceRecord {
  return {
    kind: "valid",
    batchId: "22222222-2222-4222-8222-222222222222",
    chunkIndex,
    chunkCount: 2,
    recordedAt: 1_789_000_100_000,
    messages: [{ ...message, id: `${chunkIndex + 1}1111111-1111-4111-8111-111111111111` }],
  };
}

describe("createProvenanceAssembler", () => {
  it("rejects reversed chunks without emitting a partial occurrence", () => {
    const assembler = createProvenanceAssembler();

    const reversedLast = assembler.consume(chunk(1));
    const reversedFirst = assembler.consume(chunk(0));
    const finished = assembler.finish();

    expect([
      ...reversedLast.completed,
      ...reversedFirst.completed,
      ...finished.completed,
    ]).toEqual([]);
    expect(
      reversedLast.invalidOccurrences +
      reversedFirst.invalidOccurrences +
      finished.invalidOccurrences,
    ).toBe(2);
  });

  it("invalidates a duplicate chunk index and restarts from the new chunk zero", () => {
    const assembler = createProvenanceAssembler();

    const first = assembler.consume(chunk(0));
    const duplicate = assembler.consume(chunk(0));
    const last = assembler.consume(chunk(1));
    const finished = assembler.finish();

    const completed = [
      ...first.completed,
      ...duplicate.completed,
      ...last.completed,
      ...finished.completed,
    ];
    expect(completed).toHaveLength(1);
    expect(completed[0]!.messages).toEqual([chunk(0).messages[0], chunk(1).messages[0]]);
    expect(
      first.invalidOccurrences +
      duplicate.invalidOccurrences +
      last.invalidOccurrences +
      finished.invalidOccurrences,
    ).toBe(1);
  });

  it("closes an incomplete occurrence when an unrelated record intervenes", () => {
    const assembler = createProvenanceAssembler();

    const first = assembler.consume(chunk(0));
    const intervening = assembler.consume({ kind: "other" });
    const last = assembler.consume(chunk(1));

    expect([...first.completed, ...intervening.completed, ...last.completed]).toEqual([]);
    expect(intervening.invalidOccurrences).toBe(1);
    expect(last.invalidOccurrences).toBe(1);
  });

  it("invalidates an occurrence whose chunks exceed ten thousand aggregate messages", () => {
    const assembler = createProvenanceAssembler();
    const manyMessages = Array.from({ length: 6_000 }, () => message);

    const first = assembler.consume({ ...chunk(0), messages: manyMessages });
    const overflowing = assembler.consume({ ...chunk(1), messages: manyMessages });
    const finished = assembler.finish();

    expect([...first.completed, ...overflowing.completed, ...finished.completed]).toEqual([]);
    expect(overflowing.invalidOccurrences).toBe(1);
    expect(finished.invalidOccurrences).toBe(0);
  });
});
