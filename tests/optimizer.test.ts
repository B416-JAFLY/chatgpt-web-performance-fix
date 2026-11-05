import { describe, expect, test } from "bun:test";
import {
  clampPaginatedNumTurns,
  computeMarkdownCodeFence,
  convertNativeInitialToLazyConversation,
  extractFencedCodeBlocks,
  isLegacyFullConversationUrl,
  lightenPaginatedCodeBlocks,
  matchConversationApiUrl,
  optimizeConversationPayload,
  optimizePaginatedConversationPayload,
  splitPaginatedMessagesNewestFirst,
  type ConversationMessage,
  type ConversationPayload,
} from "../src/optimizer";

describe("optimizer safety guards", () => {
  test("does not modify ordinary small conversations", () => {
    const payload: ConversationPayload = {
      current_node: "child",
      mapping: {
        root: { id: "root", parent: null, children: ["child"] },
        child: {
          id: "child",
          parent: "root",
          children: [],
          message: {
            id: "child",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["hello"] },
          },
        },
      },
    };

    const result = optimizeConversationPayload(payload);
    expect(result.stats.reason).toBe("below-threshold");
    expect(result.payload).toBe(payload);
  });

  test("does not touch native paginated payloads", () => {
    const payload: ConversationPayload = {
      current_node: "paginated-root:test",
      mapping: {
        "paginated-root:test": {
          id: "paginated-root:test",
          parent: null,
          children: [],
        },
      },
      __paginatedConversationPage: {},
    };

    const result = optimizeConversationPayload(payload, { minNodeCount: 0 });
    expect(result.stats.reason).toBe("already-paginated");
    expect(result.payload).toBe(payload);
  });

  test("fails closed for a cyclic active path", () => {
    const payload: ConversationPayload = {
      current_node: "a",
      mapping: {
        a: { id: "a", parent: "b", children: ["b"] },
        b: { id: "b", parent: "a", children: ["a"] },
      },
    };

    const result = optimizeConversationPayload(payload, { minNodeCount: 0 });
    expect(result.stats.reason).toBe("invalid-active-path");
    expect(result.payload).toBe(payload);
  });
});

describe("legacy emergency optimizer", () => {
  test("keeps the structural root, user, and current dependency nodes when a live turn has no visible AI text", () => {
    const payload: ConversationPayload = {
      current_node: "tool-result",
      mapping: {
        root: { id: "root", parent: null, children: ["user"] },
        user: {
          id: "user",
          parent: "root",
          children: ["thought"],
          message: {
            id: "user",
            author: { role: "user" },
            content: { content_type: "text", parts: ["question"] },
          },
        },
        thought: {
          id: "thought",
          parent: "user",
          children: ["old-tool-call"],
          message: {
            id: "thought",
            author: { role: "assistant" },
            content: { content_type: "thoughts", parts: ["internal"] },
          },
        },
        "old-tool-call": {
          id: "old-tool-call",
          parent: "thought",
          children: ["old-tool-result"],
          message: {
            id: "old-tool-call",
            author: { role: "assistant" },
            recipient: "tool.old",
            content: { content_type: "code", parts: ["old call"] },
          },
        },
        "old-tool-result": {
          id: "old-tool-result",
          parent: "old-tool-call",
          children: ["tool-call"],
          message: {
            id: "old-tool-result",
            author: { role: "tool" },
            content: { content_type: "code", parts: ["old result"] },
          },
        },
        "tool-call": {
          id: "tool-call",
          parent: "old-tool-result",
          children: ["tool-result"],
          message: {
            id: "tool-call",
            author: { role: "assistant" },
            recipient: "tool.current",
            content: { content_type: "code", parts: ["current call"] },
          },
        },
        "tool-result": {
          id: "tool-result",
          parent: "tool-call",
          children: [],
          message: {
            id: "tool-result",
            author: { role: "tool" },
            content: { content_type: "code", parts: ["current result"] },
          },
        },
      },
    };

    const result = optimizeConversationPayload(payload, {
      minNodeCount: 0,
      recentFullTurns: 0,
      preserveCurrentParent: true,
      collapseTurnsToQuestionAnswer: true,
    });

    expect(Object.keys(result.payload.mapping ?? {})).toEqual([
      "root",
      "user",
      "tool-call",
      "tool-result",
    ]);
    expect(result.payload.current_node).toBe("tool-result");
    expect(result.payload.mapping?.["tool-call"]?.parent).toBe("user");
    expect(result.payload.mapping?.["tool-result"]?.parent).toBe("tool-call");
  });
});

describe("native paginated conversation optimizer", () => {
  test("keeps a bridge message for an unusual all-internal page", () => {
    const messages: ConversationMessage[] = [
      {
        id: "invoke",
        author: { role: "assistant" },
        recipient: "tool.example",
        content: { content_type: "code", parts: ["large args"] },
      },
      {
        id: "result",
        author: { role: "tool" },
        content: { content_type: "code", parts: ["large result"] },
      },
    ];
    const result = optimizePaginatedConversationPayload(
      { messages },
      { recentFullTurns: 0 },
    );

    expect(result.payload.messages).toHaveLength(1);
    expect(result.payload.messages?.[0]?.id).toBe("result");
  });


});


describe("native initial response conversion", () => {
  test("builds the exact lazy conversation envelope expected by the fallback loader", () => {
    const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const messages: ConversationMessage[] = [
      {
        id: "user-message",
        author: { role: "user" },
        content: { content_type: "text", parts: ["hello"] },
        status: "finished_successfully",
      },
      {
        id: "assistant-message",
        author: { role: "assistant" },
        channel: "final",
        recipient: "all",
        content: { content_type: "text", parts: ["world"] },
        status: "finished_successfully",
      },
    ];
    const converted = convertNativeInitialToLazyConversation(
      {
        title: "lazy",
        conversation_id: conversationId,
        current_node: "assistant-message",
        messages,
        moderation_results: [],
        page_info: { has_previous_page: true, start_cursor: "server-cursor" },
        safe_urls: ["https://example.com"],
        blocked_urls: [],
      },
      conversationId,
      2,
    );

    expect(converted).not.toBeNull();
    expect(converted?.current_node).toBe("assistant-message");
    expect(Object.keys(converted?.mapping ?? {})).toEqual([
      `paginated-root:${conversationId}`,
      "user-message",
      "assistant-message",
    ]);
    expect(converted?.mapping?.["user-message"]?.parent).toBe(
      `paginated-root:${conversationId}`,
    );
    expect(converted?.mapping?.["assistant-message"]?.children).toEqual([]);
    expect(converted?.__paginatedConversationPage).toMatchObject({
      cursor: "server-cursor",
      numTurns: 2,
      oldestMessageId: "user-message",
      serverCurrentLeafId: "assistant-message",
    });
    expect(
      converted?.__paginatedConversationPage.messagesLeafToRoot.map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-message", "user-message"]);
    expect("messages" in (converted ?? {})).toBeFalse();
    expect("page_info" in (converted ?? {})).toBeFalse();
  });

  test("fails closed for duplicate or missing message ids", () => {
    expect(
      convertNativeInitialToLazyConversation(
        {
          messages: [
            { id: "same", author: { role: "user" } },
            { id: "same", author: { role: "assistant" } },
          ],
        },
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        1,
      ),
    ).toBeNull();
  });
});

describe("conversation API URL matcher", () => {
  const base = "https://chatgpt.com/c/anything";
  const id = "33333333-3333-4333-8333-333333333333";

  test("matches only the singular full-conversation endpoint", () => {
    expect(
      isLegacyFullConversationUrl(`/backend-api/conversation/${id}`, base),
    ).toBeTrue();
    expect(
      isLegacyFullConversationUrl(
        `https://chatgpt.com/backend-api/conversation/${id}/`,
        base,
      ),
    ).toBeTrue();
    expect(
      isLegacyFullConversationUrl(`/backend-api/conversations/${id}`, base),
    ).toBeFalse();
    expect(
      isLegacyFullConversationUrl(
        `/backend-api/conversation/${id}/messages`,
        base,
      ),
    ).toBeFalse();
    expect(isLegacyFullConversationUrl("/backend-api/conversation/init", base)).toBeFalse();
  });

  test("classifies native initial and older-message endpoints", () => {
    expect(
      matchConversationApiUrl(`/backend-api/conversations/${id}?num_turns=20`, base),
    ).toEqual({ kind: "paginated-initial", conversationId: id });
    expect(
      matchConversationApiUrl(
        `/backend-api/conversations/${id}/messages?before=cursor&num_turns=20`,
        base,
      ),
    ).toEqual({ kind: "paginated-messages", conversationId: id });
    expect(matchConversationApiUrl("/backend-api/conversations?limit=20", base)).toBeNull();
  });

  test("clamps native page size without touching other query parameters", () => {
    const clamped = new URL(
      clampPaginatedNumTurns(
        `/backend-api/conversations/${id}/messages?before=abc&include_has_versions=true&num_turns=20`,
        base,
        2,
      ),
    );
    expect(clamped.searchParams.get("num_turns")).toBe("2");
    expect(clamped.searchParams.get("before")).toBe("abc");
    expect(clamped.searchParams.get("include_has_versions")).toBe("true");

    const alreadySmall = clampPaginatedNumTurns(
      `/backend-api/conversations/${id}?num_turns=1`,
      base,
      2,
    );
    expect(new URL(alreadySmall).searchParams.get("num_turns")).toBe("1");
  });
});

describe("static code markdown fence & oversized turn strategies", () => {
  test("computeMarkdownCodeFence chooses a fence longer than any backtick run in code", () => {
    expect(computeMarkdownCodeFence("const x = 1;")).toBe("```");
    expect(computeMarkdownCodeFence("const md = '```js\\ncode\\n```';")).toBe("````");
    expect(computeMarkdownCodeFence("nested ````markdown\n```ts\n```\n````")).toBe("`````");
    expect(computeMarkdownCodeFence("deep `````` six backticks")).toBe("```````");
  });

  test("extractFencedCodeBlocks and lightenPaginatedCodeBlocks lighten oversized single-block code", () => {
    const giantCode = Array.from({ length: 120 }, (_, i) => `const line_${i} = "${"x".repeat(40)}";`).join("\n");
    const payload = {
      messages: [
        {
          id: "u1",
          author: { role: "user" },
          content: { content_type: "text", parts: ["Show giant file"] },
        },
        {
          id: "a1",
          author: { role: "assistant" },
          channel: "final",
          recipient: "all",
          content: {
            content_type: "text",
            parts: [`Here is the file:\n\`\`\`ts\n${giantCode}\n\`\`\``],
          },
        },
      ],
    };
    let seq = 0;
    const lightened = lightenPaginatedCodeBlocks(
      payload,
      "test",
      () => {
        seq += 1;
        return seq;
      },
      2_048,
    );
    expect(lightened.codeBlocks).toHaveLength(1);
    expect(lightened.codeBlocks[0].code).toBe(giantCode);
    const partText = String(lightened.payload.messages?.[1]?.content?.parts?.[0] ?? "");
    expect(partText).toContain("#cgptperf-code=");
    expect(partText).not.toContain("const line_0");
  });

  test("compactOversizedTurns bounds an abnormally huge active turn while preserving semantics", () => {
    const messages: ConversationMessage[] = [
      {
        id: "user-giant",
        author: { role: "user" },
        content: { content_type: "text", parts: ["Run 60 heavy tool steps"] },
      },
    ];
    for (let i = 0; i < 60; i += 1) {
      messages.push(
        {
          id: `call-${i}`,
          author: { role: "assistant" },
          recipient: "tool.exec",
          content: { content_type: "code", parts: ["a".repeat(8_000)] },
        },
        {
          id: `out-${i}`,
          author: { role: "tool" },
          content: { content_type: "execution_output", parts: ["b".repeat(8_000)] },
        },
      );
    }
    messages.push({
      id: "final-giant",
      author: { role: "assistant" },
      channel: "final",
      recipient: "all",
      content: { content_type: "text", parts: ["Final summarized answer"] },
    });

    const result = optimizePaginatedConversationPayload(
      { current_node: "final-giant", messages },
      {
        recentFullTurns: 1,
        compactOversizedTurns: true,
        oversizedTurnMessages: 32,
        oversizedTurnBytes: 256 * 1024,
        maxOversizedToolPartChars: 2_048,
      },
    );

    expect(result.stats.changed).toBeTrue();
    expect(result.stats.oversizedTurnsCompacted).toBe(1);
    const keptIds = result.payload.messages?.map((m) => m.id) ?? [];
    expect(keptIds[0]).toBe("user-giant");
    expect(keptIds.at(-1)).toBe("final-giant");
    expect(keptIds.length).toBeLessThan(10);
    expect(result.stats.keptBytes).toBeLessThan(result.stats.originalBytes * 0.05);
  });
});
