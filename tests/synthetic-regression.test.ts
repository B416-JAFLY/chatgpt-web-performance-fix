import { describe, expect, test } from "bun:test";
import { optimizeConversationPayload, optimizePaginatedConversationPayload, splitPaginatedMessagesNewestFirst } from "../src/optimizer";
import { traceActivePath } from "./helpers";
import { syntheticConversation } from "./fixtures/synthetic-conversation";

describe("synthetic legacy conversation regression", () => {
  test("compacts a large conversation and reduces its serialized size", () => {
    const { payload } = syntheticConversation();
    const result = optimizeConversationPayload(payload, { recentFullTurns: 1 });
    expect(result.stats.reason).toBe("optimized");
    expect(result.stats.originalNodes).toBeGreaterThan(250);
    expect(result.stats.removedHistoricNodes).toBeGreaterThan(300);
    expect(JSON.stringify(result.payload).length).toBeLessThan(JSON.stringify(payload).length * 0.5);
  });
  test("preserves the current leaf and a consistent linear path", () => {
    const { payload } = syntheticConversation();
    const result = optimizeConversationPayload(payload, { recentFullTurns: 1 });
    const path = traceActivePath(result.payload);
    expect(path.at(-1)?.id).toBe(payload.current_node);
    for (let i = 0; i < path.length; i++) {
      expect(path[i].node.parent).toBe(path[i - 1]?.id ?? null);
      expect(path[i].node.children).toEqual(path[i + 1] ? [path[i + 1].id] : []);
    }
  });
  test("keeps visible historic messages and every message in the newest turn", () => {
    const { payload, turns } = syntheticConversation();
    const ids = new Set(Object.keys(optimizeConversationPayload(payload, { recentFullTurns: 1 }).payload.mapping!));
    for (const turn of turns) {
      expect(ids.has(turn[0].id!)).toBeTrue();
      expect(ids.has(turn.at(-1)!.id!)).toBeTrue();
    }
    for (const message of turns.at(-1)!) expect(ids.has(message.id!)).toBeTrue();
    expect(ids.has("tool-0-0")).toBeFalse();
    expect(ids.has("call-1-0")).toBeFalse();
  });
  test("removes inactive branches while preserving active user messages", () => {
    const { payload, turns, inactiveIds } = syntheticConversation();
    const ids = new Set(Object.keys(optimizeConversationPayload(payload, { recentFullTurns: 1 }).payload.mapping!));
    for (const id of inactiveIds) expect(ids.has(id)).toBeFalse();
    for (const turn of turns) expect(ids.has(turn[0].id!)).toBeTrue();
  });
});

describe("synthetic paginated conversation regression", () => {
  test("preserves visible historical content of multiple types", () => {
    const messages = [
      { id: "user", author: { role: "user" }, content: { content_type: "text", parts: ["Question"] } },
      { id: "text", author: { role: "assistant" }, content: { content_type: "text", parts: ["Visible text"] } },
      { id: "image", author: { role: "assistant" }, content: { content_type: "multimodal_text", parts: ["Image description"] } },
      { id: "recap", author: { role: "assistant" }, content: { content_type: "reasoning_recap", parts: ["Summary"] } },
      { id: "internal", author: { role: "assistant" }, content: { content_type: "thoughts", parts: ["Internal"] } },
      { id: "final", author: { role: "assistant" }, channel: "final", content: { content_type: "text", parts: ["Final answer"] } },
    ];
    const result = optimizePaginatedConversationPayload({ messages }, { recentFullTurns: 0 });
    expect(result.payload.messages?.map(message => message.id)).toEqual(["user", "text", "image", "recap", "final"]);
  });
  test("removes internal messages from a completed historical turn", () => {
    const { turns } = syntheticConversation();
    const result = optimizePaginatedConversationPayload({ messages: turns[0] }, { recentFullTurns: 0 });
    expect(result.stats.changed).toBeTrue();
    expect(result.payload.messages?.map(m => m.id)).toEqual(["user-0", "answer-0"]);
    expect(result.stats.keptBytes).toBeLessThan(result.stats.originalBytes * 0.1);
  });
  test("compacts an older turn and preserves the newest turn intact", () => {
    const { turns, payload } = syntheticConversation();
    const result = optimizePaginatedConversationPayload({ current_node: payload.current_node, messages: [...turns[1], ...turns[2]] }, { recentFullTurns: 1, forceKeepMessageIds: [payload.current_node!] });
    expect(result.payload.messages?.map(m => m.id)).toEqual(["user-1", "answer-1", ...turns[2].map(m => m.id)]);
  });
  test("collapses a completed historical turn to the user question and final answer", () => {
    const { turns } = syntheticConversation();
    const result = optimizePaginatedConversationPayload({ messages: turns[0] }, { recentFullTurns: 0, collapseTurnsToQuestionAnswer: true });
    expect(result.payload.messages?.map(m => m.id)).toEqual(["user-0", "answer-0"]);
    const chunks = splitPaginatedMessagesNewestFirst(result.payload.messages!, { maxTurns: 1, maxMessages: 2, maxBytes: 32768, allowSplitTurns: false });
    expect(chunks.map(chunk => chunk.map(m => m.id))).toEqual([["user-0", "answer-0"]]);
  });
  test("retains a forced internal current message when collapsing a completed turn", () => {
    const { turns } = syntheticConversation();
    const result = optimizePaginatedConversationPayload({ current_node: "tool-1-0", messages: turns[1] }, { recentFullTurns: 0, forceKeepMessageIds: ["tool-1-0"], collapseTurnsToQuestionAnswer: true });
    expect(result.payload.messages?.map(m => m.id)).toEqual(["user-1", "tool-1-0", "answer-1"]);
  });
  test("splits newest-first without reordering messages or splitting turns", () => {
    const { turns, payload } = syntheticConversation();
    const result = optimizePaginatedConversationPayload({ current_node: payload.current_node, messages: [...turns[1], ...turns[2]] }, { recentFullTurns: 1, forceKeepMessageIds: [payload.current_node!] });
    const kept = result.payload.messages!;
    const chunks = splitPaginatedMessagesNewestFirst(kept, { maxTurns: 1, maxMessages: 16, maxBytes: 128 * 1024, allowSplitTurns: false });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].at(-1)?.id).toBe(payload.current_node);
    expect(chunks.toReversed().flat().map(m => m.id)).toEqual(kept.map(m => m.id));
    expect(chunks[1].map(m => m.id)).toEqual(["user-1", "answer-1"]);
  });
});
