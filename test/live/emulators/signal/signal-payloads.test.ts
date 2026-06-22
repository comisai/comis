// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A test for the Signal `SignalEnvelope` builders (CHAN2-01 / invariant
 * I4, Phase 209).
 *
 * The builders import the Signal adapter's OWN exported `SignalEnvelope` /
 * `SignalAttachment` wire interface (re-exported `type`-only from the
 * `@comis/channels` barrel) and return-annotate against it, so a wire-shape
 * drift is a COMPILE error — the I4 discipline. This test asserts the RUNTIME
 * shape (the fields `mapSignalToNormalized` reads) AND round-trips a built
 * envelope through the REAL production mapper (the strongest fidelity proof: the
 * builder produces exactly what the adapter parses).
 *
 * `@comis/channels` resolves from `dist/` via the live vitest alias, so the
 * `mapSignalToNormalized` import + the `SignalEnvelope` type both read the REAL
 * built adapter (run `pnpm build` first if stale — esp. after the barrel
 * re-export lands so `channels/dist/index.d.ts` carries the type).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/signal/signal-payloads.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { mapSignalToNormalized } from "@comis/channels";
import {
  makeMessageEnvelope,
  makeReactionEnvelope,
  makeSignalAttachment,
  nextSignalTimestamp,
  resetSignalTimestampCounter,
} from "./signal-payloads.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOADS_SOURCE = resolve(HERE, "signal-payloads.ts");

// A loopback base URL — `mapSignalToNormalized` only uses it to build
// attachment download URLs; the text/reaction round-trips do not touch it.
const BASE_URL = "http://127.0.0.1:8080";

describe("signal-payloads — makeMessageEnvelope (CHAN2-01 text round-trip)", () => {
  beforeEach(() => {
    resetSignalTimestampCounter();
  });

  it("builds a SignalEnvelope with dataMessage.message and the sender identity set", () => {
    const env = makeMessageEnvelope({ from: "+15555550100", content: "hello world" });
    expect(env.dataMessage?.message).toBe("hello world");
    expect(env.source).toBe("+15555550100");
    expect(env.sourceNumber).toBe("+15555550100");
    // A DM omits groupInfo — the channel id is the sender.
    expect(env.dataMessage?.groupInfo).toBeUndefined();
  });

  it("produces what the REAL mapSignalToNormalized parses (text inbound)", () => {
    const env = makeMessageEnvelope({ from: "+15555550100", content: "the answer is 42" });
    const normalized = mapSignalToNormalized(env, BASE_URL);
    expect(normalized).not.toBeNull();
    expect(normalized?.text).toBe("the answer is 42");
    expect(normalized?.channelType).toBe("signal");
    expect(normalized?.chatType).toBe("dm");
    // senderId resolves sourceUuid ?? sourceNumber ?? source — the uuid wins.
    expect(normalized?.senderId).toBe(env.sourceUuid);
  });

  it("sets dataMessage.groupInfo.groupId when the channel is group:<id>", () => {
    const env = makeMessageEnvelope({ from: "+15555550100", channel: "group:dGVzdC1ncm91cA==", content: "hi group" });
    expect(env.dataMessage?.groupInfo?.groupId).toBe("dGVzdC1ncm91cA==");
    // And the REAL mapper derives a group chatType + the group channel id.
    const normalized = mapSignalToNormalized(env, BASE_URL);
    expect(normalized?.chatType).toBe("group");
    expect(normalized?.channelId).toBe("group:dGVzdC1ncm91cA==");
  });

  it("emits a strictly-increasing timestamp by default (the long-poll/react ordering invariant)", () => {
    const a = makeMessageEnvelope({ from: "+1", content: "a" });
    const b = makeMessageEnvelope({ from: "+1", content: "b" });
    expect(typeof a.timestamp).toBe("number");
    expect((b.timestamp ?? 0) > (a.timestamp ?? 0)).toBe(true);
    // The mapper reads envelope.timestamp (message-mapper.ts:37) → the durable
    // metadata.signalTimestamp; the adapter's `dataMessage` wire interface has NO
    // timestamp field (signal-client.ts:37-58), so the I4-typed builder cannot
    // (and must not) set one — the strict-tsc leg would reject it.
    const normalized = mapSignalToNormalized(a, BASE_URL);
    expect(normalized?.timestamp).toBe(a.timestamp);
  });
});

describe("signal-payloads — makeReactionEnvelope (CHAN2-01 the react FLOW)", () => {
  beforeEach(() => {
    resetSignalTimestampCounter();
  });

  it("builds a SignalEnvelope whose dataMessage.reaction sets { emoji, targetSentTimestamp }", () => {
    const target = nextSignalTimestamp();
    const env = makeReactionEnvelope({ from: "+15555550100", emoji: "👍", targetSentTimestamp: target });
    expect(env.dataMessage?.reaction?.emoji).toBe("👍");
    expect(env.dataMessage?.reaction?.targetSentTimestamp).toBe(target);
    // A reaction envelope carries no text message body.
    expect(env.dataMessage?.message).toBeUndefined();
  });

  it("the REAL mapSignalToNormalized maps the reaction (metadata.signalReaction=true)", () => {
    const target = nextSignalTimestamp();
    const env = makeReactionEnvelope({ from: "+15555550100", emoji: "❤️", targetSentTimestamp: target });
    const normalized = mapSignalToNormalized(env, BASE_URL);
    expect(normalized).not.toBeNull();
    // message-mapper.ts:48-66 — the reaction branch.
    expect(normalized?.metadata?.signalReaction).toBe(true);
    expect(normalized?.metadata?.signalReactionEmoji).toBe("❤️");
    expect(normalized?.metadata?.signalReactionTarget).toBe(target);
    // The reaction emoji also becomes the NormalizedMessage.text (message-mapper.ts:61).
    expect(normalized?.text).toBe("❤️");
  });

  it("sets reaction.isRemove when remove:true (the un-react path)", () => {
    const env = makeReactionEnvelope({ from: "+1", emoji: "👍", targetSentTimestamp: 1_700_000_000_005, remove: true });
    expect(env.dataMessage?.reaction?.isRemove).toBe(true);
    const normalized = mapSignalToNormalized(env, BASE_URL);
    expect(normalized?.metadata?.signalReactionRemove).toBe(true);
  });

  it("omits isRemove on a plain add (exactOptionalPropertyTypes)", () => {
    const env = makeReactionEnvelope({ from: "+1", emoji: "👍", targetSentTimestamp: 1_700_000_000_006 });
    expect(env.dataMessage?.reaction).not.toHaveProperty("isRemove");
  });
});

describe("signal-payloads — makeSignalAttachment (the I4 attachment tripwire)", () => {
  it("builds a SignalAttachment carrying id + the optional descriptor fields", () => {
    const att = makeSignalAttachment({ id: "att-1", contentType: "image/png", filename: "pic.png", size: 1024 });
    expect(att.id).toBe("att-1");
    expect(att.contentType).toBe("image/png");
    expect(att.filename).toBe("pic.png");
    expect(att.size).toBe(1024);
  });

  it("omits absent optional fields (exactOptionalPropertyTypes)", () => {
    const att = makeSignalAttachment({ id: "att-2" });
    expect(att.id).toBe("att-2");
    expect(att).not.toHaveProperty("contentType");
    expect(att).not.toHaveProperty("filename");
    expect(att).not.toHaveProperty("size");
  });
});

describe("signal-payloads — I4 source discipline (the wire-type import is type-only + return-annotated)", () => {
  it("imports the wire types type-only (erased — no @comis/* runtime edge, SEC-02-safe)", () => {
    const src = readFileSync(PAYLOADS_SOURCE, "utf8");
    // `import type { SignalEnvelope, SignalAttachment } from "@comis/channels"`.
    expect(src).toMatch(/import type \{[^}]*SignalEnvelope[^}]*\} from "@comis\/channels"/);
  });

  it("returns a SignalEnvelope from each builder via an explicit return annotation (the I4 compile-drift guarantee)", () => {
    const src = readFileSync(PAYLOADS_SOURCE, "utf8");
    expect(src).toMatch(/: SignalEnvelope/);
    // The reaction builder exists (the WS1-relevant verb).
    expect(src).toMatch(/reaction/);
  });
});
