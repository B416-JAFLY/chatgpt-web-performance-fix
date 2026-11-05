// ==UserScript==
// @name         ChatGPT Performance Fix (B416-JAFLY fork)
// @name:zh-CN   ChatGPT 性能优化（B416-JAFLY fork）
// @namespace    https://github.com/B416-JAFLY
// @version      0.1.1
// @description  Improve ChatGPT performance on long conversations.
// @description:zh-CN 改善 ChatGPT 长会话性能。
// @author       canxin
// @homepageURL  https://github.com/B416-JAFLY/chatgpt-web-performance-fix
// @supportURL   https://github.com/B416-JAFLY/chatgpt-web-performance-fix/issues
// @updateURL    https://raw.githubusercontent.com/B416-JAFLY/chatgpt-web-performance-fix/improve/observer-overhead/dist/chatgpt-performance-fix.user.js
// @downloadURL  https://raw.githubusercontent.com/B416-JAFLY/chatgpt-web-performance-fix/improve/observer-overhead/dist/chatgpt-performance-fix.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(() => {
  // src/optimizer.ts
  var DEFAULT_OPTIMIZER_OPTIONS = {
    minNodeCount: 250,
    recentFullTurns: 1,
    preserveCurrentParent: false,
    collapseTurnsToQuestionAnswer: false
  };
  var ALWAYS_KEEP_ROLES = new Set(["system", "developer"]);
  var KNOWN_INTERNAL_CONTENT_TYPES = new Set([
    "code",
    "execution_output",
    "thoughts"
  ]);
  function serializedBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  function messageKind(message) {
    if (!message)
      return "root/no-message";
    return `${message.author?.role ?? "unknown"}/${message.content?.content_type ?? "unknown"}`;
  }
  function kindOf(node) {
    return messageKind(node.message);
  }
  function makeStats(reason, partial = {}) {
    return {
      changed: reason === "optimized",
      reason,
      originalNodes: 0,
      activePathNodes: 0,
      keptNodes: 0,
      removedOffPathNodes: 0,
      removedHistoricNodes: 0,
      userTurns: 0,
      recentFullTurns: 0,
      removedByKind: {},
      ...partial
    };
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isAlreadyPaginated(payload) {
    if ("__paginatedConversationPage" in payload)
      return true;
    const mapping = payload.mapping;
    return Boolean(mapping && Object.keys(mapping).some((id) => id.startsWith("paginated-root:")));
  }
  function shouldKeepHistoricMessage(message) {
    if (!message)
      return true;
    if (message.metadata?.is_visually_hidden_from_conversation === true) {
      return false;
    }
    const role = message.author?.role;
    if (role === "user" || role && ALWAYS_KEEP_ROLES.has(role))
      return true;
    if (role === "tool")
      return false;
    if (role !== "assistant")
      return true;
    if (message.channel === "final")
      return true;
    if (message.recipient != null && message.recipient !== "all")
      return false;
    const contentType = message.content?.content_type;
    return !contentType || !KNOWN_INTERNAL_CONTENT_TYPES.has(contentType);
  }
  function shouldKeepHistoricNode(node) {
    return shouldKeepHistoricMessage(node.message);
  }
  function traceActivePath(mapping, currentNode) {
    const reversePath = [];
    const seen = new Set;
    let id = currentNode;
    while (id != null) {
      if (seen.has(id))
        return null;
      seen.add(id);
      const node = mapping[id];
      if (!node)
        return null;
      reversePath.push({ id, node });
      id = node.parent;
    }
    reversePath.reverse();
    return reversePath;
  }
  function collapseNodeEntriesToQuestionAnswer(entries, forceKeepNodeIds) {
    const collapsed = [];
    let turn = [];
    const flushTurn = () => {
      if (turn.length === 0)
        return;
      const user = turn.find(({ node }) => node.message?.author?.role === "user");
      if (!user) {
        collapsed.push(...turn);
        turn = [];
        return;
      }
      const assistants = turn.filter(({ node }) => node.message?.author?.role === "assistant" && shouldKeepHistoricMessage(node.message));
      const answer = [...assistants].reverse().find(({ node }) => node.message?.channel === "final") ?? assistants.at(-1);
      if (!answer) {
        const forcedInTurn = turn.filter((entry) => forceKeepNodeIds.has(entry.id));
        if (forcedInTurn.length > 0) {
          const selected = new Set([
            user.id,
            ...forcedInTurn.map((entry) => entry.id)
          ]);
          collapsed.push(...turn.filter((entry) => selected.has(entry.id)));
        } else {
          collapsed.push(...turn);
        }
        turn = [];
        return;
      }
      const selected = new Set([user.id, answer.id]);
      for (const entry of turn) {
        if (forceKeepNodeIds.has(entry.id))
          selected.add(entry.id);
        const role = entry.node.message?.author?.role;
        if (role && ALWAYS_KEEP_ROLES.has(role))
          selected.add(entry.id);
      }
      collapsed.push(...turn.filter((entry) => selected.has(entry.id)));
      turn = [];
    };
    for (const entry of entries) {
      if (entry.node.message?.author?.role === "user")
        flushTurn();
      if (turn.length > 0 || entry.node.message?.author?.role === "user") {
        turn.push(entry);
      } else {
        collapsed.push(entry);
      }
    }
    flushTurn();
    return collapsed;
  }
  function optimizeConversationPayload(payload, options = {}) {
    const resolved = {
      ...DEFAULT_OPTIMIZER_OPTIONS,
      ...options,
      minNodeCount: Math.max(0, Math.floor(options.minNodeCount ?? DEFAULT_OPTIMIZER_OPTIONS.minNodeCount)),
      recentFullTurns: Math.max(0, Math.floor(options.recentFullTurns ?? DEFAULT_OPTIMIZER_OPTIONS.recentFullTurns)),
      preserveCurrentParent: options.preserveCurrentParent ?? DEFAULT_OPTIMIZER_OPTIONS.preserveCurrentParent,
      collapseTurnsToQuestionAnswer: options.collapseTurnsToQuestionAnswer ?? DEFAULT_OPTIMIZER_OPTIONS.collapseTurnsToQuestionAnswer
    };
    if (!isRecord(payload) || !isRecord(payload.mapping)) {
      return { payload, stats: makeStats("invalid-payload") };
    }
    const mapping = payload.mapping;
    const originalNodes = Object.keys(mapping).length;
    if (isAlreadyPaginated(payload)) {
      return {
        payload,
        stats: makeStats("already-paginated", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    if (originalNodes < resolved.minNodeCount) {
      return {
        payload,
        stats: makeStats("below-threshold", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    if (typeof payload.current_node !== "string") {
      return {
        payload,
        stats: makeStats("invalid-payload", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    const activePath = traceActivePath(mapping, payload.current_node);
    if (!activePath || activePath.length === 0) {
      return {
        payload,
        stats: makeStats("invalid-active-path", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    const userTurns = activePath.reduce((count, { node }) => count + (node.message?.author?.role === "user" ? 1 : 0), 0);
    const firstFullTurnIndex = Math.max(0, userTurns - resolved.recentFullTurns);
    const forcedNodeIds = new Set([payload.current_node]);
    if (resolved.preserveCurrentParent) {
      const parentId = mapping[payload.current_node]?.parent;
      if (typeof parentId === "string" && parentId.length > 0) {
        forcedNodeIds.add(parentId);
      }
    }
    let kept = [];
    const removedByKind = {};
    let currentTurnIndex = -1;
    for (const entry of activePath) {
      if (entry.node.message?.author?.role === "user")
        currentTurnIndex += 1;
      const inRecentFullTurn = resolved.recentFullTurns > 0 && currentTurnIndex >= firstFullTurnIndex;
      const keep = inRecentFullTurn || shouldKeepHistoricNode(entry.node);
      if (keep || forcedNodeIds.has(entry.id)) {
        kept.push(entry);
      } else {
        const kind = kindOf(entry.node);
        removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
      }
    }
    if (resolved.collapseTurnsToQuestionAnswer) {
      const collapsed = collapseNodeEntriesToQuestionAnswer(kept, forcedNodeIds);
      if (collapsed.length < kept.length) {
        const retainedIds = new Set(collapsed.map((entry) => entry.id));
        for (const entry of kept) {
          if (retainedIds.has(entry.id))
            continue;
          const kind = kindOf(entry.node);
          removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
        }
        kept = collapsed;
      }
    }
    const removedOffPathNodes = originalNodes - activePath.length;
    const removedHistoricNodes = activePath.length - kept.length;
    if (removedOffPathNodes <= 0 && removedHistoricNodes <= 0) {
      return {
        payload,
        stats: makeStats("no-reduction", {
          originalNodes,
          activePathNodes: activePath.length,
          keptNodes: originalNodes,
          userTurns,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    const compactMapping = {};
    for (let index = 0;index < kept.length; index += 1) {
      const { id, node } = kept[index];
      const previousId = kept[index - 1]?.id ?? null;
      const nextId = kept[index + 1]?.id;
      compactMapping[id] = {
        ...node,
        id: node.id ?? id,
        parent: previousId,
        children: nextId ? [nextId] : []
      };
    }
    const keptMessageIds = new Set(kept.map(({ node }) => node.message?.id).filter((id) => typeof id === "string"));
    const moderationResults = Array.isArray(payload.moderation_results) ? payload.moderation_results.filter((result) => typeof result.message_id !== "string" || keptMessageIds.has(result.message_id)) : payload.moderation_results;
    const optimizedPayload = {
      ...payload,
      mapping: compactMapping,
      current_node: kept.at(-1)?.id ?? payload.current_node,
      ...moderationResults === undefined ? {} : { moderation_results: moderationResults }
    };
    return {
      payload: optimizedPayload,
      stats: makeStats("optimized", {
        originalNodes,
        activePathNodes: activePath.length,
        keptNodes: kept.length,
        removedOffPathNodes,
        removedHistoricNodes,
        userTurns,
        recentFullTurns: resolved.recentFullTurns,
        removedByKind
      })
    };
  }
  function collapseToQuestionAnswerPairs(messages, forceKeepMessageIds = new Set) {
    if (!messages.some((message) => message.author?.role === "user"))
      return messages;
    const collapsed = [];
    let turn = [];
    const flushTurn = () => {
      if (turn.length === 0)
        return;
      const user = turn.find((message) => message.author?.role === "user");
      const assistantCandidates = turn.filter((message) => message.author?.role === "assistant" && shouldKeepHistoricMessage(message));
      const answer = [...assistantCandidates].reverse().find((message) => message.channel === "final") ?? assistantCandidates.at(-1);
      if (!user || !answer) {
        collapsed.push(...turn);
        turn = [];
        return;
      }
      const selected = new Set([user, answer]);
      for (const message of turn) {
        if (typeof message.id === "string" && forceKeepMessageIds.has(message.id)) {
          selected.add(message);
        }
      }
      collapsed.push(...turn.filter((message) => selected.has(message)));
      turn = [];
    };
    for (const message of messages) {
      if (message.author?.role === "user")
        flushTurn();
      if (turn.length > 0 || message.author?.role === "user")
        turn.push(message);
    }
    flushTurn();
    return collapsed.length > 0 ? collapsed : messages;
  }
  function optimizePaginatedConversationPayload(payload, options = {}) {
    const messages = Array.isArray(payload.messages) ? payload.messages : null;
    if (!messages) {
      return {
        payload,
        stats: {
          changed: false,
          originalMessages: 0,
          keptMessages: 0,
          removedMessages: 0,
          originalBytes: 0,
          keptBytes: 0,
          userTurns: 0,
          recentFullTurns: 0,
          removedByKind: {}
        }
      };
    }
    const recentFullTurns = Math.max(0, Math.floor(options.recentFullTurns ?? 0));
    const forcedIds = new Set(options.forceKeepMessageIds ?? []);
    const userTurns = messages.reduce((count, message) => count + (message.author?.role === "user" ? 1 : 0), 0);
    const preserveEverything = recentFullTurns > 0 && userTurns === 0;
    const firstFullTurnIndex = Math.max(0, userTurns - recentFullTurns);
    let kept = [];
    const removedByKind = {};
    let currentTurnIndex = -1;
    for (const message of messages) {
      if (message.author?.role === "user")
        currentTurnIndex += 1;
      const id = message.id;
      const inRecentFullTurn = recentFullTurns > 0 && currentTurnIndex >= firstFullTurnIndex;
      const keep = preserveEverything || typeof id === "string" && forcedIds.has(id) || inRecentFullTurn || shouldKeepHistoricMessage(message);
      if (keep) {
        kept.push(message);
      } else {
        const kind = messageKind(message);
        removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
      }
    }
    if (options.collapseTurnsToQuestionAnswer === true && recentFullTurns === 0 && userTurns > 0) {
      const collapsed = collapseToQuestionAnswerPairs(kept, forcedIds);
      if (collapsed.length < kept.length) {
        const retained = new Set(collapsed);
        for (const message of kept) {
          if (retained.has(message))
            continue;
          const kind = messageKind(message);
          removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
        }
        kept = collapsed;
      }
    }
    if (messages.length > 0 && kept.length === 0) {
      const fallback = messages.at(-1);
      kept.push(fallback);
      const kind = messageKind(fallback);
      if (removedByKind[kind] != null) {
        removedByKind[kind] -= 1;
        if (removedByKind[kind] <= 0)
          delete removedByKind[kind];
      }
    }
    const keptIds = new Set(kept.map((message) => message.id).filter((id) => typeof id === "string"));
    const moderationResults = Array.isArray(payload.moderation_results) ? payload.moderation_results.filter((result) => typeof result.message_id !== "string" || keptIds.has(result.message_id)) : payload.moderation_results;
    const originalBytes = messages.reduce((sum, message) => sum + serializedBytes(message), 0);
    const keptBytes = kept.reduce((sum, message) => sum + serializedBytes(message), 0);
    const changed = kept.length !== messages.length;
    return {
      payload: changed ? {
        ...payload,
        messages: kept,
        ...moderationResults === undefined ? {} : { moderation_results: moderationResults }
      } : payload,
      stats: {
        changed,
        originalMessages: messages.length,
        keptMessages: kept.length,
        removedMessages: messages.length - kept.length,
        originalBytes,
        keptBytes,
        userTurns,
        recentFullTurns,
        removedByKind
      }
    };
  }
  function convertNativeInitialToLazyConversation(payload, conversationId, numTurns) {
    const messages = Array.isArray(payload.messages) ? payload.messages : null;
    if (!messages || messages.length === 0)
      return null;
    const ids = new Set;
    for (const message of messages) {
      if (typeof message.id !== "string" || message.id.length === 0 || ids.has(message.id)) {
        return null;
      }
      ids.add(message.id);
    }
    const rootId = `paginated-root:${conversationId}`;
    if (ids.has(rootId))
      return null;
    const mapping = {
      [rootId]: {
        id: rootId,
        parent: "",
        children: messages[0]?.id ? [messages[0].id] : []
      }
    };
    for (let index = 0;index < messages.length; index += 1) {
      const message = messages[index];
      const id = message.id;
      const previousId = messages[index - 1]?.id ?? rootId;
      const nextId = messages[index + 1]?.id;
      mapping[id] = {
        id,
        message,
        parent: previousId,
        children: nextId ? [nextId] : []
      };
    }
    const messagesLeafToRoot = [...messages].reverse();
    const moderationResults = Array.isArray(payload.moderation_results) ? payload.moderation_results : [];
    const safeUrls = Array.isArray(payload.safe_urls) ? payload.safe_urls : [];
    const blockedUrls = Array.isArray(payload.blocked_urls) ? payload.blocked_urls : [];
    const cursor = payload.page_info?.has_previous_page === true && typeof payload.page_info.start_cursor === "string" && payload.page_info.start_cursor.length > 0 ? payload.page_info.start_cursor : null;
    const serverCurrentLeafId = typeof payload.current_node === "string" ? payload.current_node : null;
    const newestMessageId = messagesLeafToRoot[0]?.id ?? rootId;
    const currentNode = serverCurrentLeafId != null && Object.hasOwn(mapping, serverCurrentLeafId) ? serverCurrentLeafId : newestMessageId;
    const {
      messages: _messages,
      page_info: _pageInfo,
      moderation_results: _moderationResults,
      ...metadata
    } = payload;
    return {
      ...metadata,
      current_node: currentNode,
      mapping,
      moderation_results: moderationResults,
      __paginatedConversationPage: {
        blockedUrls,
        cursor,
        messagesLeafToRoot,
        moderationResults,
        numTurns: Math.max(1, Math.floor(numTurns)),
        oldestMessageId: messagesLeafToRoot.at(-1)?.id ?? null,
        safeUrls,
        serverCurrentLeafId
      }
    };
  }
  function splitPaginatedMessagesNewestFirst(messages, options = {}) {
    if (messages.length === 0)
      return [];
    const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? 1));
    const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? 16));
    const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? 128 * 1024));
    const allowSplitTurns = options.allowSplitTurns ?? true;
    const turns = [];
    let currentTurn = [];
    for (const message of messages) {
      if (message.author?.role === "user" && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(message);
    }
    if (currentTurn.length > 0)
      turns.push(currentTurn);
    const atomicSegments = [];
    for (const turn of turns) {
      const turnBytes = turn.reduce((sum, message) => sum + serializedBytes(message), 0);
      if (!allowSplitTurns || turn.length <= maxMessages && turnBytes <= maxBytes) {
        atomicSegments.push({ messages: turn, startsTurn: true, bytes: turnBytes });
        continue;
      }
      const splitNewestFirst = [];
      let segment = [];
      let segmentBytes = 0;
      for (let index = turn.length - 1;index >= 0; index -= 1) {
        const message = turn[index];
        const bytes = serializedBytes(message);
        if (segment.length > 0 && (segment.length + 1 > maxMessages || segmentBytes + bytes > maxBytes)) {
          splitNewestFirst.push({ messages: segment, bytes: segmentBytes });
          segment = [];
          segmentBytes = 0;
        }
        segment.unshift(message);
        segmentBytes += bytes;
      }
      if (segment.length > 0) {
        splitNewestFirst.push({ messages: segment, bytes: segmentBytes });
      }
      const chronologicalSegments = splitNewestFirst.reverse();
      for (let index = 0;index < chronologicalSegments.length; index += 1) {
        const item = chronologicalSegments[index];
        atomicSegments.push({
          ...item,
          startsTurn: index === 0
        });
      }
    }
    const chunksNewestFirst = [];
    let chunk = [];
    let chunkBytes = 0;
    let chunkTurns = 0;
    for (let index = atomicSegments.length - 1;index >= 0; index -= 1) {
      const segment = atomicSegments[index];
      const nextTurns = chunkTurns + (segment.startsTurn ? 1 : 0);
      const exceeds = chunk.length > 0 && (nextTurns > maxTurns || chunk.length + segment.messages.length > maxMessages || chunkBytes + segment.bytes > maxBytes);
      if (exceeds) {
        chunksNewestFirst.push(chunk);
        chunk = [];
        chunkBytes = 0;
        chunkTurns = 0;
      }
      chunk = [...segment.messages, ...chunk];
      chunkBytes += segment.bytes;
      chunkTurns += segment.startsTurn ? 1 : 0;
    }
    if (chunk.length > 0)
      chunksNewestFirst.push(chunk);
    return chunksNewestFirst;
  }
  function matchConversationApiUrl(rawUrl, baseUrl) {
    try {
      const pathname = new URL(rawUrl, baseUrl).pathname;
      const legacy = pathname.match(/^\/backend-api\/conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
      if (legacy) {
        return { kind: "legacy-full", conversationId: legacy[1] };
      }
      const paginated = pathname.match(/^\/backend-api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/messages)?\/?$/i);
      if (!paginated)
        return null;
      return {
        kind: paginated[2] ? "paginated-messages" : "paginated-initial",
        conversationId: paginated[1]
      };
    } catch {
      return null;
    }
  }
  function clampPaginatedNumTurns(rawUrl, baseUrl, maxTurns) {
    const url = new URL(rawUrl, baseUrl);
    const match = matchConversationApiUrl(url.href, baseUrl);
    if (!match || match.kind === "legacy-full")
      return url.href;
    const limit = Math.max(1, Math.floor(maxTurns));
    const requested = Number(url.searchParams.get("num_turns"));
    if (!Number.isFinite(requested) || requested <= 0 || requested > limit) {
      url.searchParams.set("num_turns", String(limit));
    }
    return url.href;
  }

  // src/sidebar-mutations.ts
  function sidebarMayHaveChanged(records) {
    for (const record of records) {
      const target = record.target;
      if (target.nodeType === 1 && target.closest("nav,aside"))
        return true;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1)
          continue;
        const element = node;
        if (element.matches("nav,aside") || element.querySelector("nav,aside"))
          return true;
      }
    }
    return false;
  }

  // src/cache-budget.ts
  class CacheBudget {
    limit;
    entries = new Map;
    total = 0;
    constructor(limit) {
      this.limit = limit;
    }
    delete(key) {
      const entry = this.entries.get(key);
      if (!entry)
        return;
      this.total -= entry.bytes;
      this.entries.delete(key);
    }
    touch(key) {
      const entry = this.entries.get(key);
      if (!entry)
        return;
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    set(key, bytes, evict) {
      this.delete(key);
      this.entries.set(key, { bytes, evict });
      this.total += bytes;
      while (this.total > this.limit && this.entries.size) {
        const oldest = this.entries.keys().next().value;
        const entry = this.entries.get(oldest);
        this.delete(oldest);
        entry.evict();
      }
    }
  }

  // src/chatgpt-performance-fix.user.ts
  var SCRIPT_NAME = "ChatGPT Long Conversation Performance Fix";
  var SETTINGS_KEY = "chatgpt-performance-fix:settings:v1";
  var FULL_ONCE_PREFIX = "chatgpt-performance-fix:full-once:";
  var CACHE_TTL_MS = 20000;
  var HISTORY_CACHE_TTL_MS = 5 * 60000;
  var SIDEBAR_RATE_LIMIT_BACKOFF_MS = 2 * 60000;
  var INITIAL_RATE_LIMIT_BACKOFF_MS = 2 * 60000;
  var MAX_INITIAL_CONVERSATION_SNAPSHOTS = 32;
  var RESPONSE_CACHE_BUDGET_BYTES = 16 * 1024 * 1024;
  var MAX_CONFIGURED_TURNS = 500;
  var ALL_INITIAL_FIRST_PAGE_TURNS = 32;
  var INTERNAL_RESPONSE_READS = new WeakSet;
  function retryAfterBackoffMs(headers, minimumMs, now = Date.now()) {
    const raw = headers.get("retry-after")?.trim();
    if (raw) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(minimumMs, seconds * 1000);
      }
      const retryAt = Date.parse(raw);
      if (Number.isFinite(retryAt)) {
        return Math.max(minimumMs, retryAt - now);
      }
    }
    return minimumMs;
  }
  var DEFAULT_SETTINGS = {
    mode: "balanced",
    initialTurns: 2,
    historyBatchTurns: 2,
    showMessageMetadata: true
  };
  var MODE_OPTIONS = {
    balanced: {
      minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
      recentFullTurns: 1,
      lazyInitialTurns: 2,
      paginatedMaxTurns: 2,
      paginatedRenderTurns: 1,
      richTextWarmDistancePx: 8000,
      codeEditorWarmDistancePx: 3000
    },
    aggressive: {
      minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
      recentFullTurns: 0,
      lazyInitialTurns: 2,
      paginatedMaxTurns: 2,
      paginatedRenderTurns: 1,
      richTextWarmDistancePx: 5000,
      codeEditorWarmDistancePx: 1800
    }
  };
  function legacyOptimizerOptions(mode) {
    return {
      minNodeCount: MODE_OPTIONS[mode].minNodeCount,
      recentFullTurns: 0,
      preserveCurrentParent: true,
      collapseTurnsToQuestionAnswer: true
    };
  }
  function readSettings(storage) {
    try {
      const value = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null");
      const mode = value?.mode === "off" || value?.mode === "aggressive" ? value.mode : "balanced";
      return {
        mode,
        initialTurns: normalizeTurnLoadSetting(value?.initialTurns, DEFAULT_SETTINGS.initialTurns),
        historyBatchTurns: normalizeTurnLoadSetting(value?.historyBatchTurns, DEFAULT_SETTINGS.historyBatchTurns),
        showMessageMetadata: value?.showMessageMetadata !== false
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function conversationStatusUpdateId(rawUrl, method, baseUrl) {
    if (method !== "POST")
      return null;
    try {
      const pathname = new URL(rawUrl, baseUrl).pathname.replace(/\/+$/, "");
      const match = pathname.match(/^\/backend-api\/conversation\/([0-9a-f-]{36})\/async-status$/i);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
  function parseAsyncStatusBody(body) {
    if (typeof body !== "string")
      return { found: false, value: undefined };
    const parseJson = () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "status")) {
          return { found: false, value: undefined };
        }
        return {
          found: true,
          value: parsed.status
        };
      } catch {
        return { found: false, value: undefined };
      }
    };
    if (body.trimStart().startsWith("{")) {
      const json = parseJson();
      if (json.found)
        return json;
    }
    try {
      const params = new URLSearchParams(body);
      if (params.has("status")) {
        const raw = params.get("status");
        if (raw == null || raw === "null")
          return { found: true, value: null };
        const numeric = Number(raw);
        return {
          found: true,
          value: Number.isFinite(numeric) ? numeric : raw
        };
      }
    } catch {}
    return parseJson();
  }
  async function inspectAsyncStatusRequest(input, init) {
    const direct = parseAsyncStatusBody(init?.body);
    if (direct.found)
      return direct;
    const requestLike = input;
    if (typeof requestLike.clone !== "function")
      return direct;
    try {
      return parseAsyncStatusBody(await requestLike.clone().text());
    } catch {
      return direct;
    }
  }
  async function inspectOutgoingRequest(input, init) {
    const direct = inspectOutgoingBody(init?.body);
    if (direct.hasUserMessage || direct.conversationId || direct.messageId || direct.text) {
      return direct;
    }
    const requestLike = input;
    if (typeof requestLike.clone !== "function")
      return direct;
    try {
      const text = await requestLike.clone().text();
      return inspectOutgoingBody(text);
    } catch {
      return direct;
    }
  }
  function normalizeTurnLoadSetting(value, fallback) {
    if (value === "all")
      return "all";
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0)
      return fallback;
    return Math.min(MAX_CONFIGURED_TURNS, Math.max(1, Math.floor(numeric)));
  }
  function formatTurnLoadSetting(value) {
    return value === "all" ? "全部" : `${value} 轮`;
  }
  var activeTurnLoadDialog = null;
  function showTurnLoadSettingDialog(pageWindow, label, current) {
    if (activeTurnLoadDialog)
      return activeTurnLoadDialog;
    activeTurnLoadDialog = new Promise((resolve) => {
      const existing = pageWindow.document.getElementById("chatgpt-turn-load-setting-dialog");
      existing?.remove();
      const host = pageWindow.document.createElement("div");
      host.id = "chatgpt-turn-load-setting-dialog";
      host.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "background:rgba(0,0,0,.38)",
        "padding:20px"
      ].join(";");
      const panel = pageWindow.document.createElement("div");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.style.cssText = [
        "width:min(420px,100%)",
        "border:1px solid var(--border-light,rgba(127,127,127,.28))",
        "border-radius:14px",
        "background:var(--main-surface-primary,#fff)",
        "color:var(--text-primary,#111)",
        "box-shadow:0 18px 60px rgba(0,0,0,.28)",
        "padding:18px",
        "font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
      ].join(";");
      const title = pageWindow.document.createElement("div");
      title.textContent = label;
      title.style.cssText = "font-size:15px;font-weight:650;margin-bottom:10px";
      const hint = pageWindow.document.createElement("div");
      hint.textContent = "输入大于 0 的整数，或输入 all / 全部。";
      hint.style.cssText = "opacity:.72;margin-bottom:10px";
      const input = pageWindow.document.createElement("input");
      input.type = "text";
      input.value = current === "all" ? "all" : String(current);
      input.autocomplete = "off";
      input.style.cssText = [
        "box-sizing:border-box",
        "width:100%",
        "border:1px solid var(--border-light,rgba(127,127,127,.35))",
        "border-radius:9px",
        "padding:9px 10px",
        "background:var(--main-surface-secondary,rgba(127,127,127,.08))",
        "color:inherit",
        "outline:none"
      ].join(";");
      const error = pageWindow.document.createElement("div");
      error.style.cssText = "min-height:20px;margin-top:6px;font-size:12px;color:#c33";
      const actions = pageWindow.document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px";
      const cancel = pageWindow.document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      const save = pageWindow.document.createElement("button");
      save.type = "button";
      save.textContent = "保存";
      for (const button of [cancel, save]) {
        button.style.cssText = [
          "border:1px solid var(--border-light,rgba(127,127,127,.35))",
          "border-radius:8px",
          "padding:6px 12px",
          "background:var(--main-surface-secondary,rgba(127,127,127,.08))",
          "color:inherit",
          "cursor:pointer"
        ].join(";");
      }
      actions.append(cancel, save);
      panel.append(title, hint, input, error, actions);
      host.append(panel);
      pageWindow.document.documentElement.append(host);
      let closed = false;
      const finish = (value) => {
        if (closed)
          return;
        closed = true;
        pageWindow.removeEventListener("keydown", onKeyDown, true);
        host.remove();
        activeTurnLoadDialog = null;
        resolve(value);
      };
      const parse = () => {
        const trimmed = input.value.trim().toLowerCase();
        if (trimmed === "all" || trimmed === "全部")
          return "all";
        const numeric = Number(trimmed);
        if (!Number.isFinite(numeric) || numeric <= 0)
          return null;
        return normalizeTurnLoadSetting(numeric, current);
      };
      const submit = () => {
        const value = parse();
        if (value == null) {
          error.textContent = "请输入大于 0 的整数，或 all / 全部。";
          input.focus();
          input.select();
          return;
        }
        finish(value);
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        } else if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      };
      cancel.addEventListener("click", () => finish(null));
      save.addEventListener("click", submit);
      host.addEventListener("mousedown", (event) => {
        if (event.target === host)
          finish(null);
      });
      pageWindow.addEventListener("keydown", onKeyDown, true);
      pageWindow.setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    });
    return activeTurnLoadDialog;
  }
  function yieldUntilInteractionIdle(pageWindow) {
    const startedAt = pageWindow.performance.now();
    let settled = false;
    let fallbackTimer;
    const finish = (forced = false, resolve) => {
      if (settled)
        return;
      settled = true;
      if (fallbackTimer != null)
        pageWindow.clearTimeout(fallbackTimer);
      if (forced) {
        const root = pageWindow.document.documentElement;
        root.dataset.chatgptHistoryIdleForced = String(Number(root.dataset.chatgptHistoryIdleForced ?? "0") + 1);
      }
      try {
        pageWindow.performance.measure("chatgpt-perf:history-idle-wait", {
          start: startedAt,
          end: pageWindow.performance.now()
        });
      } catch {}
      resolve?.();
    };
    return new Promise((resolve) => {
      fallbackTimer = pageWindow.setTimeout(() => finish(true, resolve), 250);
      const afterPaint = () => {
        pageWindow.setTimeout(() => {
          if (settled)
            return;
          if (typeof pageWindow.requestIdleCallback !== "function") {
            finish(false, resolve);
            return;
          }
          const waitForUsefulIdleBudget = () => {
            if (settled)
              return;
            pageWindow.requestIdleCallback((deadline) => {
              if (settled)
                return;
              if (deadline.timeRemaining() >= 12) {
                finish(false, resolve);
                return;
              }
              waitForUsefulIdleBudget();
            }, { timeout: 50 });
          };
          waitForUsefulIdleBudget();
        }, 0);
      };
      if (pageWindow.document.visibilityState === "hidden" || typeof pageWindow.requestAnimationFrame !== "function") {
        afterPaint();
      } else {
        pageWindow.requestAnimationFrame(afterPaint);
      }
    });
  }
  var jsonWorkerState;
  function ensureJsonWorker(pageWindow) {
    if (jsonWorkerState !== undefined)
      return jsonWorkerState;
    if (typeof pageWindow.Worker !== "function") {
      jsonWorkerState = null;
      return null;
    }
    try {
      const source = '(()=>{var _={minNodeCount:250,recentFullTurns:1,preserveCurrentParent:!1,collapseTurnsToQuestionAnswer:!1},F=new Set(["system","developer"]),L=new Set(["code","execution_output","thoughts"]);function w(e){return new TextEncoder().encode(JSON.stringify(e)).byteLength}function x(e){if(!e)return"root/no-message";return`${e.author?.role??"unknown"}/${e.content?.content_type??"unknown"}`}function S(e){return x(e.message)}function b(e,n={}){return{changed:e==="optimized",reason:e,originalNodes:0,activePathNodes:0,keptNodes:0,removedOffPathNodes:0,removedHistoricNodes:0,userTurns:0,recentFullTurns:0,removedByKind:{},...n}}function O(e){return typeof e==="object"&&e!==null&&!Array.isArray(e)}function j(e){if("__paginatedConversationPage"in e)return!0;let n=e.mapping;return Boolean(n&&Object.keys(n).some((s)=>s.startsWith("paginated-root:")))}function A(e){if(!e)return!0;if(e.metadata?.is_visually_hidden_from_conversation===!0)return!1;let n=e.author?.role;if(n==="user"||n&&F.has(n))return!0;if(n==="tool")return!1;if(n!=="assistant")return!0;if(e.channel==="final")return!0;if(e.recipient!=null&&e.recipient!=="all")return!1;let s=e.content?.content_type;return!s||!L.has(s)}function Q(e){return A(e.message)}function J(e,n){let s=[],t=new Set,o=n;while(o!=null){if(t.has(o))return null;t.add(o);let a=e[o];if(!a)return null;s.push({id:o,node:a}),o=a.parent}return s.reverse(),s}function U(e,n){let s=[],t=[],o=()=>{if(t.length===0)return;let a=t.find(({node:r})=>r.message?.author?.role==="user");if(!a){s.push(...t),t=[];return}let f=t.filter(({node:r})=>r.message?.author?.role==="assistant"&&A(r.message)),g=[...f].reverse().find(({node:r})=>r.message?.channel==="final")??f.at(-1);if(!g){let r=t.filter((d)=>n.has(d.id));if(r.length>0){let d=new Set([a.id,...r.map((y)=>y.id)]);s.push(...t.filter((y)=>d.has(y.id)))}else s.push(...t);t=[];return}let i=new Set([a.id,g.id]);for(let r of t){if(n.has(r.id))i.add(r.id);let d=r.node.message?.author?.role;if(d&&F.has(d))i.add(r.id)}s.push(...t.filter((r)=>i.has(r.id))),t=[]};for(let a of e){if(a.node.message?.author?.role==="user")o();if(t.length>0||a.node.message?.author?.role==="user")t.push(a);else s.push(a)}return o(),s}function R(e,n={}){let s={..._,...n,minNodeCount:Math.max(0,Math.floor(n.minNodeCount??_.minNodeCount)),recentFullTurns:Math.max(0,Math.floor(n.recentFullTurns??_.recentFullTurns)),preserveCurrentParent:n.preserveCurrentParent??_.preserveCurrentParent,collapseTurnsToQuestionAnswer:n.collapseTurnsToQuestionAnswer??_.collapseTurnsToQuestionAnswer};if(!O(e)||!O(e.mapping))return{payload:e,stats:b("invalid-payload")};let t=e.mapping,o=Object.keys(t).length;if(j(e))return{payload:e,stats:b("already-paginated",{originalNodes:o,keptNodes:o,recentFullTurns:s.recentFullTurns})};if(o<s.minNodeCount)return{payload:e,stats:b("below-threshold",{originalNodes:o,keptNodes:o,recentFullTurns:s.recentFullTurns})};if(typeof e.current_node!=="string")return{payload:e,stats:b("invalid-payload",{originalNodes:o,keptNodes:o,recentFullTurns:s.recentFullTurns})};let a=J(t,e.current_node);if(!a||a.length===0)return{payload:e,stats:b("invalid-active-path",{originalNodes:o,keptNodes:o,recentFullTurns:s.recentFullTurns})};let f=a.reduce((l,{node:h})=>l+(h.message?.author?.role==="user"?1:0),0),g=Math.max(0,f-s.recentFullTurns),i=new Set([e.current_node]);if(s.preserveCurrentParent){let l=t[e.current_node]?.parent;if(typeof l==="string"&&l.length>0)i.add(l)}let r=[],d={},y=-1;for(let l of a){if(l.node.message?.author?.role==="user")y+=1;if(s.recentFullTurns>0&&y>=g||Q(l.node)||i.has(l.id))r.push(l);else{let P=S(l.node);d[P]=(d[P]??0)+1}}if(s.collapseTurnsToQuestionAnswer){let l=U(r,i);if(l.length<r.length){let h=new Set(l.map((m)=>m.id));for(let m of r){if(h.has(m.id))continue;let P=S(m.node);d[P]=(d[P]??0)+1}r=l}}let k=o-a.length,c=a.length-r.length;if(k<=0&&c<=0)return{payload:e,stats:b("no-reduction",{originalNodes:o,activePathNodes:a.length,keptNodes:o,userTurns:f,recentFullTurns:s.recentFullTurns})};let v={};for(let l=0;l<r.length;l+=1){let{id:h,node:m}=r[l],P=r[l-1]?.id??null,N=r[l+1]?.id;v[h]={...m,id:m.id??h,parent:P,children:N?[N]:[]}}let C=new Set(r.map(({node:l})=>l.message?.id).filter((l)=>typeof l==="string")),u=Array.isArray(e.moderation_results)?e.moderation_results.filter((l)=>typeof l.message_id!=="string"||C.has(l.message_id)):e.moderation_results;return{payload:{...e,mapping:v,current_node:r.at(-1)?.id??e.current_node,...u===void 0?{}:{moderation_results:u}},stats:b("optimized",{originalNodes:o,activePathNodes:a.length,keptNodes:r.length,removedOffPathNodes:k,removedHistoricNodes:c,userTurns:f,recentFullTurns:s.recentFullTurns,removedByKind:d})}}function W(e,n=new Set){if(!e.some((a)=>a.author?.role==="user"))return e;let s=[],t=[],o=()=>{if(t.length===0)return;let a=t.find((r)=>r.author?.role==="user"),f=t.filter((r)=>r.author?.role==="assistant"&&A(r)),g=[...f].reverse().find((r)=>r.channel==="final")??f.at(-1);if(!a||!g){s.push(...t),t=[];return}let i=new Set([a,g]);for(let r of t)if(typeof r.id==="string"&&n.has(r.id))i.add(r);s.push(...t.filter((r)=>i.has(r))),t=[]};for(let a of e){if(a.author?.role==="user")o();if(t.length>0||a.author?.role==="user")t.push(a)}return o(),s.length>0?s:e}function I(e,n={}){let s=Array.isArray(e.messages)?e.messages:null;if(!s)return{payload:e,stats:{changed:!1,originalMessages:0,keptMessages:0,removedMessages:0,originalBytes:0,keptBytes:0,userTurns:0,recentFullTurns:0,removedByKind:{}}};let t=Math.max(0,Math.floor(n.recentFullTurns??0)),o=new Set(n.forceKeepMessageIds??[]),a=s.reduce((u,p)=>u+(p.author?.role==="user"?1:0),0),f=t>0&&a===0,g=Math.max(0,a-t),i=[],r={},d=-1;for(let u of s){if(u.author?.role==="user")d+=1;let p=u.id,l=t>0&&d>=g;if(f||typeof p==="string"&&o.has(p)||l||A(u))i.push(u);else{let m=x(u);r[m]=(r[m]??0)+1}}if(n.collapseTurnsToQuestionAnswer===!0&&t===0&&a>0){let u=W(i,o);if(u.length<i.length){let p=new Set(u);for(let l of i){if(p.has(l))continue;let h=x(l);r[h]=(r[h]??0)+1}i=u}}if(s.length>0&&i.length===0){let u=s.at(-1);i.push(u);let p=x(u);if(r[p]!=null){if(r[p]-=1,r[p]<=0)delete r[p]}}let y=new Set(i.map((u)=>u.id).filter((u)=>typeof u==="string")),k=Array.isArray(e.moderation_results)?e.moderation_results.filter((u)=>typeof u.message_id!=="string"||y.has(u.message_id)):e.moderation_results,c=s.reduce((u,p)=>u+w(p),0),v=i.reduce((u,p)=>u+w(p),0),C=i.length!==s.length;return{payload:C?{...e,messages:i,...k===void 0?{}:{moderation_results:k}}:e,stats:{changed:C,originalMessages:s.length,keptMessages:i.length,removedMessages:s.length-i.length,originalBytes:c,keptBytes:v,userTurns:a,recentFullTurns:t,removedByKind:r}}}function B(e,n={}){if(e.length===0)return[];let s=Math.max(1,Math.floor(n.maxTurns??1)),t=Math.max(1,Math.floor(n.maxMessages??16)),o=Math.max(1024,Math.floor(n.maxBytes??131072)),a=n.allowSplitTurns??!0,f=[],g=[];for(let c of e){if(c.author?.role==="user"&&g.length>0)f.push(g),g=[];g.push(c)}if(g.length>0)f.push(g);let i=[];for(let c of f){let v=c.reduce((h,m)=>h+w(m),0);if(!a||c.length<=t&&v<=o){i.push({messages:c,startsTurn:!0,bytes:v});continue}let C=[],u=[],p=0;for(let h=c.length-1;h>=0;h-=1){let m=c[h],P=w(m);if(u.length>0&&(u.length+1>t||p+P>o))C.push({messages:u,bytes:p}),u=[],p=0;u.unshift(m),p+=P}if(u.length>0)C.push({messages:u,bytes:p});let l=C.reverse();for(let h=0;h<l.length;h+=1){let m=l[h];i.push({...m,startsTurn:h===0})}}let r=[],d=[],y=0,k=0;for(let c=i.length-1;c>=0;c-=1){let v=i[c],C=k+(v.startsTurn?1:0);if(d.length>0&&(C>s||d.length+v.messages.length>t||y+v.bytes>o))r.push(d),d=[],y=0,k=0;d=[...v.messages,...d],y+=v.bytes,k+=v.startsTurn?1:0}if(d.length>0)r.push(d);return r}function T(e){if(e.buffer instanceof ArrayBuffer)return JSON.parse(new TextDecoder().decode(e.buffer));if(typeof e.text!=="string")throw Error("Worker request is missing JSON text/buffer");return JSON.parse(e.text)}function q(e){return e==="finished_successfully"||e==="finished"||e==="complete"}function H(e){if(typeof e.current_node!=="string"||!Array.isArray(e.messages))return;return e.messages.find((n)=>n.id===e.current_node)}function K(e){if(e.async_status!=null||!Array.isArray(e.messages))return!0;if(e.messages.some((s)=>["in_progress","streaming","pending"].includes(String(s.status))))return!0;let n=H(e);return!n||!q(n.status)}function D(e){return!K(e)}function Y(e){if(!Array.isArray(e.messages)||typeof e.current_node!=="string")return[];let n=new Map(e.messages.filter((o)=>typeof o.id==="string").map((o)=>[o.id,o])),s=new Set([e.current_node]),t=n.get(e.current_node);if(t?.author?.role==="tool"){let o=t.metadata?.parent_id;if(typeof o==="string"&&n.has(o))s.add(o)}return[...s]}var M=new Map,Z=1;function G(e){if(e.author?.role!=="assistant")return!1;if(e.metadata?.is_visually_hidden_from_conversation===!0)return!1;if(e.recipient!=null&&e.recipient!=="all")return!1;if(e.channel==="final")return!0;return!["code","execution_output","thoughts","reasoning_recap"].includes(String(e.content?.content_type??""))}function V(e,n){let s=-1;for(let t=0;t<e.length;t+=1)if(e[t]?.author?.role==="user")s=t;if(s<0)return!1;return e.slice(s+1).some((t)=>G(t)&&(!n||t.channel==="final"))}function X(e,n){let s=new Set,t=[];for(let o of[...e,...n]){if(typeof o.id==="string"){if(s.has(o.id))continue;s.add(o.id)}t.push(o)}return t}function ee(e,n){return{...e,messages:X(Array.isArray(n.messages)?n.messages:[],Array.isArray(e.messages)?e.messages:[]),page_info:n.page_info,safe_urls:[...new Set([...n.safe_urls??[],...e.safe_urls??[]])],blocked_urls:[...new Set([...n.blocked_urls??[],...e.blocked_urls??[]])]}}function z(e,n){let s=Array.isArray(n.payload.messages)?n.payload.messages:[],t=n.payload.page_info?.has_previous_page===!0&&typeof n.payload.page_info.start_cursor==="string"?n.payload.page_info.start_cursor:null;return{token:e,complete:V(s,n.requireFinal),cursor:t,messageCount:s.length}}var ne=Math.random().toString(36).slice(2),te=1;function se(e,n){let s=e.split(`\n`),t=[];for(let i=0;i<s.length;i+=1){let r=s[i].match(/^\\s*(`{3,}|~{3,})\\s*([^`]*)$/);if(!r)continue;let d=r[1],y=d[0],k=new RegExp(`^\\\\s*${y}{${d.length},}\\\\s*$`),c=i+1;while(c<s.length&&!k.test(s[c]))c+=1;if(c>=s.length)continue;let v=r[2].trim().split(/\\s+/,1)[0]??"",C=s.slice(i+1,c).join(`\n`);t.push({start:i,end:c,language:v,code:C}),i=c}let o=t.reduce((i,r)=>i+r.code.length,0);if(t.length<4&&o<8000)return{text:e,blocks:[]};let a=new Map(t.map((i)=>[i.start,i])),f=[],g=[];for(let i=0;i<s.length;i+=1){let r=a.get(i);if(!r){f.push(s[i]);continue}let d=`${ne}-${n}-${te++}`,y=Math.max(1,r.code.split(`\n`).length);g.push({token:d,language:r.language,code:r.code,lineCount:y}),f.push(`[代码块](https://chatgpt.com/#cgptperf-code=${d}&lines=${y})`),i=r.end}return{text:f.join(`\n`),blocks:g}}function re(e){if(!Array.isArray(e.messages))return{payload:e,codeBlocks:[]};let n=[],s=e.messages.map((t,o)=>{if(!["assistant","user"].includes(String(t.author?.role))||!Array.isArray(t.content?.parts))return t;let a=!1,f=t.content.parts.map((g,i)=>{if(typeof g!=="string")return g;let r=se(g,`m${o}p${i}`);if(r.blocks.length===0)return g;return a=!0,n.push(...r.blocks),r.text});if(!a)return t;return{...t,content:{...t.content,parts:f}}});return{payload:{...e,messages:s},codeBlocks:n}}function E(e,n){let s=n.apiKind==="paginated-initial",t=s?K(e):!1,o=I(e,{recentFullTurns:s&&t?n.recentFullTurns??1:0,forceKeepMessageIds:s?Y(e):[],collapseTurnsToQuestionAnswer:n.apiKind==="paginated-messages"||s&&!t}),a=n.lightweightCodeBlocks===!0&&!t?re(o.payload):{payload:o.payload,codeBlocks:[]},f=Array.isArray(a.payload.messages)?a.payload.messages:[];return{payload:a.payload,stats:o.stats,chunks:B(f,n.chunkOptions),codeBlocks:a.codeBlocks,active:t,cacheable:s&&D(e)}}self.addEventListener("message",(e)=>{let n=e.data;try{if(n.operation==="parse"){self.postMessage({id:n.id,ok:!0,value:T(n)});return}if(n.operation==="optimize-legacy"){let t=T(n),o=R(t,n.legacyOptions);self.postMessage({id:n.id,ok:!0,value:{payload:o.payload,stats:o.stats}});return}if(n.operation==="start-paginated-job"){let t=T(n),o=`page-${Z++}`,a={payload:t,requireFinal:n.requireFinal===!0};M.set(o,a),self.postMessage({id:n.id,ok:!0,value:z(o,a)});return}if(n.operation==="prepend-paginated-job"){let t=n.token??"",o=M.get(t);if(!o)throw Error("Unknown paginated job");let a=T(n);o.payload=ee(o.payload,a),self.postMessage({id:n.id,ok:!0,value:z(t,o)});return}if(n.operation==="finish-paginated-job"){let t=n.token??"",o=M.get(t);if(!o)throw Error("Unknown paginated job");M.delete(t),self.postMessage({id:n.id,ok:!0,value:E(o.payload,n)});return}if(n.operation==="cancel-paginated-job"){M.delete(n.token??""),self.postMessage({id:n.id,ok:!0,value:null});return}let s=T(n);self.postMessage({id:n.id,ok:!0,value:E(s,n)})}catch(s){self.postMessage({id:n.id,ok:!1,error:s instanceof Error?s.message:String(s)})}});})();\n';
      const url = pageWindow.URL.createObjectURL(new pageWindow.Blob([source], { type: "application/javascript" }));
      const worker = new pageWindow.Worker(url, {
        name: "chatgpt-performance-json"
      });
      pageWindow.URL.revokeObjectURL(url);
      const state = {
        worker,
        nextId: 1,
        pending: new Map
      };
      worker.addEventListener("message", (event) => {
        const reply = event.data;
        const pending = state.pending.get(reply.id);
        if (!pending)
          return;
        state.pending.delete(reply.id);
        const finishedAt = pageWindow.performance.now();
        const elapsed = finishedAt - pending.startedAt;
        try {
          pageWindow.performance.measure(`chatgpt-perf:worker:${pending.operation}`, {
            start: pending.startedAt,
            end: finishedAt,
            detail: { durationMs: elapsed }
          });
        } catch {}
        const root = pageWindow.document.documentElement;
        const count = Number(root.dataset.chatgptJsonWorkerParses ?? "0");
        const total = Number(root.dataset.chatgptJsonWorkerTotalMs ?? "0");
        root.dataset.chatgptJsonWorkerParses = String(count + 1);
        root.dataset.chatgptJsonWorkerTotalMs = String(Math.round(total + elapsed));
        if (reply.ok)
          pending.resolve(reply.value);
        else
          pending.reject(new Error(reply.error ?? "Worker JSON parse failed"));
      });
      worker.addEventListener("error", () => {
        for (const pending of state.pending.values()) {
          pending.reject(new Error("JSON worker failed"));
        }
        state.pending.clear();
        worker.terminate();
        jsonWorkerState = null;
      });
      jsonWorkerState = state;
      return state;
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not create JSON worker`, error);
      jsonWorkerState = null;
      return null;
    }
  }
  async function runOptimizerWorker(pageWindow, request, transfer = []) {
    const state = ensureJsonWorker(pageWindow);
    if (!state)
      throw new Error("Optimizer worker is unavailable");
    const id = state.nextId++;
    return await new Promise((resolve, reject) => {
      state.pending.set(id, {
        resolve,
        reject,
        startedAt: pageWindow.performance.now(),
        operation: String(request.operation ?? "unknown")
      });
      state.worker.postMessage({ id, ...request }, transfer);
    });
  }
  async function optimizeLegacyOffMain(pageWindow, text, options) {
    try {
      return await runOptimizerWorker(pageWindow, {
        operation: "optimize-legacy",
        text,
        legacyOptions: options
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Worker legacy optimization fell back`, error);
      const payload = JSON.parse(text);
      return optimizeConversationPayload(payload, options);
    }
  }
  async function optimizePaginatedOffMain(pageWindow, text, apiKind, mode, renderTurns = MODE_OPTIONS[mode].paginatedRenderTurns) {
    try {
      return await runOptimizerWorker(pageWindow, {
        operation: "optimize-paginated",
        text,
        apiKind,
        recentFullTurns: MODE_OPTIONS[mode].recentFullTurns,
        lightweightCodeBlocks: true,
        chunkOptions: {
          maxTurns: renderTurns,
          maxMessages: Number.MAX_SAFE_INTEGER,
          maxBytes: Number.MAX_SAFE_INTEGER,
          allowSplitTurns: false
        }
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Worker paginated optimization fell back`, error);
      const payload = JSON.parse(text);
      const initial = apiKind === "paginated-initial";
      const active = initial ? hasActivePaginatedWork(payload) : false;
      const result = optimizePaginatedConversationPayload(payload, {
        recentFullTurns: initial && active ? MODE_OPTIONS[mode].recentFullTurns : 0,
        forceKeepMessageIds: initial ? requiredInitialMessageIds(payload) : [],
        collapseTurnsToQuestionAnswer: apiKind === "paginated-messages" || initial && !active
      });
      return {
        payload: result.payload,
        stats: result.stats,
        chunks: splitPaginatedMessagesNewestFirst(result.payload.messages ?? [], {
          maxTurns: renderTurns,
          maxMessages: Number.MAX_SAFE_INTEGER,
          maxBytes: Number.MAX_SAFE_INTEGER,
          allowSplitTurns: false
        }),
        active,
        cacheable: initial && isIdlePaginatedConversation(payload)
      };
    }
  }
  async function startPaginatedWorkerJob(pageWindow, buffer, requireFinal) {
    return runOptimizerWorker(pageWindow, {
      operation: "start-paginated-job",
      buffer,
      requireFinal
    }, [buffer]);
  }
  async function prependPaginatedWorkerJob(pageWindow, token, buffer) {
    return runOptimizerWorker(pageWindow, {
      operation: "prepend-paginated-job",
      token,
      buffer
    }, [buffer]);
  }
  async function finishPaginatedWorkerJob(pageWindow, token, apiKind, mode, renderTurns = MODE_OPTIONS[mode].paginatedRenderTurns) {
    return runOptimizerWorker(pageWindow, {
      operation: "finish-paginated-job",
      token,
      apiKind,
      recentFullTurns: MODE_OPTIONS[mode].recentFullTurns,
      lightweightCodeBlocks: true,
      chunkOptions: {
        maxTurns: renderTurns,
        maxMessages: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        allowSplitTurns: false
      }
    });
  }
  async function cancelPaginatedWorkerJob(pageWindow, token) {
    try {
      await runOptimizerWorker(pageWindow, {
        operation: "cancel-paginated-job",
        token
      });
    } catch {}
  }
  async function parseJsonOffMain(pageWindow, text) {
    if (text.length < 128 * 1024)
      return JSON.parse(text);
    const state = ensureJsonWorker(pageWindow);
    if (!state)
      return JSON.parse(text);
    const id = state.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        state.pending.set(id, {
          resolve,
          reject,
          startedAt: pageWindow.performance.now(),
          operation: "parse"
        });
        state.worker.postMessage({ id, operation: "parse", text });
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Worker parse fell back to main thread`, error);
      return JSON.parse(text);
    }
  }
  async function responseJsonOffMain(pageWindow, response) {
    return parseJsonOffMain(pageWindow, await response.text());
  }
  function rewriteGetRequest(pageWindow, input, init, rewrittenUrl) {
    const requestLike = input;
    if (typeof requestLike.method !== "string" || requestLike.headers == null) {
      return [rewrittenUrl, init];
    }
    const rewrittenInit = {
      method: "GET",
      headers: requestLike.headers,
      credentials: requestLike.credentials,
      cache: requestLike.cache,
      redirect: requestLike.redirect,
      referrer: requestLike.referrer,
      referrerPolicy: requestLike.referrerPolicy,
      integrity: requestLike.integrity,
      keepalive: requestLike.keepalive,
      mode: requestLike.mode,
      signal: requestLike.signal,
      ...init
    };
    return [new pageWindow.URL(rewrittenUrl).href, rewrittenInit];
  }
  function findConversationCodeMirrorContainer(pageWindow, target) {
    if (!(target instanceof pageWindow.Element))
      return null;
    const container = target.closest('[class*="_codemirror"]');
    if (!container)
      return null;
    return container.closest('[data-message-id], .markdown, [class*="MarkdownContent"], [class*="SmoothedMarkdown"]') ? container : null;
  }
  function dispatchHistorySettledAfterCommit(pageWindow, ok = true) {
    const dispatch = () => {
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptHistorySettledSignals = String(Number(root.dataset.chatgptHistorySettledSignals ?? "0") + 1);
      pageWindow.dispatchEvent(new pageWindow.CustomEvent("chatgpt-performance-fix:history-page-settled", {
        detail: { ok }
      }));
    };
    if (pageWindow.document.visibilityState === "hidden" || typeof pageWindow.requestAnimationFrame !== "function") {
      pageWindow.setTimeout(dispatch, 50);
      return;
    }
    pageWindow.requestAnimationFrame(() => {
      pageWindow.requestAnimationFrame(() => pageWindow.setTimeout(dispatch, 0));
    });
  }
  function installManualPaginationObserver(pageWindow, settings) {
    const marker = "__chatgptPerformanceFixIntersectionObserver";
    if (Reflect.get(pageWindow, marker))
      return;
    const NativeIntersectionObserver = pageWindow.IntersectionObserver;
    if (typeof NativeIntersectionObserver !== "function")
      return;
    const HISTORY_SETTLED_EVENT = "chatgpt-performance-fix:history-page-settled";
    const HISTORY_FINITE_PLAN_EVENT = "chatgpt-performance-fix:history-finite-plan";
    const PAGINATION_SENTINEL_TEST_ID = "conversation-pagination-sentinel";
    const isPaginationSentinelElement = (target) => {
      if (!(target instanceof pageWindow.Element))
        return false;
      const testId = target.getAttribute("data-testid");
      return typeof testId === "string" && testId.includes(PAGINATION_SENTINEL_TEST_ID);
    };
    const mutationNodeContainsPaginationUi = (node) => {
      if (!(node instanceof pageWindow.Element))
        return false;
      if (isPaginationSentinelElement(node) || node.getAttribute("data-chatgpt-history-load-control") === "true") {
        return true;
      }
      return Boolean(node.querySelector(`[data-testid*="${PAGINATION_SENTINEL_TEST_ID}"],` + '[data-chatgpt-history-load-control="true"]'));
    };
    const paginationDrivers = new Set;
    const paginationReconcilers = new Set;
    let nextPaginationGeneration = 0;
    let paginationReconcileScheduled = false;
    const schedulePaginationDomReconcile = () => {
      if (paginationReconcileScheduled)
        return;
      paginationReconcileScheduled = true;
      const run = () => {
        paginationReconcileScheduled = false;
        for (const reconcile of paginationReconcilers)
          reconcile();
      };
      if (pageWindow.document.visibilityState === "hidden" || typeof pageWindow.requestAnimationFrame !== "function") {
        pageWindow.setTimeout(run, 0);
      } else {
        pageWindow.requestAnimationFrame(run);
      }
    };
    const batchState = {
      active: false,
      all: false,
      requestedTurns: 0,
      remaining: 0,
      inFlight: false,
      misses: 0,
      lastDrivenGeneration: 0
    };
    let batchResumeTimer;
    let batchWatchdogTimer;
    const refreshBatchUi = () => {
      for (const driver of paginationDrivers)
        driver.refreshHistoryBatchUi();
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptHistoryBatchActive = batchState.active ? "true" : "false";
      root.dataset.chatgptHistoryBatchMode = batchState.active ? batchState.all ? "all" : "count" : "idle";
    };
    const syncFiniteBatchRequestState = () => {
      const root = pageWindow.document.documentElement;
      if (!batchState.active || batchState.all) {
        delete root.dataset.chatgptHistoryFiniteRequestedTurns;
        delete root.dataset.chatgptHistoryFiniteServerRequestPending;
        return;
      }
      root.dataset.chatgptHistoryFiniteRequestedTurns = String(batchState.requestedTurns);
      if (root.dataset.chatgptHistoryFiniteServerRequestPending !== "false") {
        root.dataset.chatgptHistoryFiniteServerRequestPending = "true";
      }
    };
    const stopBatch = () => {
      batchState.active = false;
      batchState.all = false;
      batchState.requestedTurns = 0;
      batchState.remaining = 0;
      batchState.inFlight = false;
      batchState.misses = 0;
      batchState.lastDrivenGeneration = 0;
      const root = pageWindow.document.documentElement;
      delete root.dataset.chatgptHistoryFiniteRequestedTurns;
      delete root.dataset.chatgptHistoryFiniteServerRequestPending;
      if (batchResumeTimer != null) {
        pageWindow.clearTimeout(batchResumeTimer);
        batchResumeTimer = undefined;
      }
      if (batchWatchdogTimer != null) {
        pageWindow.clearTimeout(batchWatchdogTimer);
        batchWatchdogTimer = undefined;
      }
      refreshBatchUi();
    };
    const runNextBatchStep = () => {
      batchResumeTimer = undefined;
      if (!batchState.active || batchState.inFlight)
        return;
      if (!batchState.all && batchState.remaining <= 0) {
        stopBatch();
        return;
      }
      const driver = [...paginationDrivers].reverse().find((candidate) => candidate.canContinueHistoryBatch() && candidate.historyBatchGeneration() > batchState.lastDrivenGeneration);
      if (!driver) {
        batchState.misses += 1;
        if (batchState.misses >= 20) {
          stopBatch();
          return;
        }
        batchResumeTimer = pageWindow.setTimeout(runNextBatchStep, 50);
        return;
      }
      batchState.misses = 0;
      if (!driver.driveHistoryBatchPage()) {
        batchResumeTimer = pageWindow.setTimeout(runNextBatchStep, 50);
      }
    };
    const scheduleNextBatchStep = (delay = 0) => {
      if (!batchState.active || batchState.inFlight || batchResumeTimer != null)
        return;
      batchResumeTimer = pageWindow.setTimeout(runNextBatchStep, delay);
    };
    const startBatch = (driver, value) => {
      if (batchState.active || !driver.canStartHistoryBatch())
        return;
      batchState.active = true;
      batchState.all = value === "all";
      batchState.requestedTurns = value === "all" ? 0 : value;
      batchState.remaining = value === "all" ? Number.POSITIVE_INFINITY : value;
      batchState.inFlight = false;
      batchState.misses = 0;
      batchState.lastDrivenGeneration = 0;
      const root = pageWindow.document.documentElement;
      if (batchState.all) {
        delete root.dataset.chatgptHistoryFiniteRequestedTurns;
        delete root.dataset.chatgptHistoryFiniteServerRequestPending;
      } else {
        root.dataset.chatgptHistoryFiniteRequestedTurns = String(value);
        root.dataset.chatgptHistoryFiniteServerRequestPending = "true";
      }
      refreshBatchUi();
      scheduleNextBatchStep();
    };
    const onHistorySettled = (event) => {
      if (!batchState.active || !batchState.inFlight)
        return;
      batchState.inFlight = false;
      if (batchWatchdogTimer != null) {
        pageWindow.clearTimeout(batchWatchdogTimer);
        batchWatchdogTimer = undefined;
      }
      const detail = event instanceof pageWindow.CustomEvent ? event.detail : undefined;
      if (detail?.ok === false) {
        stopBatch();
        return;
      }
      if (!batchState.all && batchState.remaining <= 0) {
        stopBatch();
        return;
      }
      refreshBatchUi();
      scheduleNextBatchStep(20);
    };
    const onFiniteHistoryPlan = (event) => {
      if (!batchState.active || batchState.all)
        return;
      const detail = event instanceof pageWindow.CustomEvent ? event.detail : undefined;
      const localPages = Number(detail?.localPages);
      if (!Number.isFinite(localPages) || localPages < 0)
        return;
      batchState.remaining = Math.min(batchState.remaining, Math.max(0, Math.floor(localPages)));
      syncFiniteBatchRequestState();
    };

    class TunedIntersectionObserver {
      callback;
      options;
      observer;
      lastPaginationEntries;
      paginationTarget;
      observedTargets = new Set;
      paginationTargets = new Set;
      paginationGeneration = 0;
      control;
      button;
      allButton;
      batchSelect;
      deferredCodeMirrorTargets = new Map;
      paginationTargetObserver;
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
      }
      refreshHistoryBatchUi() {
        if (!this.button)
          return;
        const canLoad = this.canStartHistoryBatch();
        this.button.disabled = batchState.active || !canLoad;
        this.button.textContent = batchState.active ? batchState.all ? "正在加载全部…" : "加载中…" : `加载 ${formatTurnLoadSetting(settings.historyBatchTurns)}`;
        this.button.setAttribute("aria-busy", batchState.active ? "true" : "false");
        this.button.title = canLoad ? `加载 ${formatTurnLoadSetting(settings.historyBatchTurns)}历史消息` : "滚到顶部后可加载更多";
        if (this.allButton) {
          this.allButton.disabled = batchState.active || !canLoad;
          this.allButton.setAttribute("aria-busy", batchState.active ? "true" : "false");
        }
      }
      paginationTargetIsVisible() {
        const target = this.paginationTarget;
        if (!target?.isConnected)
          return false;
        const targetRect = target.getBoundingClientRect();
        const root = this.root;
        const rootTop = root instanceof pageWindow.Element ? root.getBoundingClientRect().top : 0;
        const rootBottom = root instanceof pageWindow.Element ? root.getBoundingClientRect().bottom : pageWindow.innerHeight;
        return targetRect.bottom >= rootTop - 2 && targetRect.top <= rootBottom + 2;
      }
      syntheticPaginationEntry() {
        const target = this.paginationTarget;
        if (!target?.isConnected || !this.paginationTargetIsVisible())
          return null;
        const targetRect = target.getBoundingClientRect();
        const root = this.root;
        const rootBounds = root instanceof pageWindow.Element ? root.getBoundingClientRect() : new pageWindow.DOMRect(0, 0, pageWindow.innerWidth, pageWindow.innerHeight);
        return {
          time: pageWindow.performance.now(),
          target,
          rootBounds,
          boundingClientRect: targetRect,
          intersectionRect: targetRect,
          isIntersecting: true,
          intersectionRatio: 1
        };
      }
      currentPaginationEntries() {
        const target = this.paginationTarget;
        if (!target)
          return [];
        const current = this.lastPaginationEntries?.filter((entry) => entry.target === target) ?? [];
        if (current.length > 0)
          return current;
        const synthetic = this.syntheticPaginationEntry();
        return synthetic ? [synthetic] : [];
      }
      canStartHistoryBatch() {
        if (!this.paginationTarget?.isConnected)
          return false;
        return this.currentPaginationEntries().some((entry) => entry.isIntersecting) || this.paginationTargetIsVisible();
      }
      historyBatchGeneration() {
        return this.paginationGeneration;
      }
      canContinueHistoryBatch() {
        return Boolean(this.paginationTarget?.isConnected && this.currentPaginationEntries().length);
      }
      driveHistoryBatchPage() {
        const entries = this.currentPaginationEntries();
        if (!batchState.active || batchState.inFlight || !this.paginationTarget?.isConnected || entries.length === 0) {
          return false;
        }
        if (!batchState.all) {
          if (batchState.remaining <= 0)
            return false;
          batchState.remaining -= 1;
          syncFiniteBatchRequestState();
        }
        const forcedEntries = entries.map((entry) => {
          if (entry.isIntersecting)
            return entry;
          const forced = Object.create(entry);
          Object.defineProperty(forced, "isIntersecting", { value: true });
          Object.defineProperty(forced, "intersectionRatio", {
            value: Math.max(0.01, entry.intersectionRatio)
          });
          return forced;
        });
        batchState.inFlight = true;
        batchState.lastDrivenGeneration = this.paginationGeneration;
        refreshBatchUi();
        const root = pageWindow.document.documentElement;
        const clicks = Number(root.dataset.chatgptManualHistoryClicks ?? "0");
        root.dataset.chatgptManualHistoryClicks = String(clicks + 1);
        try {
          this.callback(forcedEntries, this);
        } catch (error) {
          batchState.inFlight = false;
          console.warn(`[${SCRIPT_NAME}] Manual history callback failed`, error);
          return false;
        }
        if (batchWatchdogTimer != null)
          pageWindow.clearTimeout(batchWatchdogTimer);
        batchWatchdogTimer = pageWindow.setTimeout(stopBatch, 12000);
        return true;
      }
      beginBatch = (value) => {
        startBatch(this, value);
      };
      triggerManualLoad = () => {
        this.beginBatch(settings.historyBatchTurns);
      };
      triggerLoadAll = () => {
        this.beginBatch("all");
      };
      syncBatchSelect() {
        if (!this.batchSelect)
          return;
        const value = settings.historyBatchTurns === "all" ? "all" : String(settings.historyBatchTurns);
        if (![...this.batchSelect.options].some((option) => option.value === value)) {
          const option = pageWindow.document.createElement("option");
          option.value = value;
          option.textContent = `${value} 轮`;
          this.batchSelect.insertBefore(option, this.batchSelect.lastElementChild);
        }
        this.batchSelect.value = value;
      }
      onBatchSelectChange = async () => {
        if (!this.batchSelect)
          return;
        let next;
        if (this.batchSelect.value === "custom") {
          next = await showTurnLoadSettingDialog(pageWindow, "每次“加载更多”默认加载多少轮？", settings.historyBatchTurns);
        } else {
          next = normalizeTurnLoadSetting(this.batchSelect.value, settings.historyBatchTurns);
        }
        if (next != null) {
          settings.historyBatchTurns = next;
          writeSettings(pageWindow.localStorage, settings);
        }
        this.syncBatchSelect();
        this.refreshHistoryBatchUi();
      };
      placeControl(target, control) {
        if (!target.isConnected)
          return false;
        try {
          const inserted = target.insertAdjacentElement("afterend", control);
          if (inserted === control && control.isConnected)
            return true;
        } catch {}
        const parent = target.parentElement;
        if (!parent)
          return false;
        try {
          parent.insertBefore(control, target.nextSibling);
        } catch {
          return false;
        }
        return control.isConnected;
      }
      forgetDetachedControl() {
        if (!this.control || this.control.isConnected)
          return;
        this.button?.removeEventListener("click", this.triggerManualLoad);
        this.allButton?.removeEventListener("click", this.triggerLoadAll);
        this.batchSelect?.removeEventListener("change", this.onBatchSelectChange);
        this.control = undefined;
        this.button = undefined;
        this.allButton = undefined;
        this.batchSelect = undefined;
      }
      installControl(target) {
        if (!target.isConnected)
          return;
        if (this.control?.isConnected) {
          if (this.control.previousElementSibling !== target) {
            if (!this.placeControl(target, this.control))
              return;
          }
          this.paginationTarget = target;
          this.refreshHistoryBatchUi();
          return;
        }
        this.forgetDetachedControl();
        const control = pageWindow.document.createElement("div");
        control.dataset.chatgptHistoryLoadControl = "true";
        control.style.cssText = [
          "display:flex",
          "justify-content:center",
          "align-items:center",
          "gap:7px",
          "flex-wrap:wrap",
          "padding:10px 0 14px",
          "min-height:48px",
          "position:relative",
          "z-index:2"
        ].join(";");
        const button = pageWindow.document.createElement("button");
        button.type = "button";
        button.dataset.chatgptHistoryLoadButton = "true";
        button.style.cssText = [
          "appearance:none",
          "border:1px solid var(--border-light,rgba(127,127,127,.24))",
          "border-radius:999px",
          "padding:7px 13px",
          "font:500 13px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
          "background:var(--main-surface-secondary,rgba(127,127,127,.10))",
          "color:var(--text-primary,inherit)",
          "cursor:pointer",
          "box-shadow:0 1px 2px rgba(0,0,0,.06)"
        ].join(";");
        button.addEventListener("click", this.triggerManualLoad);
        const select = pageWindow.document.createElement("select");
        select.dataset.chatgptHistoryBatchSelect = "true";
        select.title = "每次加载的历史轮数";
        select.style.cssText = [
          "border:1px solid var(--border-light,rgba(127,127,127,.24))",
          "border-radius:999px",
          "padding:6px 9px",
          "font:500 12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
          "background:var(--main-surface-primary,var(--main-surface-secondary,inherit))",
          "color:var(--text-primary,inherit)"
        ].join(";");
        for (const [value, label] of [
          ["1", "1 轮"],
          ["2", "2 轮"],
          ["5", "5 轮"],
          ["10", "10 轮"],
          ["20", "20 轮"],
          ["50", "50 轮"],
          ["all", "全部"],
          ["custom", "自定义…"]
        ]) {
          const option = pageWindow.document.createElement("option");
          option.value = value;
          option.textContent = label;
          select.append(option);
        }
        select.addEventListener("change", this.onBatchSelectChange);
        const allButton = button.cloneNode(false);
        allButton.dataset.chatgptHistoryLoadAllButton = "true";
        allButton.textContent = "全部加载";
        allButton.title = "持续加载直到没有更早的历史消息";
        allButton.addEventListener("click", this.triggerLoadAll);
        control.append(select, button, allButton);
        if (!this.placeControl(target, control)) {
          button.removeEventListener("click", this.triggerManualLoad);
          allButton.removeEventListener("click", this.triggerLoadAll);
          select.removeEventListener("change", this.onBatchSelectChange);
          return;
        }
        this.control = control;
        this.button = button;
        this.allButton = allButton;
        this.batchSelect = select;
        this.paginationTarget = target;
        this.syncBatchSelect();
        this.refreshHistoryBatchUi();
      }
      reconcilePaginationUi = () => {
        const connectedTarget = [...this.paginationTargets].reverse().find((candidate) => candidate.isConnected);
        if (!connectedTarget) {
          this.paginationTarget = undefined;
          this.control?.remove();
          return;
        }
        this.paginationTarget = connectedTarget;
        this.installControl(connectedTarget);
      };
      registerPaginationTarget(target, rearmed) {
        const known = this.paginationTargets.has(target);
        this.paginationTargets.delete(target);
        this.paginationTargets.add(target);
        this.paginationTarget = target;
        if (!known || rearmed) {
          this.paginationGeneration = ++nextPaginationGeneration;
        }
        paginationDrivers.add(this);
        paginationReconcilers.add(this.reconcilePaginationUi);
        this.reconcilePaginationUi();
        if (batchState.active)
          scheduleNextBatchStep();
      }
      resetPaginationTargetObserver(newTarget) {
        this.paginationTargetObserver ??= new pageWindow.MutationObserver((records) => {
          for (const record of records) {
            const target = record.target;
            if (target instanceof pageWindow.Element && this.observedTargets.has(target) && isPaginationSentinelElement(target)) {
              this.registerPaginationTarget(target, false);
            }
          }
        });
        if (newTarget) {
          this.paginationTargetObserver.observe(newTarget, {
            attributes: true,
            attributeFilter: ["data-testid"]
          });
          return;
        }
        this.paginationTargetObserver.disconnect();
        for (const target of this.observedTargets) {
          this.paginationTargetObserver.observe(target, {
            attributes: true,
            attributeFilter: ["data-testid"]
          });
        }
      }
      isPaginationEntry(entry) {
        return this.paginationTargets.has(entry.target) || isPaginationSentinelElement(entry.target);
      }
      noteSuppressedPagination(count, kind) {
        if (count <= 0)
          return;
        const root = pageWindow.document.documentElement;
        const key = kind === "callback" ? "chatgptSuppressedAutoPaginationCallbacks" : "chatgptSuppressedAutoPaginationRecords";
        root.dataset[key] = String(Number(root.dataset[key] ?? "0") + count);
      }
      dispatchNative(entries) {
        for (const entry of entries) {
          if (isPaginationSentinelElement(entry.target)) {
            this.registerPaginationTarget(entry.target, false);
          }
        }
        const paginationEntries = entries.filter((entry) => this.isPaginationEntry(entry));
        if (paginationEntries.length === 0) {
          this.callback(entries, this);
          return;
        }
        this.lastPaginationEntries = paginationEntries;
        this.refreshHistoryBatchUi();
        if (batchState.active)
          scheduleNextBatchStep();
        const forwarded = entries.filter((entry) => !this.isPaginationEntry(entry) || !entry.isIntersecting);
        this.noteSuppressedPagination(entries.length - forwarded.length, "callback");
        if (forwarded.length > 0)
          this.callback(forwarded, this);
      }
      ensureObserver(target) {
        if (this.observer)
          return this.observer;
        this.observer = new NativeIntersectionObserver((entries) => this.dispatchNative(entries), this.options);
        return this.observer;
      }
      observe(target) {
        const observer = this.ensureObserver(target);
        this.observedTargets.add(target);
        this.resetPaginationTargetObserver(target);
        const isPaginationTarget = isPaginationSentinelElement(target);
        if (isPaginationTarget) {
          this.registerPaginationTarget(target, true);
        }
        const container = findConversationCodeMirrorContainer(pageWindow, target);
        if (container && container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
          if (this.deferredCodeMirrorTargets.has(target))
            return;
          const attributeObserver = new pageWindow.MutationObserver(() => {
            if (container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
              return;
            }
            attributeObserver.disconnect();
            this.deferredCodeMirrorTargets.delete(target);
            observer.observe(target);
            const root = pageWindow.document.documentElement;
            const count = Number(root.dataset.chatgptCodeMirrorIoResumed ?? "0");
            root.dataset.chatgptCodeMirrorIoResumed = String(count + 1);
          });
          attributeObserver.observe(container, {
            attributes: true,
            attributeFilter: ["data-chatgpt-rich-editor-state"]
          });
          this.deferredCodeMirrorTargets.set(target, attributeObserver);
          const root = pageWindow.document.documentElement;
          const count = Number(root.dataset.chatgptCodeMirrorIoDeferred ?? "0");
          root.dataset.chatgptCodeMirrorIoDeferred = String(count + 1);
          return;
        }
        observer.observe(target);
        if (isPaginationTarget && batchState.active)
          scheduleNextBatchStep();
      }
      unobserve(target) {
        this.deferredCodeMirrorTargets.get(target)?.disconnect();
        this.deferredCodeMirrorTargets.delete(target);
        this.observedTargets.delete(target);
        this.resetPaginationTargetObserver();
        this.observer?.unobserve(target);
        if (this.paginationTargets.delete(target) && this.paginationTarget === target) {
          this.paginationTarget = [...this.paginationTargets].reverse().find((candidate) => candidate.isConnected);
        }
        if (this.paginationTargets.size === 0) {
          paginationDrivers.delete(this);
          paginationReconcilers.delete(this.reconcilePaginationUi);
          this.control?.remove();
        } else {
          this.reconcilePaginationUi();
        }
      }
      disconnect() {
        this.observer?.disconnect();
        paginationDrivers.delete(this);
        paginationReconcilers.delete(this.reconcilePaginationUi);
        this.observedTargets.clear();
        this.paginationTargets.clear();
        this.paginationTargetObserver?.disconnect();
        for (const observer of this.deferredCodeMirrorTargets.values()) {
          observer.disconnect();
        }
        this.deferredCodeMirrorTargets.clear();
        this.button?.removeEventListener("click", this.triggerManualLoad);
        this.allButton?.removeEventListener("click", this.triggerLoadAll);
        this.batchSelect?.removeEventListener("change", this.onBatchSelectChange);
        this.control?.remove();
        this.control = undefined;
        this.button = undefined;
        this.allButton = undefined;
        this.batchSelect = undefined;
        this.paginationTarget = undefined;
        this.lastPaginationEntries = undefined;
        if (batchState.active)
          scheduleNextBatchStep();
      }
      takeRecords() {
        const records = this.observer?.takeRecords() ?? [];
        if (records.length === 0)
          return records;
        for (const entry of records) {
          if (isPaginationSentinelElement(entry.target)) {
            this.registerPaginationTarget(entry.target, false);
          }
        }
        const paginationRecords = records.filter((entry) => this.isPaginationEntry(entry));
        if (paginationRecords.length > 0) {
          this.lastPaginationEntries = paginationRecords;
          this.refreshHistoryBatchUi();
          if (batchState.active)
            scheduleNextBatchStep();
        }
        const filtered = records.filter((entry) => !this.isPaginationEntry(entry) || !entry.isIntersecting);
        this.noteSuppressedPagination(records.length - filtered.length, "record");
        return filtered;
      }
      get root() {
        return this.observer?.root ?? this.options?.root ?? null;
      }
      get rootMargin() {
        return this.observer?.rootMargin ?? this.options?.rootMargin ?? "0px 0px 0px 0px";
      }
      get thresholds() {
        if (this.observer)
          return this.observer.thresholds;
        const threshold = this.options?.threshold;
        if (Array.isArray(threshold))
          return [...threshold].sort((a, b) => a - b);
        return [typeof threshold === "number" ? threshold : 0];
      }
    }
    try {
      Object.setPrototypeOf(TunedIntersectionObserver.prototype, NativeIntersectionObserver.prototype);
      Object.setPrototypeOf(TunedIntersectionObserver, NativeIntersectionObserver);
      Object.defineProperty(TunedIntersectionObserver, "name", {
        value: "IntersectionObserver"
      });
      Object.defineProperty(pageWindow, "IntersectionObserver", {
        configurable: true,
        writable: true,
        value: TunedIntersectionObserver
      });
      pageWindow.addEventListener(HISTORY_SETTLED_EVENT, onHistorySettled);
      pageWindow.addEventListener(HISTORY_FINITE_PLAN_EVENT, onFiniteHistoryPlan);
      const paginationDomObserver = new pageWindow.MutationObserver((records) => {
        const relevant = records.some((record) => {
          if (record.type === "attributes") {
            return isPaginationSentinelElement(record.target);
          }
          return [...record.addedNodes, ...record.removedNodes].some(mutationNodeContainsPaginationUi);
        });
        if (relevant)
          schedulePaginationDomReconcile();
      });
      paginationDomObserver.observe(pageWindow.document.documentElement, {
        attributes: true,
        attributeFilter: ["data-testid"],
        childList: true,
        subtree: true
      });
      Reflect.set(pageWindow, marker, true);
      pageWindow.document.documentElement.dataset.chatgptHistoryLoadingMode = "manual";
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not install manual history loading`, error);
    }
  }
  function isFinishedMessageStatus(status) {
    return status === "finished_successfully" || status === "finished" || status === "complete";
  }
  function isIdleConversation(payload) {
    if (payload.async_status != null)
      return false;
    if (typeof payload.current_node !== "string" || typeof payload.mapping !== "object" || payload.mapping === null) {
      return false;
    }
    const current = payload.mapping[payload.current_node];
    return isFinishedMessageStatus(current?.message?.status);
  }
  function currentPaginatedMessage(payload) {
    if (typeof payload.current_node !== "string" || !Array.isArray(payload.messages)) {
      return;
    }
    return payload.messages.find((message) => message.id === payload.current_node);
  }
  function hasActivePaginatedWork(payload) {
    if (payload.async_status != null)
      return true;
    if (!Array.isArray(payload.messages))
      return true;
    const messages = payload.messages;
    if (messages.some((message) => ["in_progress", "streaming", "pending"].includes(String(message.status)))) {
      return true;
    }
    const current = currentPaginatedMessage(payload);
    return !current || !isFinishedMessageStatus(current.status);
  }
  function isIdlePaginatedConversation(payload) {
    return !hasActivePaginatedWork(payload);
  }
  function requiredInitialMessageIds(payload) {
    if (!Array.isArray(payload.messages) || typeof payload.current_node !== "string") {
      return [];
    }
    const messages = payload.messages;
    const byId = new Map(messages.filter((message) => typeof message.id === "string").map((message) => [message.id, message]));
    const ids = new Set([payload.current_node]);
    const current = byId.get(payload.current_node);
    if (current?.author?.role === "tool") {
      const parentId = current.metadata?.parent_id;
      if (typeof parentId === "string" && byId.has(parentId))
        ids.add(parentId);
    }
    return [...ids];
  }
  function isRenderableAssistantMessage(message) {
    if (message.author?.role !== "assistant")
      return false;
    if (message.metadata?.is_visually_hidden_from_conversation === true)
      return false;
    if (message.recipient != null && message.recipient !== "all")
      return false;
    if (message.channel === "final")
      return true;
    const contentType = message.content?.content_type;
    return !["code", "execution_output", "thoughts", "reasoning_recap"].includes(String(contentType ?? ""));
  }
  function hasRenderableQuestionAnswerTurn(messages, requireFinal) {
    let userIndex = -1;
    for (let index = 0;index < messages.length; index += 1) {
      if (messages[index]?.author?.role === "user")
        userIndex = index;
    }
    if (userIndex < 0)
      return false;
    return messages.slice(userIndex + 1).some((message) => isRenderableAssistantMessage(message) && (!requireFinal || message.channel === "final"));
  }
  function mergeChronologicalMessages(older, newer) {
    const seen = new Set;
    const merged = [];
    for (const message of [...older, ...newer]) {
      const id = message.id;
      if (typeof id === "string") {
        if (seen.has(id))
          continue;
        seen.add(id);
      }
      merged.push(message);
    }
    return merged;
  }
  function writeSettings(storage, settings) {
    try {
      storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }
  function requestUrl(pageWindow, input, baseUrl) {
    if (typeof input === "string")
      return new pageWindow.URL(input, baseUrl).href;
    const requestLike = input;
    if (typeof requestLike.url === "string") {
      return new pageWindow.URL(requestLike.url, baseUrl).href;
    }
    if (typeof requestLike.href === "string") {
      return new pageWindow.URL(requestLike.href, baseUrl).href;
    }
    return new pageWindow.URL(String(input), baseUrl).href;
  }
  function requestMethod(input, init) {
    if (init?.method)
      return init.method.toUpperCase();
    const method = input?.method;
    if (typeof method === "string") {
      return method.toUpperCase();
    }
    return "GET";
  }
  function createBackendRequestContext(pageWindow) {
    let capturedHeaders = null;
    let capturedCredentials = "same-origin";
    const capture = (input, init, rawUrl) => {
      try {
        const url = new pageWindow.URL(rawUrl, pageWindow.location.href);
        if (url.origin !== pageWindow.location.origin || !url.pathname.startsWith("/backend-api/")) {
          return false;
        }
        const merged = new pageWindow.Headers;
        const requestLike = input;
        if (requestLike.headers != null) {
          new pageWindow.Headers(requestLike.headers).forEach((value, name) => {
            merged.set(name, value);
          });
        }
        if (init?.headers != null) {
          new pageWindow.Headers(init.headers).forEach((value, name) => {
            merged.set(name, value);
          });
        }
        if (!merged.has("authorization"))
          return false;
        const firstCapture = capturedHeaders == null;
        merged.delete("content-length");
        merged.delete("content-type");
        merged.delete("x-openai-target-path");
        merged.delete("x-openai-target-route");
        capturedHeaders = merged;
        capturedCredentials = init?.credentials ?? requestLike.credentials ?? "same-origin";
        const root = pageWindow.document.documentElement;
        root.dataset.chatgptBackendRequestContextReady = "true";
        root.dataset.chatgptBackendRequestContextCaptures = String(Number(root.dataset.chatgptBackendRequestContextCaptures ?? "0") + 1);
        return firstCapture;
      } catch {
        return false;
      }
    };
    return {
      capture,
      ready: () => capturedHeaders != null,
      createInit: (overrides = {}) => {
        if (!capturedHeaders)
          return null;
        const headers = new pageWindow.Headers(capturedHeaders);
        if (overrides.headers != null) {
          new pageWindow.Headers(overrides.headers).forEach((value, name) => {
            headers.set(name, value);
          });
        }
        return {
          ...overrides,
          headers,
          credentials: overrides.credentials ?? capturedCredentials
        };
      }
    };
  }
  function conversationMutationKind(rawUrl, method, baseUrl) {
    if (method === "GET" || method === "HEAD")
      return null;
    try {
      const url = new URL(rawUrl, baseUrl);
      const pathname = url.pathname.replace(/\/+$/, "");
      if (method === "POST" && (pathname === "/backend-api/conversation" || pathname === "/backend-api/f/conversation")) {
        return "send";
      }
      if (method === "POST" && pathname.endsWith("/conversation/resume")) {
        return "resume";
      }
      if (/^\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(pathname) && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        return "content";
      }
      return null;
    } catch {
      return null;
    }
  }
  function currentConversationId(pageWindow) {
    const match = pageWindow.location.pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
    return match?.[1] ?? null;
  }
  function isActiveAsyncStatus(value) {
    if (typeof value === "number")
      return [1, 3, 5, 6].includes(value);
    const normalized = String(value ?? "").trim().toLowerCase();
    return [
      "pending",
      "running",
      "streaming",
      "in_progress",
      "in-progress",
      "realtime",
      "realtime_busy",
      "busy"
    ].includes(normalized);
  }
  function conversationIdFromAnchor(pageWindow, anchor) {
    try {
      const pathname = new pageWindow.URL(anchor.href, pageWindow.location.href).pathname;
      const match = pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
  function findSidebarTitleElement(pageWindow, anchor) {
    const preferred = anchor.querySelector('[data-testid*="conversation-title"], [data-testid*="history-item-title"], .truncate, [class*="truncate"], [class*="line-clamp"]');
    if (preferred && !preferred.closest("button"))
      return preferred;
    const leaves = [...anchor.querySelectorAll("span,div")].filter((element) => {
      if (element.closest("button"))
        return false;
      const text = element.textContent?.trim() ?? "";
      return element.children.length === 0 && text.length > 0 && text.length <= 240;
    });
    return leaves[0] ?? null;
  }
  var SIDEBAR_REFRESH_STYLE_ID = "chatgpt-sidebar-refresh-style";
  function ensureSidebarRefreshStyles(pageWindow) {
    if (pageWindow.document.getElementById(SIDEBAR_REFRESH_STYLE_ID))
      return;
    const style = pageWindow.document.createElement("style");
    style.id = SIDEBAR_REFRESH_STYLE_ID;
    style.textContent = `
[data-chatgpt-sidebar-refresh-control="true"] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 8px 8px;
}
[data-chatgpt-refresh-button="true"] {
  -webkit-tap-highlight-color: transparent;
  appearance: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 6px 11px 6px 8px;
  border: 1px solid var(--border-light, rgba(127,127,127,.22));
  border-radius: 10px;
  background: var(--main-surface-secondary, rgba(127,127,127,.08));
  color: var(--text-primary, currentColor);
  box-shadow:
    0 1px 2px rgba(0,0,0,.06),
    inset 0 1px 0 rgba(255,255,255,.08);
  font: 550 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: .005em;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color .16s ease,
    background-color .16s ease,
    border-color .16s ease,
    box-shadow .16s ease,
    opacity .16s ease,
    transform .16s ease;
}
[data-chatgpt-sidebar-refresh-button="true"] {
  width: 100%;
  color: var(--text-secondary, var(--text-primary, currentColor));
}
[data-chatgpt-refresh-button="true"] [data-chatgpt-refresh-icon] {
  box-sizing: border-box;
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  margin-inline-start: -2px;
  border-radius: 6px;
  background: rgba(16,163,127,.11);
  color: #0d8f70;
  transition: background-color .16s ease, color .16s ease, transform .16s ease;
}
[data-chatgpt-refresh-button="true"] [data-chatgpt-refresh-icon] svg {
  display: block;
  width: 14px;
  height: 14px;
  overflow: visible;
}
.dark [data-chatgpt-refresh-button="true"] [data-chatgpt-refresh-icon] {
  background: rgba(25,195,154,.13);
  color: #19c39a;
}
[data-chatgpt-refresh-button="true"] [data-chatgpt-refresh-label] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-chatgpt-refresh-button="true"]:hover:not(:disabled) {
  border-color: rgba(16,163,127,.42);
  background: var(--main-surface-tertiary, rgba(127,127,127,.13));
  color: var(--text-primary, currentColor);
  box-shadow:
    0 3px 10px rgba(0,0,0,.09),
    inset 0 1px 0 rgba(255,255,255,.1);
  transform: translateY(-1px);
}
[data-chatgpt-refresh-button="true"]:hover:not(:disabled) [data-chatgpt-refresh-icon] {
  background: rgba(16,163,127,.17);
  color: #087f5f;
}
[data-chatgpt-refresh-button="true"]:active:not(:disabled) {
  box-shadow: 0 1px 2px rgba(0,0,0,.06);
  transform: translateY(0) scale(.985);
}
[data-chatgpt-refresh-button="true"]:focus-visible {
  outline: none;
  border-color: #10a37f;
  box-shadow: 0 0 0 3px rgba(16,163,127,.2);
}
[data-chatgpt-refresh-button="true"]:disabled {
  opacity: .46;
  cursor: not-allowed;
  box-shadow: none;
}
[data-chatgpt-refresh-button="true"][data-chatgpt-refresh-state="loading"] [data-chatgpt-refresh-icon] svg {
  animation: chatgpt-refresh-control-spin .72s linear infinite;
}
[data-chatgpt-refresh-button="true"][data-chatgpt-refresh-state="success"] {
  border-color: rgba(16,163,127,.34);
}
[data-chatgpt-refresh-button="true"][data-chatgpt-refresh-state="success"] [data-chatgpt-refresh-icon] {
  background: rgba(16,163,127,.18);
}
@supports (background: color-mix(in srgb, currentColor 10%, transparent)) {
  [data-chatgpt-refresh-button="true"]:hover:not(:disabled) {
    border-color: color-mix(in srgb, #10a37f 48%, currentColor 12%);
    background: color-mix(in srgb, var(--main-surface-secondary, transparent) 88%, currentColor 12%);
  }
}
@keyframes chatgpt-refresh-control-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  [data-chatgpt-refresh-button="true"],
  [data-chatgpt-refresh-button="true"] [data-chatgpt-refresh-icon] {
    transition: none;
  }
  [data-chatgpt-refresh-button="true"][data-chatgpt-refresh-state="loading"] [data-chatgpt-refresh-icon] svg {
    animation-duration: 1.4s;
  }
}
`;
    (pageWindow.document.head ?? pageWindow.document.documentElement).append(style);
  }
  function createRefreshIcon(pageWindow) {
    const wrapper = pageWindow.document.createElement("span");
    wrapper.dataset.chatgptRefreshIcon = "true";
    wrapper.setAttribute("aria-hidden", "true");
    const svg = pageWindow.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("focusable", "false");
    const first = pageWindow.document.createElementNS("http://www.w3.org/2000/svg", "path");
    first.setAttribute("d", "M20 7v5h-5");
    const second = pageWindow.document.createElementNS("http://www.w3.org/2000/svg", "path");
    second.setAttribute("d", "M4 17v-5h5");
    const third = pageWindow.document.createElementNS("http://www.w3.org/2000/svg", "path");
    third.setAttribute("d", "M5.7 9a7 7 0 0 1 11.7-2.6L20 9");
    const fourth = pageWindow.document.createElementNS("http://www.w3.org/2000/svg", "path");
    fourth.setAttribute("d", "M18.3 15a7 7 0 0 1-11.7 2.6L4 15");
    svg.append(first, second, third, fourth);
    wrapper.append(svg);
    return wrapper;
  }
  function setRefreshButtonLabel(button, label) {
    let text = button.querySelector("[data-chatgpt-refresh-label]");
    if (!text) {
      text = button.ownerDocument.createElement("span");
      text.dataset.chatgptRefreshLabel = "true";
      button.append(text);
    }
    if (text.textContent !== label)
      text.textContent = label;
  }
  function createRefreshButton(pageWindow, label) {
    const button = pageWindow.document.createElement("button");
    button.type = "button";
    button.dataset.chatgptRefreshButton = "true";
    button.dataset.chatgptRefreshState = "idle";
    button.dataset.chatgptSidebarRefreshButton = "true";
    button.append(createRefreshIcon(pageWindow));
    setRefreshButtonLabel(button, label);
    return button;
  }
  function installSidebarFreshness(pageWindow, originalFetch, requestContext) {
    const snapshots = new Map;
    let refreshing = false;
    let domSyncScheduled = false;
    let probeBackoffUntil = 0;
    let refreshButton;
    const updateRefreshButton = (label = "刷新侧栏") => {
      if (!refreshButton)
        return;
      const ready = requestContext.ready();
      refreshButton.disabled = refreshing || !ready;
      const visibleLabel = refreshing ? "刷新中…" : label;
      setRefreshButtonLabel(refreshButton, visibleLabel);
      refreshButton.dataset.chatgptRefreshState = refreshing ? "loading" : label === "已刷新" ? "success" : label === "稍后刷新" ? "backoff" : ready ? "idle" : "unavailable";
      refreshButton.setAttribute("aria-busy", refreshing ? "true" : "false");
      refreshButton.title = !ready ? "等待 ChatGPT 初始化请求上下文" : Date.now() < probeBackoffUntil ? "最近请求过于频繁，暂时不会发起新的刷新请求" : "手动刷新侧边栏会话列表";
    };
    const ensureSidebarRefreshButton = () => {
      const existing = pageWindow.document.querySelector('[data-chatgpt-sidebar-refresh-button="true"]');
      if (existing) {
        refreshButton = existing;
        updateRefreshButton();
        return;
      }
      const firstConversationAnchor = pageWindow.document.querySelector('nav a[href*="/c/"], aside a[href*="/c/"]');
      if (!firstConversationAnchor)
        return;
      const sidebarRoot = firstConversationAnchor.closest("nav,aside");
      const parent = firstConversationAnchor.parentElement;
      const row = parent && parent !== sidebarRoot ? parent : firstConversationAnchor;
      const container = row.parentElement ?? sidebarRoot;
      if (!container)
        return;
      const control = pageWindow.document.createElement("div");
      control.dataset.chatgptSidebarRefreshControl = "true";
      const button = createRefreshButton(pageWindow, "刷新侧栏");
      button.addEventListener("click", () => void refreshManually());
      control.append(button);
      container.insertBefore(control, row);
      refreshButton = button;
      updateRefreshButton();
    };
    const ensureSidebarRefreshControl = () => {
      ensureSidebarRefreshStyles(pageWindow);
      ensureSidebarRefreshButton();
    };
    const syncDom = () => {
      domSyncScheduled = false;
      ensureSidebarRefreshControl();
      const anchors = pageWindow.document.querySelectorAll('nav a[href*="/c/"], aside a[href*="/c/"]');
      for (const anchor of anchors) {
        const id = conversationIdFromAnchor(pageWindow, anchor);
        const snapshot = id ? snapshots.get(id) : undefined;
        if (!snapshot)
          continue;
        const titleElement = findSidebarTitleElement(pageWindow, anchor);
        if (titleElement && typeof snapshot.title === "string" && snapshot.title.trim()) {
          if (titleElement.textContent?.trim() !== snapshot.title.trim()) {
            titleElement.textContent = snapshot.title.trim();
          }
          anchor.dataset.chatgptServerTitle = snapshot.title.trim();
        }
      }
    };
    const scheduleDomSync = () => {
      if (domSyncScheduled)
        return;
      domSyncScheduled = true;
      pageWindow.requestAnimationFrame(syncDom);
    };
    const ingest = (value) => {
      if (!value || typeof value !== "object")
        return;
      const row = value;
      const id = typeof row.id === "string" ? row.id : typeof row.conversation_id === "string" ? row.conversation_id : null;
      if (!id)
        return;
      const previous = snapshots.get(id);
      snapshots.set(id, {
        id,
        title: typeof row.title === "string" || row.title === null ? row.title : previous?.title
      });
    };
    const noteRateLimit = (response) => {
      if (response.status !== 429)
        return;
      probeBackoffUntil = Math.max(probeBackoffUntil, Date.now() + retryAfterBackoffMs(response.headers, SIDEBAR_RATE_LIMIT_BACKOFF_MS));
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptSidebarProbeBackoff = "true";
      root.dataset.chatgptSidebarProbeBackoffUntil = String(probeBackoffUntil);
    };
    const refreshManually = async () => {
      if (refreshing || !requestContext.ready())
        return;
      if (Date.now() < probeBackoffUntil) {
        updateRefreshButton("稍后刷新");
        pageWindow.setTimeout(() => updateRefreshButton(), 1500);
        return;
      }
      refreshing = true;
      updateRefreshButton();
      const root = pageWindow.document.documentElement;
      try {
        const listUrl = new pageWindow.URL("/backend-api/conversations", pageWindow.location.href);
        listUrl.searchParams.set("offset", "0");
        listUrl.searchParams.set("limit", "28");
        listUrl.searchParams.set("order", "updated");
        listUrl.searchParams.set("is_archived", "false");
        listUrl.searchParams.set("is_starred", "false");
        const id = currentConversationId(pageWindow);
        const listIds = new Set;
        try {
          const authenticatedInit = requestContext.createInit({
            cache: "no-store",
            headers: { accept: "application/json" }
          });
          if (!authenticatedInit)
            return;
          const response = await originalFetch(listUrl.href, authenticatedInit);
          noteRateLimit(response);
          if (response.status === 429)
            return;
          if (response.ok) {
            const payload = await response.json();
            for (const item of payload.items ?? []) {
              if (item && typeof item === "object") {
                const itemId = item.id;
                if (typeof itemId === "string")
                  listIds.add(itemId);
              }
              ingest(item);
            }
          }
        } catch {}
        if (id && !listIds.has(id) && Date.now() >= probeBackoffUntil) {
          root.dataset.chatgptSidebarDetailProbeAttempts = String(Number(root.dataset.chatgptSidebarDetailProbeAttempts ?? "0") + 1);
          const detailUrl = new pageWindow.URL(`/backend-api/conversations/${id}`, pageWindow.location.href);
          detailUrl.searchParams.set("num_turns", "1");
          detailUrl.searchParams.set("include_has_versions", "true");
          try {
            const authenticatedInit = requestContext.createInit({
              cache: "no-store",
              headers: { accept: "application/json" }
            });
            if (!authenticatedInit)
              return;
            const response = await originalFetch(detailUrl.href, authenticatedInit);
            noteRateLimit(response);
            if (response.status === 429)
              return;
            if (response.ok) {
              const payload = await response.json();
              ingest({ ...payload, conversation_id: payload.conversation_id ?? id });
              root.dataset.chatgptSidebarDetailProbeSuccesses = String(Number(root.dataset.chatgptSidebarDetailProbeSuccesses ?? "0") + 1);
            }
          } catch {}
        }
        root.dataset.chatgptSidebarFreshnessRefreshes = String(Number(root.dataset.chatgptSidebarFreshnessRefreshes ?? "0") + 1);
        scheduleDomSync();
      } catch (error) {
        console.debug(`[${SCRIPT_NAME}] Sidebar freshness refresh skipped`, error);
      } finally {
        refreshing = false;
        updateRefreshButton("已刷新");
        pageWindow.setTimeout(() => updateRefreshButton(), 900);
      }
    };
    const observer = new pageWindow.MutationObserver((records) => {
      if (sidebarMayHaveChanged(records))
        scheduleDomSync();
    });
    const observeTarget = pageWindow.document.body ?? pageWindow.document.documentElement;
    if (observeTarget)
      observer.observe(observeTarget, { childList: true, subtree: true });
    scheduleDomSync();
    return {
      requestContextChanged: () => {
        updateRefreshButton();
        scheduleDomSync();
      }
    };
  }
  function recordFromUnknown(value) {
    return value != null && typeof value === "object" && !Array.isArray(value) ? value : null;
  }
  function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }
  function firstNonEmptyString(...values) {
    return values.map(nonEmptyString).find((value) => value != null) ?? null;
  }
  function chatgptTimestampMs(value) {
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    const milliseconds = numeric >= 10000000000 ? numeric : numeric * 1000;
    return Number.isFinite(milliseconds) && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
  }
  function textFromOutgoingMessage(message) {
    if (!message || typeof message !== "object")
      return null;
    const value = message;
    const content = value.content;
    if (!content || typeof content !== "object")
      return null;
    const parts = content.parts;
    if (!Array.isArray(parts))
      return null;
    const text = parts.filter((part) => typeof part === "string").join(`
`);
    return text || null;
  }
  function inspectOutgoingBody(body) {
    const empty = {
      conversationId: null,
      messageId: null,
      text: null,
      hasUserMessage: false,
      createdAtMs: null,
      requestedModelSlug: null
    };
    if (typeof body !== "string")
      return empty;
    try {
      const parsed = JSON.parse(body);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const message = [...messages].reverse().find((candidate) => {
        if (!candidate || typeof candidate !== "object")
          return false;
        const author = candidate.author;
        return Boolean(author && typeof author === "object" && author.role === "user");
      });
      const metadata = recordFromUnknown(message?.metadata);
      const requestedModelSlug = [
        parsed.requested_model_slug,
        parsed.requested_default_model,
        parsed.default_model_slug,
        parsed.model_slug,
        parsed.model,
        metadata?.requested_model_slug,
        message?.requested_model_slug,
        message?.requested_default_model,
        message?.default_model_slug,
        message?.model_slug,
        message?.model
      ].map(nonEmptyString).find((value) => value != null) ?? null;
      return {
        conversationId: typeof parsed.conversation_id === "string" ? parsed.conversation_id : null,
        messageId: typeof message?.id === "string" ? message.id : null,
        text: textFromOutgoingMessage(message),
        hasUserMessage: Boolean(message),
        createdAtMs: chatgptTimestampMs(message?.create_time),
        requestedModelSlug
      };
    } catch {
      try {
        const params = new URLSearchParams(body);
        const messageId = params.get("message_id");
        const text = params.get("text") ?? params.get("prompt");
        const requestedModelSlug = [
          "requested_model_slug",
          "requested_default_model",
          "default_model_slug",
          "model_slug",
          "model"
        ].map((key) => nonEmptyString(params.get(key))).find((value) => value != null) ?? null;
        return {
          conversationId: params.get("conversation_id"),
          messageId,
          text,
          hasUserMessage: Boolean(messageId || text?.trim()),
          createdAtMs: chatgptTimestampMs(Number(params.get("create_time"))),
          requestedModelSlug
        };
      } catch {
        return empty;
      }
    }
  }
  function effectiveMessageModel(message) {
    const metadata = message.metadata;
    const resolved = firstNonEmptyString(metadata?.resolved_model_slug, message.resolved_model_slug);
    if (resolved)
      return { slug: resolved, source: "resolved" };
    const recorded = firstNonEmptyString(metadata?.model_slug, metadata?.default_model_slug, message.model_slug, message.default_model_slug, message.model);
    if (recorded)
      return { slug: recorded, source: "message" };
    const requested = firstNonEmptyString(metadata?.requested_model_slug, message.requested_model_slug, message.requested_default_model);
    return requested ? { slug: requested, source: "requested" } : null;
  }
  function isVisibleAssistantForMetadata(message) {
    if (message.author?.role !== "assistant")
      return false;
    if (message.metadata?.is_visually_hidden_from_conversation === true)
      return false;
    if (message.recipient != null && message.recipient !== "all")
      return false;
    return !["code", "execution_output", "thoughts", "reasoning_recap"].includes(String(message.content?.content_type ?? ""));
  }
  function friendlyModelLabel(slug) {
    const normalized = slug.trim().replace(/\s+/g, " ");
    const titleCaseWords = (value) => value.split(/[-_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    const gpt = normalized.match(/^gpt-(\d+)(?:[-.](\d+))?(.*)$/i);
    if (gpt) {
      const version = gpt[2] ? `${gpt[1]}.${gpt[2]}` : gpt[1];
      const suffixText = gpt[3].replace(/^[-_.]+/, "");
      const compactSuffix = suffixText.match(/^([a-z])(?:[-_](.*))?$/i);
      const suffix = compactSuffix ? `${compactSuffix[1].toLowerCase()}${compactSuffix[2] ? ` ${titleCaseWords(compactSuffix[2])}` : ""}` : titleCaseWords(suffixText);
      return `GPT-${version}${suffix ? ` ${suffix}` : ""}`;
    }
    if (/^chatgpt-/i.test(normalized)) {
      return `ChatGPT ${titleCaseWords(normalized.replace(/^chatgpt-/i, ""))}`;
    }
    return titleCaseWords(normalized);
  }
  function installMessageMetadataDisplay(pageWindow) {
    const records = new Map;
    const elementsById = new Map;
    const pendingScanRoots = new Set;
    let scanFrame;
    const ensureStyles = () => {
      const id = "chatgpt-message-metadata-style";
      if (pageWindow.document.getElementById(id))
        return;
      const style = pageWindow.document.createElement("style");
      style.id = id;
      style.textContent = `
[data-chatgpt-message-metadata="true"] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  width: fit-content;
  max-width: 100%;
  margin-block: 7px 1px;
  padding: 2px 7px;
  border: 1px solid rgba(127,127,127,.15);
  border-radius: 999px;
  background: rgba(127,127,127,.06);
  color: var(--token-text-secondary, var(--text-secondary, currentColor));
  font: 500 10.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  letter-spacing: .005em;
  opacity: .66;
  white-space: nowrap;
  transition: opacity .15s ease, background-color .15s ease;
}
[data-chatgpt-message-metadata="true"]:hover {
  opacity: .92;
  border-color: rgba(127,127,127,.24);
  background: rgba(127,127,127,.1);
}
@supports (color: color-mix(in srgb, currentColor 5%, transparent)) {
  [data-chatgpt-message-metadata="true"] {
    border-color: color-mix(in srgb, currentColor 13%, transparent);
    background: color-mix(in srgb, currentColor 5%, transparent);
  }
  [data-chatgpt-message-metadata="true"]:hover {
    border-color: color-mix(in srgb, currentColor 22%, transparent);
    background: color-mix(in srgb, currentColor 9%, transparent);
  }
}
[data-chatgpt-message-metadata="true"] time,
[data-chatgpt-message-metadata="true"] [data-chatgpt-message-model] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-chatgpt-message-metadata="true"] time {
  flex: 0 1 auto;
}
[data-chatgpt-message-metadata="true"] [data-chatgpt-message-model] {
  flex: 0 1 auto;
  font-weight: 600;
}
[data-chatgpt-message-metadata="true"] [data-chatgpt-message-time]::before {
  content: "◷";
  margin-inline-end: 3px;
  font-size: 11px;
  opacity: .72;
}
[data-chatgpt-message-metadata="true"] [data-chatgpt-message-model]::before {
  content: "✦";
  margin-inline-end: 3px;
  font-size: 10px;
  opacity: .68;
}
[data-chatgpt-message-metadata-role="user"] {
  margin-inline-start: auto;
  align-self: flex-end;
}
[data-chatgpt-message-metadata-role="assistant"] {
  margin-inline-end: auto;
}
[data-chatgpt-message-metadata="true"] [aria-hidden="true"] {
  opacity: .55;
}
@media print {
  [data-chatgpt-message-metadata="true"] { display: none !important; }
}`;
      const styleTarget = pageWindow.document.head ?? pageWindow.document.documentElement;
      styleTarget?.append(style);
    };
    const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    const formatDate = (milliseconds) => {
      const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(milliseconds)).map((part) => [
        part.type,
        part.value
      ]));
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    };
    const roleForElement = (element) => {
      const direct = element.getAttribute("data-message-author-role");
      if (direct === "user" || direct === "assistant")
        return direct;
      const roleHost = element.closest("[data-message-author-role]");
      const nestedRole = roleHost?.getAttribute("data-message-author-role");
      if (nestedRole === "user" || nestedRole === "assistant")
        return nestedRole;
      const turn = element.closest('[data-turn="user"], [data-turn="assistant"]');
      const turnRole = turn?.getAttribute("data-turn");
      return turnRole === "user" || turnRole === "assistant" ? turnRole : null;
    };
    const renderRecord = (id) => {
      const record = records.get(id);
      const elements = elementsById.get(id);
      if (!record || !elements)
        return;
      for (const element of [...elements]) {
        if (!element.isConnected) {
          elements.delete(element);
          continue;
        }
        const role = roleForElement(element) ?? record.role;
        if (role !== "user" && role !== "assistant")
          continue;
        if (record.createdAtMs == null && !record.modelSlug)
          continue;
        ensureStyles();
        let host = [...element.children].find((child) => child instanceof pageWindow.HTMLElement && child.dataset.chatgptMessageMetadata === "true");
        if (!host) {
          host = pageWindow.document.createElement("div");
          host.dataset.chatgptMessageMetadata = "true";
          const delivery = [...element.children].find((child) => child instanceof pageWindow.HTMLElement && child.dataset.chatgptDeliveryStatus === "true");
          element.insertBefore(host, delivery ?? null);
        }
        const fingerprint = [
          role,
          record.createdAtMs ?? "",
          record.timeSource ?? "",
          record.modelSlug ?? "",
          record.modelSource ?? ""
        ].join("|");
        if (host.dataset.chatgptMessageMetadataFingerprint === fingerprint)
          continue;
        host.dataset.chatgptMessageMetadataFingerprint = fingerprint;
        host.dataset.chatgptMessageMetadataRole = role;
        host.dataset.chatgptMessageMetadataTimeSource = record.timeSource ?? "";
        host.dataset.chatgptMessageMetadataModelSource = record.modelSource ?? "";
        host.replaceChildren();
        const labels = [];
        if (record.createdAtMs != null) {
          const timeWrap = pageWindow.document.createElement("span");
          timeWrap.dataset.chatgptMessageTime = "true";
          const time = pageWindow.document.createElement("time");
          const formatted = formatDate(record.createdAtMs);
          time.dateTime = new Date(record.createdAtMs).toISOString();
          time.textContent = formatted;
          labels.push(`${record.timeSource === "server" ? "服务器创建时间" : "本地发送时间"} ${formatted}`);
          timeWrap.append(time);
          host.append(timeWrap);
        }
        if (record.createdAtMs != null && record.modelSlug) {
          const separator = pageWindow.document.createElement("span");
          separator.setAttribute("aria-hidden", "true");
          separator.textContent = "·";
          host.append(separator);
        }
        if (record.modelSlug) {
          const model = pageWindow.document.createElement("span");
          model.dataset.chatgptMessageModel = record.modelSlug;
          model.textContent = friendlyModelLabel(record.modelSlug);
          host.append(model);
          const sourceLabel = record.modelSource === "resolved" ? "解析后的有效模型" : record.modelSource === "message" ? "消息记录模型" : record.modelSource === "inferred" ? "由当前回复推断" : "请求选择模型";
          labels.push(`${sourceLabel} ${record.modelSlug}`);
        }
        host.setAttribute("aria-label", labels.join("，"));
        host.title = labels.join(`
`);
      }
      if (elements.size === 0)
        elementsById.delete(id);
    };
    const registerCandidate = (candidate) => {
      const roleElement = candidate.matches("[data-message-author-role]") ? candidate : candidate.closest("[data-message-author-role]") ?? candidate.querySelector("[data-message-author-role]");
      const idElement = roleElement?.hasAttribute("data-message-id") ? roleElement : candidate.hasAttribute("data-message-id") ? candidate : roleElement?.querySelector("[data-message-id]") ?? candidate.closest("[data-message-id]") ?? candidate.querySelector("[data-message-id]");
      const host = roleElement ?? idElement;
      const id = idElement?.getAttribute("data-message-id");
      if (!host || !id || !roleForElement(host))
        return;
      const elements = elementsById.get(id) ?? new Set;
      elements.add(host);
      elementsById.set(id, elements);
      renderRecord(id);
    };
    const scanRoot = (root) => {
      const candidates = new Set([root]);
      const closest = root.closest("[data-message-author-role], [data-message-id]");
      if (closest)
        candidates.add(closest);
      for (const element of root.querySelectorAll("[data-message-author-role], [data-message-id]")) {
        candidates.add(element);
      }
      for (const candidate of candidates)
        registerCandidate(candidate);
    };
    const scheduleScan = (root = pageWindow.document.documentElement) => {
      pendingScanRoots.add(root);
      if (scanFrame != null)
        return;
      const run = () => {
        scanFrame = undefined;
        const roots = [...pendingScanRoots];
        pendingScanRoots.clear();
        for (const pendingRoot of roots) {
          if (pendingRoot.isConnected)
            scanRoot(pendingRoot);
        }
      };
      scanFrame = typeof pageWindow.requestAnimationFrame === "function" ? pageWindow.requestAnimationFrame(run) : pageWindow.setTimeout(run, 0);
    };
    const mergeRecord = (id, next) => {
      if (!id)
        return false;
      const record = records.get(id) ?? { id, timeRank: 0, modelRank: 0 };
      let changed = false;
      if ((next.role === "user" || next.role === "assistant") && record.role !== next.role) {
        record.role = next.role;
        changed = true;
      }
      if (next.createdAtMs != null && Number.isFinite(next.createdAtMs) && (next.timeRank ?? 0) >= record.timeRank && (record.createdAtMs !== next.createdAtMs || record.timeSource !== next.timeSource)) {
        record.createdAtMs = next.createdAtMs;
        record.timeSource = next.timeSource;
        record.timeRank = next.timeRank ?? 0;
        changed = true;
      }
      if (next.modelSlug && (next.modelRank ?? 0) >= record.modelRank && (record.modelSlug !== next.modelSlug || record.modelSource !== next.modelSource)) {
        record.modelSlug = next.modelSlug;
        record.modelSource = next.modelSource;
        record.modelRank = next.modelRank ?? 0;
        changed = true;
      }
      if (!changed)
        return false;
      records.delete(id);
      records.set(id, record);
      while (records.size > 20000) {
        const oldest = records.keys().next().value;
        if (typeof oldest !== "string")
          break;
        records.delete(oldest);
        elementsById.delete(oldest);
      }
      renderRecord(id);
      return true;
    };
    const ingestMessage = (message) => {
      const id = nonEmptyString(message.id);
      const role = message.author?.role;
      if (!id || role !== "user" && role !== "assistant")
        return;
      const model = effectiveMessageModel(message);
      mergeRecord(id, {
        role,
        createdAtMs: chatgptTimestampMs(message.create_time),
        timeSource: "server",
        timeRank: chatgptTimestampMs(message.create_time) == null ? 0 : 2,
        modelSlug: model?.slug,
        modelSource: model?.source,
        modelRank: model?.source === "resolved" ? 4 : model?.source === "message" ? 3 : 1
      });
    };
    const ingestMessages = (messages) => {
      for (const message of messages)
        ingestMessage(message);
      let userId = null;
      for (const message of messages) {
        if (message.author?.role === "user") {
          userId = nonEmptyString(message.id);
          continue;
        }
        if (!userId || !isVisibleAssistantForMetadata(message))
          continue;
        const model = effectiveMessageModel(message);
        if (!model)
          continue;
        mergeRecord(userId, {
          modelSlug: model.slug,
          modelSource: "inferred",
          modelRank: 2
        });
      }
    };
    const ingestPayload = (payload) => {
      const value = recordFromUnknown(payload);
      if (!value)
        return;
      let ingested = false;
      const directMessage = recordFromUnknown(value.message);
      if (directMessage) {
        ingestMessages([directMessage]);
        ingested = true;
      }
      if (Array.isArray(value.messages)) {
        const messages = value.messages.map(recordFromUnknown).filter((message) => message != null);
        ingestMessages(messages);
        ingested = ingested || messages.length > 0;
      }
      const mapping = recordFromUnknown(value.mapping);
      if (mapping) {
        const allMessages = Object.values(mapping).map(recordFromUnknown).map((node) => recordFromUnknown(node?.message)).filter((message) => message != null);
        for (const message of allMessages)
          ingestMessage(message);
        const path = [];
        const seen = new Set;
        let nodeId = nonEmptyString(value.current_node);
        while (nodeId && !seen.has(nodeId)) {
          seen.add(nodeId);
          const node = recordFromUnknown(mapping[nodeId]);
          const message = recordFromUnknown(node?.message);
          if (message)
            path.push(message);
          nodeId = nonEmptyString(node?.parent);
        }
        ingestMessages(path.reverse());
        ingested = ingested || allMessages.length > 0;
      }
      const nestedConversation = recordFromUnknown(value.conversation);
      if (nestedConversation && nestedConversation !== value) {
        ingestPayload(nestedConversation);
      }
      if (ingested) {
        const root = pageWindow.document.documentElement;
        root.dataset.chatgptMessageMetadataRecords = String(records.size);
        scheduleScan();
      }
    };
    const noteOutgoing = (probe) => {
      if (!probe.hasUserMessage || !probe.messageId)
        return;
      mergeRecord(probe.messageId, {
        role: "user",
        createdAtMs: probe.createdAtMs ?? Date.now(),
        timeSource: "client",
        timeRank: 1,
        modelSlug: probe.requestedModelSlug ?? undefined,
        modelSource: probe.requestedModelSlug ? "requested" : undefined,
        modelRank: probe.requestedModelSlug ? 1 : 0
      });
      pageWindow.document.documentElement.dataset.chatgptOutgoingMessageMetadata = "captured";
      scheduleScan();
    };
    const observeResponse = (response) => {
      if (!response.ok)
        return;
      let clone;
      try {
        clone = response.clone();
      } catch {
        return;
      }
      const contentType = clone.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        const root = pageWindow.document.documentElement;
        root.dataset.chatgptMessageMetadataStreams = String(Number(root.dataset.chatgptMessageMetadataStreams ?? "0") + 1);
        (async () => {
          const reader = clone.body?.getReader();
          if (!reader)
            return;
          const decoder = new pageWindow.TextDecoder;
          const completeIds = new Set;
          const parseAttempts = new Map;
          let buffer = "";
          const processBlock = (block) => {
            const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join(`
`).trim();
            if (!data)
              return false;
            if (data === "[DONE]")
              return true;
            if (!data.includes('"message"') && !data.includes('"messages"') && !data.includes('"author"')) {
              return false;
            }
            const messageOffset = data.indexOf('"message"');
            const idProbe = (messageOffset >= 0 ? data.slice(messageOffset) : data).slice(0, 4096).match(/"id"\s*:\s*"([^"\\]+)"/);
            const candidateId = idProbe?.[1] ?? "unknown";
            if (completeIds.has(candidateId))
              return false;
            const attempts = parseAttempts.get(candidateId) ?? 0;
            if (attempts >= 4)
              return false;
            parseAttempts.set(candidateId, attempts + 1);
            try {
              ingestPayload(JSON.parse(data));
              if (candidateId !== "unknown") {
                const record = records.get(candidateId);
                if (record?.createdAtMs != null && record.modelSlug) {
                  completeIds.add(candidateId);
                }
              }
            } catch {}
            return false;
          };
          try {
            for (;; ) {
              const chunk = await reader.read();
              if (chunk.done)
                break;
              buffer += decoder.decode(chunk.value, { stream: true });
              for (;; ) {
                const boundary = /\r?\n\r?\n/.exec(buffer);
                if (!boundary)
                  break;
                const block = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary[0].length);
                if (processBlock(block)) {
                  await reader.cancel();
                  return;
                }
              }
            }
            buffer += decoder.decode();
            if (buffer)
              processBlock(buffer);
          } catch {}
        })();
        return;
      }
      if (contentType.includes("json")) {
        clone.json().then(ingestPayload).catch(() => {
          return;
        });
      }
    };
    const observer = new pageWindow.MutationObserver((records) => {
      for (const mutation of records) {
        if (mutation.type === "attributes") {
          if (mutation.target instanceof pageWindow.Element) {
            scheduleScan(mutation.target);
          }
          continue;
        }
        for (const node of mutation.removedNodes) {
          if (!(node instanceof pageWindow.Element) || node.isConnected)
            continue;
          const candidates = [node, ...node.querySelectorAll("[data-message-id]")];
          for (const candidate of candidates) {
            const id = candidate.getAttribute("data-message-id");
            if (!id)
              continue;
            const elements = elementsById.get(id);
            if (!elements)
              continue;
            for (const element of elements)
              if (!element.isConnected)
                elements.delete(element);
            if (elements.size === 0)
              elementsById.delete(id);
          }
        }
        for (const node of mutation.addedNodes) {
          if (node instanceof pageWindow.Element)
            scheduleScan(node);
        }
      }
    });
    observer.observe(pageWindow.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-message-id", "data-message-author-role", "data-turn"],
      childList: true,
      subtree: true
    });
    ensureStyles();
    scheduleScan();
    pageWindow.document.documentElement.dataset.chatgptMessageMetadataDisplay = "enabled";
    return { ingestPayload, noteOutgoing, observeResponse };
  }
  function installDeliveryVerifier(pageWindow) {
    let sequence = 0;
    let hideTimer;
    const normalize = (text) => text.replace(/\s+/g, " ").trim();
    let visualState = null;
    const ensureStyles = () => {
      const id = "chatgpt-delivery-status-style";
      if (pageWindow.document.getElementById(id))
        return;
      const style = pageWindow.document.createElement("style");
      style.id = id;
      style.textContent = `
@keyframes chatgptDeliverySpin { to { transform: rotate(360deg); } }
[data-chatgpt-delivery-status="true"] {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  min-height: 16px;
  font: 500 11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  color: var(--text-secondary, currentColor);
  opacity: .72;
}
[data-chatgpt-delivery-status="true"] .chatgpt-delivery-spinner {
  width: 11px;
  height: 11px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 999px;
  animation: chatgptDeliverySpin .75s linear infinite;
}
[data-chatgpt-delivery-status="true"] button {
  margin-left: 3px;
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}`;
      (pageWindow.document.head ?? pageWindow.document.documentElement).append(style);
    };
    const findMessageElement = (probe) => {
      const userMessages = [
        ...pageWindow.document.querySelectorAll('[data-message-author-role="user"]')
      ];
      if (probe.messageId) {
        const exact = userMessages.find((element) => element.getAttribute("data-message-id") === probe.messageId);
        if (exact)
          return exact;
      }
      if (!probe.text)
        return null;
      const expected = normalize(probe.text);
      if (!expected)
        return null;
      for (let index = userMessages.length - 1;index >= 0; index -= 1) {
        const text = normalize(userMessages[index].textContent ?? "");
        if (text === expected || text.includes(expected))
          return userMessages[index];
      }
      return null;
    };
    const turnContainerFor = (message) => {
      return message.closest('[data-turn="user"], [data-testid^="conversation-turn-"]') ?? message;
    };
    const renderVisualState = () => {
      const state = visualState;
      if (!state)
        return;
      const message = findMessageElement(state.probe);
      if (!message)
        return;
      ensureStyles();
      let host = message.querySelector('[data-chatgpt-delivery-status="true"]');
      if (!host) {
        host = pageWindow.document.createElement("div");
        host.dataset.chatgptDeliveryStatus = "true";
        host.setAttribute("role", "status");
        host.setAttribute("aria-live", "polite");
        message.append(host);
      }
      if (host.dataset.chatgptDeliveryStage === state.stage && host.dataset.chatgptDeliveryLabel === state.label) {
        return;
      }
      host.dataset.chatgptDeliveryStage = state.stage;
      host.dataset.chatgptDeliveryLabel = state.label;
      host.title = state.title;
      host.replaceChildren();
      const icon = pageWindow.document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      if (state.stage === "sending" || state.stage === "verifying") {
        icon.className = "chatgpt-delivery-spinner";
      } else {
        icon.textContent = state.stage === "saved" || state.stage === "sent" ? "✓" : "!";
        icon.style.cssText = "font-weight:700;line-height:1";
      }
      const label = pageWindow.document.createElement("span");
      label.textContent = state.label;
      host.append(icon, label);
      if (state.copy && state.probe.text) {
        const button = pageWindow.document.createElement("button");
        button.type = "button";
        button.textContent = "复制原消息";
        button.addEventListener("click", () => {
          pageWindow.navigator.clipboard?.writeText(state.probe.text ?? "");
        });
        host.append(button);
      }
    };
    const setVisualState = (probe, stage, label, title, copy = false, autoHideMs = 0) => {
      if (hideTimer != null) {
        pageWindow.clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      visualState = { probe, stage, label, title, copy };
      renderVisualState();
      if (autoHideMs > 0) {
        const expectedMessageId = probe.messageId;
        hideTimer = pageWindow.setTimeout(() => {
          const current = visualState;
          if (!current || current.probe.messageId !== expectedMessageId)
            return;
          const message = findMessageElement(current.probe);
          message?.querySelector('[data-chatgpt-delivery-status="true"]')?.remove();
          visualState = null;
        }, autoHideMs);
      }
    };
    const hasAssistantResponseAfter = (probe) => {
      const message = findMessageElement(probe);
      if (!message)
        return false;
      const anchor = turnContainerFor(message);
      const assistants = pageWindow.document.querySelectorAll('[data-turn="assistant"], .agent-turn, [data-message-author-role="assistant"]');
      for (const assistant of assistants) {
        if (anchor.contains(assistant))
          continue;
        if ((anchor.compareDocumentPosition(assistant) & pageWindow.Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
          return true;
        }
      }
      return false;
    };
    const confirmFromAssistantResponse = (probe, token) => {
      if (token !== sequence || !hasAssistantResponseAfter(probe))
        return false;
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptLastSendVerified = "true";
      if (root.dataset.chatgptLastSendEvidence !== "assistant-turn") {
        root.dataset.chatgptLastSendEvidence = "assistant-turn";
        setVisualState(probe, "sent", "已发送", "AI 已开始回复，这条消息已成功发送", false, 2500);
      }
      return true;
    };
    const domObserver = new pageWindow.MutationObserver(() => {
      renderVisualState();
      const state = visualState;
      if (state && (state.stage === "sending" || state.stage === "verifying" || state.stage === "sent")) {
        confirmFromAssistantResponse(state.probe, sequence);
      }
    });
    const observeTarget = pageWindow.document.body ?? pageWindow.document.documentElement;
    if (observeTarget) {
      domObserver.observe(observeTarget, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-turn", "data-message-author-role"]
      });
    }
    return {
      begin: (probe) => {
        if (!probe.hasUserMessage)
          return;
        sequence += 1;
        const root = pageWindow.document.documentElement;
        root.dataset.chatgptLastSendVerified = "pending";
        root.dataset.chatgptLastSendEvidence = "request-started";
        root.dataset.chatgptDeliveryTrackedSends = String(Number(root.dataset.chatgptDeliveryTrackedSends ?? "0") + 1);
        setVisualState(probe, "sending", "发送中", "正在发送消息");
      },
      accepted: (probe) => {
        if (!probe.hasUserMessage)
          return;
        const token = sequence;
        const root = pageWindow.document.documentElement;
        root.dataset.chatgptLastSendVerified = "true";
        root.dataset.chatgptLastSendEvidence = "http-accepted";
        setVisualState(probe, "sent", "已发送", "发送请求已被服务器接受", false, 2500);
        confirmFromAssistantResponse(probe, token);
      },
      failed: (probe, message) => {
        if (!probe.hasUserMessage)
          return;
        sequence += 1;
        pageWindow.document.documentElement.dataset.chatgptLastSendVerified = "false";
        setVisualState(probe, "failed", "发送失败", `发送失败：${message}`, Boolean(probe.text));
      }
    };
  }
  function addVirtualizationCss(pageWindow) {
    const id = "chatgpt-performance-fix-style";
    if (pageWindow.document.getElementById(id))
      return;
    const style = pageWindow.document.createElement("style");
    style.id = id;
    style.textContent = `
/* Whole-message virtualization is intentionally disabled. True lazy history
   keeps the DOM small, while message-level content-visibility:auto caused the
   entire message to switch from an intrinsic placeholder after it was visible. */
html[data-chatgpt-performance-fix="large"] [data-message-id] {
  content-visibility: visible;
  contain-intrinsic-size: none;
}`;
    const mount = pageWindow.document.head ?? pageWindow.document.documentElement;
    mount?.append(style);
  }
  var staticCodeBlocks = new Map;
  var staticCodeHydrated = new WeakSet;
  var staticCodeFillQueue = [];
  var staticCodeFillHandle = null;
  var staticCodeHydratorInstalled = false;
  function scheduleStaticCodeFill(pageWindow) {
    if (staticCodeFillHandle != null)
      return;
    const drain = (deadline) => {
      staticCodeFillHandle = null;
      let filled = 0;
      while (staticCodeFillQueue.length > 0 && filled < 2) {
        if (deadline && deadline.timeRemaining() < 8)
          break;
        const item = staticCodeFillQueue.shift();
        if (!item.container.isConnected)
          continue;
        item.code.textContent = item.block.code;
        item.copy.disabled = false;
        item.container.dataset.chatgptStaticCodeState = "ready";
        filled += 1;
      }
      if (staticCodeFillQueue.length > 0)
        scheduleStaticCodeFill(pageWindow);
    };
    if (typeof pageWindow.requestIdleCallback === "function") {
      staticCodeFillHandle = pageWindow.requestIdleCallback(drain);
    } else {
      staticCodeFillHandle = pageWindow.requestAnimationFrame(() => drain());
    }
  }
  function staticCodeToken(anchor) {
    try {
      const url = new URL(anchor.href);
      if (url.origin !== "https://chatgpt.com")
        return null;
      const params = new URLSearchParams(url.hash.slice(1));
      return params.get("cgptperf-code");
    } catch {
      return null;
    }
  }
  var STATIC_CODE_MARKER_RE = /\[代码块\]\(https:\/\/chatgpt\.com\/#cgptperf-code=([^&\s)]+)&lines=\d+\)/g;
  function restoreStaticCodeMarkdown(text) {
    if (!text.includes("#cgptperf-code="))
      return text;
    return text.replace(STATIC_CODE_MARKER_RE, (full, token) => {
      const block = staticCodeBlocks.get(token);
      if (!block)
        return full;
      const fence = block.code.includes("```") ? "````" : "```";
      const language = block.language ? block.language : "";
      return `${fence}${language}
${block.code}
${fence}`;
    });
  }
  function restoreStaticCodeTextarea(pageWindow, textarea) {
    if (!textarea.value.includes("#cgptperf-code="))
      return;
    const restored = restoreStaticCodeMarkdown(textarea.value);
    if (restored === textarea.value)
      return;
    const setter = Object.getOwnPropertyDescriptor(pageWindow.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, restored);
    textarea.dispatchEvent(new pageWindow.InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: null
    }));
  }
  function restoreStaticCodeRequestInit(init) {
    if (!init || typeof init.body !== "string" || !init.body.includes("#cgptperf-code=")) {
      return init;
    }
    const body = restoreStaticCodeMarkdown(init.body);
    return body === init.body ? init : { ...init, body };
  }
  function hydrateStaticCodeAnchor(pageWindow, anchor) {
    if (staticCodeHydrated.has(anchor))
      return;
    const token = staticCodeToken(anchor);
    const block = token ? staticCodeBlocks.get(token) : undefined;
    if (!token || !block)
      return;
    staticCodeHydrated.add(anchor);
    const lineHeight = 20;
    const collapsedHeight = Math.min(420, Math.max(92, block.lineCount * lineHeight + 44));
    const container = pageWindow.document.createElement("div");
    container.dataset.chatgptStaticCode = token;
    container.dataset.chatgptStaticCodeState = "loading";
    container.style.height = `${collapsedHeight}px`;
    const header = pageWindow.document.createElement("div");
    header.dataset.chatgptStaticCodeHeader = "true";
    const label = pageWindow.document.createElement("span");
    label.textContent = block.language || "code";
    const actions = pageWindow.document.createElement("span");
    actions.dataset.chatgptStaticCodeActions = "true";
    const expand = pageWindow.document.createElement("button");
    expand.type = "button";
    expand.textContent = "展开";
    expand.addEventListener("click", () => {
      const expanded = container.dataset.chatgptStaticCodeExpanded === "true";
      container.dataset.chatgptStaticCodeExpanded = expanded ? "false" : "true";
      container.style.height = expanded ? `${collapsedHeight}px` : "auto";
      expand.textContent = expanded ? "展开" : "收起";
    });
    const copy = pageWindow.document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.disabled = true;
    copy.addEventListener("click", async () => {
      try {
        await pageWindow.navigator.clipboard.writeText(block.code);
        copy.textContent = "已复制";
        pageWindow.setTimeout(() => copy.textContent = "复制", 1200);
      } catch {
        copy.textContent = "复制失败";
        pageWindow.setTimeout(() => copy.textContent = "复制", 1200);
      }
    });
    actions.append(expand, copy);
    header.append(label, actions);
    const pre = pageWindow.document.createElement("pre");
    const code = pageWindow.document.createElement("code");
    code.textContent = "";
    pre.append(code);
    container.append(header, pre);
    const replaceTarget = anchor.parentElement?.tagName === "P" && anchor.parentElement.childNodes.length === 1 ? anchor.parentElement : anchor;
    replaceTarget.replaceWith(container);
    const rect = container.getBoundingClientRect();
    if (rect.bottom >= 0 && rect.top <= pageWindow.innerHeight) {
      code.textContent = block.code;
      copy.disabled = false;
      container.dataset.chatgptStaticCodeState = "ready";
    } else {
      staticCodeFillQueue.push({ block, container, code, copy });
      scheduleStaticCodeFill(pageWindow);
    }
  }
  function scanStaticCodeMarkers(pageWindow, node) {
    if (!(node instanceof pageWindow.Element))
      return;
    const messageScope = node.matches("[data-message-id]") || node.closest("[data-message-id]") ? node : node.querySelector("[data-message-id]");
    if (!messageScope)
      return;
    if (node instanceof pageWindow.HTMLTextAreaElement) {
      restoreStaticCodeTextarea(pageWindow, node);
    }
    if (node instanceof pageWindow.HTMLAnchorElement) {
      hydrateStaticCodeAnchor(pageWindow, node);
    }
    for (const textarea of node.querySelectorAll("textarea")) {
      restoreStaticCodeTextarea(pageWindow, textarea);
    }
    for (const anchor of node.querySelectorAll('a[href^="https://chatgpt.com/#cgptperf-code="]')) {
      hydrateStaticCodeAnchor(pageWindow, anchor);
    }
  }
  function installStaticCodeHydrator(pageWindow) {
    if (staticCodeHydratorInstalled)
      return;
    staticCodeHydratorInstalled = true;
    const root = pageWindow.document.documentElement;
    if (!root)
      return;
    scanStaticCodeMarkers(pageWindow, root);
    const observer = new pageWindow.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes)
          scanStaticCodeMarkers(pageWindow, node);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }
  function registerStaticCodeBlocks(pageWindow, blocks) {
    if (!blocks?.length)
      return;
    for (const block of blocks)
      staticCodeBlocks.set(block.token, block);
    while (staticCodeBlocks.size > 1024) {
      const oldest = staticCodeBlocks.keys().next().value;
      if (typeof oldest !== "string")
        break;
      staticCodeBlocks.delete(oldest);
    }
    installStaticCodeHydrator(pageWindow);
    scanStaticCodeMarkers(pageWindow, pageWindow.document.documentElement);
  }
  function installRichTextPerformanceFix(pageWindow, warmDistancePx, editorWarmDistancePx) {
    const marker = "__chatgptRichTextPerformanceFixInstalled";
    if (Reflect.get(pageWindow, marker))
      return;
    Reflect.set(pageWindow, marker, true);
    const smoothedMarkdownSourceHints = new Set(["/2afb55f3-"]);
    try {
      let visibilityOwner = pageWindow.Document?.prototype ?? null;
      let visibilityDescriptor;
      while (visibilityOwner) {
        visibilityDescriptor = Object.getOwnPropertyDescriptor(visibilityOwner, "visibilityState");
        if (visibilityDescriptor)
          break;
        visibilityOwner = Object.getPrototypeOf(visibilityOwner);
      }
      const nativeVisibilityGet = visibilityDescriptor?.get;
      if (visibilityOwner && nativeVisibilityGet && visibilityDescriptor?.configurable !== false) {
        Object.defineProperty(visibilityOwner, "visibilityState", {
          configurable: true,
          enumerable: visibilityDescriptor.enumerable ?? true,
          get() {
            const actual = nativeVisibilityGet.call(this);
            if (this === pageWindow.document && actual !== "hidden") {
              const stack = new Error().stack ?? "";
              if ([...smoothedMarkdownSourceHints].some((hint) => stack.includes(hint))) {
                pageWindow.document.documentElement.dataset.chatgptSmoothedMarkdownBypass = "enabled";
                return "hidden";
              }
            }
            return actual;
          }
        });
      }
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not bypass markdown smoothing`, error);
    }
    const styleId = "chatgpt-rich-text-performance-fix-style";
    if (!pageWindow.document.getElementById(styleId)) {
      const style = pageWindow.document.createElement("style");
      style.id = styleId;
      style.textContent = `
/* ChatGPT's SmoothedMarkdown starts code blocks at height:0/opacity:0 and
   measures every block with a ResizeObserver. For code-heavy replies that turns
   into a wall of empty bars followed by one huge layout/paint burst. */
html [class*="SmoothedCodeBlock"][data-animate-height] {
  height: auto !important;
  min-height: 3.25rem;
  opacity: 1 !important;
  transition: none !important;
}
html [class*="SmoothedCodeBlock"] [class*="ClipText"] {
  height: auto !important;
  overflow: visible !important;
  transition: none !important;
}
html [class*="SmoothedCodeBlock"] [class*="SmoothingOverlay"],
html [class*="SmoothedCodeBlock"] [class*="FixedSmoothingOverlay"] {
  display: none !important;
}

/* Heavy rich-text descendants are explicitly pre-rendered well before they
   enter the viewport. Unlike content-visibility:auto, this prevents the browser
   from waiting until the block is already visible before materializing it. */
html [data-chatgpt-rich-block-state="cold"],
html [class*="_codemirror"][data-chatgpt-rich-editor-state="cold"] {
  content-visibility: auto !important;
  contain-intrinsic-size: var(--chatgpt-rich-intrinsic-size, 180px) !important;
}
html [data-chatgpt-rich-block-state="hot"],
html [class*="_codemirror"][data-chatgpt-rich-editor-state="hot"] {
  content-visibility: visible !important;
  contain-intrinsic-size: auto var(--chatgpt-rich-intrinsic-size, 180px) !important;
}
html [class*="_codemirror"][data-chatgpt-rich-editor-state="cold"] {
  min-height: 5rem;
}

html [data-chatgpt-static-code] {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 92px;
  overflow: hidden;
  border: 1px solid rgba(127, 127, 127, .22);
  border-radius: 10px;
  background: var(--main-surface-secondary, rgba(127, 127, 127, .08));
  margin: .75rem 0;
}
html [data-chatgpt-static-code-header] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(127, 127, 127, .18);
  font: 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
}
html [data-chatgpt-static-code-actions] {
  display: inline-flex;
  gap: 6px;
}
html [data-chatgpt-static-code] button {
  appearance: none;
  border: 0;
  border-radius: 6px;
  padding: 4px 7px;
  background: rgba(127, 127, 127, .14);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
html [data-chatgpt-static-code] button:disabled {
  opacity: .45;
  cursor: default;
}
html [data-chatgpt-static-code] pre {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 12px;
  overflow: auto;
  white-space: pre;
  tab-size: 2;
  font: 12px/20px ui-monospace, SFMono-Regular, Menlo, monospace;
}
html [data-chatgpt-static-code-state="loading"] pre {
  background: linear-gradient(90deg, transparent, rgba(127,127,127,.08), transparent);
}

@media print {
  html [class*="SmoothedCodeBlock"],
  html [class*="_codemirror"],
  html .markdown table,
  html [class*="MarkdownContent"] table,
  html .katex-display,
  html [data-code-block-preview-pane] {
    content-visibility: visible;
    contain-intrinsic-size: none;
  }
}`;
      const mount = pageWindow.document.head ?? pageWindow.document.documentElement;
      mount?.append(style);
    }
    const NativeResizeObserver = pageWindow.ResizeObserver;
    if (typeof NativeResizeObserver !== "function")
      return;
    const isSmoothedCodeMeasurement = (target) => {
      if (!(target instanceof pageWindow.Element))
        return false;
      if (target.tagName !== "SPAN" || !target.classList.contains("block")) {
        return false;
      }
      const clip = target.parentElement;
      return Boolean(clip && Array.from(clip.classList).some((name) => name.includes("ClipText")) && clip.closest('[class*="SmoothedCodeBlock"]'));
    };

    class RichTextResizeObserver {
      native;
      skipped = new Set;
      deferredCodeMirrorTargets = new Map;
      constructor(callback) {
        this.native = new NativeResizeObserver((entries) => callback(entries, this));
      }
      observe(target, options) {
        if (isSmoothedCodeMeasurement(target)) {
          this.skipped.add(target);
          const stack = new Error().stack ?? "";
          for (const match of stack.matchAll(/https:\/\/[^/]+\/(?:cdn\/)?assets\/([^/:]+\.js)/g)) {
            const filename = match[1];
            if (!filename || filename.includes("performance-fix"))
              continue;
            const hint = `/${filename.split("-")[0]}-`;
            smoothedMarkdownSourceHints.add(hint);
          }
          const root = pageWindow.document.documentElement;
          root.dataset.chatgptSmoothedMarkdownSourceCount = String(smoothedMarkdownSourceHints.size);
          const count = Number(root.dataset.chatgptRichTextSkippedResizeObservers ?? "0");
          root.dataset.chatgptRichTextSkippedResizeObservers = String(count + 1);
          return;
        }
        const container = findConversationCodeMirrorContainer(pageWindow, target);
        if (container && container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
          if (this.deferredCodeMirrorTargets.has(target))
            return;
          const attributeObserver = new pageWindow.MutationObserver(() => {
            if (container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
              return;
            }
            attributeObserver.disconnect();
            this.deferredCodeMirrorTargets.delete(target);
            this.native.observe(target, options);
            const root = pageWindow.document.documentElement;
            const count = Number(root.dataset.chatgptCodeMirrorRoResumed ?? "0");
            root.dataset.chatgptCodeMirrorRoResumed = String(count + 1);
          });
          attributeObserver.observe(container, {
            attributes: true,
            attributeFilter: ["data-chatgpt-rich-editor-state"]
          });
          this.deferredCodeMirrorTargets.set(target, attributeObserver);
          const root = pageWindow.document.documentElement;
          const count = Number(root.dataset.chatgptCodeMirrorRoDeferred ?? "0");
          root.dataset.chatgptCodeMirrorRoDeferred = String(count + 1);
          return;
        }
        this.native.observe(target, options);
      }
      unobserve(target) {
        if (this.skipped.delete(target))
          return;
        this.deferredCodeMirrorTargets.get(target)?.disconnect();
        this.deferredCodeMirrorTargets.delete(target);
        this.native.unobserve(target);
      }
      disconnect() {
        this.skipped.clear();
        for (const observer of this.deferredCodeMirrorTargets.values()) {
          observer.disconnect();
        }
        this.deferredCodeMirrorTargets.clear();
        this.native.disconnect();
      }
    }
    try {
      Object.setPrototypeOf(RichTextResizeObserver.prototype, NativeResizeObserver.prototype);
      Object.setPrototypeOf(RichTextResizeObserver, NativeResizeObserver);
      Object.defineProperty(RichTextResizeObserver, "name", {
        value: "ResizeObserver"
      });
      Object.defineProperty(pageWindow, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: RichTextResizeObserver
      });
      pageWindow.document.documentElement.dataset.chatgptRichTextPerformanceFix = "enabled";
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not tune rich-text rendering`, error);
    }
    const isConversationCodeEditor = (element) => Array.from(element.classList).some((name) => name.includes("_codemirror")) && Boolean(element.closest('[data-message-id], [data-turn-key], .markdown, [data-markdown-text-style], [class*="MarkdownContent"], [class*="SmoothedMarkdown"]'));
    const RICH_BLOCK_SELECTOR = [
      '[class*="SmoothedCodeBlock"]',
      ".markdown table",
      "[data-markdown-text-style] table",
      '[class*="MarkdownContent"] table',
      ".katex-display",
      "[data-code-block-preview-pane]"
    ].join(",");
    const isRichBlock = (element) => element.matches(RICH_BLOCK_SELECTOR) && Boolean(element.closest('[data-message-id], [data-turn-key], .markdown, [data-markdown-text-style], [class*="MarkdownContent"], [class*="SmoothedMarkdown"]'));
    const intrinsicSizeFor = (element) => {
      if (Array.from(element.classList).some((name) => name.includes("SmoothedCodeBlock"))) {
        return 220;
      }
      if (element.matches("table"))
        return 240;
      if (element.matches(".katex-display"))
        return 96;
      if (element.matches("[data-code-block-preview-pane]"))
        return 360;
      return 180;
    };
    const activationQueue = [];
    const queued = new WeakSet;
    const coldElements = new Set;
    let activationFrame = null;
    let warmScanFrame = null;
    const incrementMetric = (name) => {
      const root = pageWindow.document.documentElement;
      const current = Number(root.dataset[name] ?? "0");
      root.dataset[name] = String(current + 1);
    };
    const activate = (item) => {
      queued.delete(item.element);
      if (!item.element.isConnected) {
        unobserveHeavyElement(item.element);
        return;
      }
      if (item.element.getAttribute(item.attribute) === "hot") {
        unobserveHeavyElement(item.element);
        return;
      }
      item.element.setAttribute(item.attribute, "hot");
      unobserveHeavyElement(item.element);
      incrementMetric(item.metric);
    };
    const drainActivationQueue = () => {
      activationFrame = null;
      let editorsActivated = 0;
      let blocksActivated = 0;
      for (let index = 0;index < activationQueue.length; ) {
        const item = activationQueue[index];
        const isEditor = item.attribute === "data-chatgpt-rich-editor-state";
        const allowed = isEditor ? editorsActivated < 1 : blocksActivated < 3;
        if (!allowed) {
          index += 1;
          continue;
        }
        activationQueue.splice(index, 1);
        activate(item);
        if (isEditor)
          editorsActivated += 1;
        else
          blocksActivated += 1;
        if (editorsActivated >= 1 && blocksActivated >= 3)
          break;
      }
      if (activationQueue.length > 0) {
        activationFrame = pageWindow.requestAnimationFrame(drainActivationQueue);
      }
    };
    const enqueueActivation = (item, distance = Number.POSITIVE_INFINITY) => {
      if (item.element.getAttribute(item.attribute) === "hot")
        return;
      if (queued.has(item.element))
        return;
      queued.add(item.element);
      activationQueue.push({ ...item, distance });
      activationQueue.sort((left, right) => (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY));
      if (activationFrame == null) {
        activationFrame = pageWindow.requestAnimationFrame(drainActivationQueue);
      }
    };
    const activationFor = (element) => {
      if (isConversationCodeEditor(element)) {
        return {
          element,
          attribute: "data-chatgpt-rich-editor-state",
          metric: "chatgptRichTextEditorsActivated"
        };
      }
      if (isRichBlock(element)) {
        return {
          element,
          attribute: "data-chatgpt-rich-block-state",
          metric: "chatgptRichTextBlocksActivated"
        };
      }
      return null;
    };
    const effectiveWarmDistance = Math.max(1500, Math.floor(warmDistancePx));
    const effectiveEditorWarmDistance = Math.max(800, Math.floor(editorWarmDistancePx));
    const NativeIntersectionObserver = pageWindow.IntersectionObserver;
    const makeWarmObserver = (distance) => {
      if (typeof NativeIntersectionObserver !== "function")
        return null;
      return new NativeIntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || !entry.target.isConnected)
            continue;
          const item = activationFor(entry.target);
          if (!item)
            continue;
          const rect = entry.boundingClientRect;
          const visible = rect.bottom >= 0 && rect.top <= pageWindow.innerHeight;
          if (visible)
            activate(item);
          else
            enqueueActivation(item, rect.top > pageWindow.innerHeight ? rect.top - pageWindow.innerHeight : Math.max(0, -rect.bottom));
        }
      }, { rootMargin: `${distance}px 0px` });
    };
    const blockObserver = makeWarmObserver(effectiveWarmDistance);
    const editorObserver = makeWarmObserver(effectiveEditorWarmDistance);
    const unobserveHeavyElement = (element) => {
      blockObserver?.unobserve(element);
      editorObserver?.unobserve(element);
      coldElements.delete(element);
    };
    const scanWarmDistance = () => {
      warmScanFrame = null;
      for (const element of [...coldElements]) {
        if (!element.isConnected) {
          coldElements.delete(element);
          continue;
        }
        const item = activationFor(element);
        if (!item || element.getAttribute(item.attribute) === "hot") {
          coldElements.delete(element);
          continue;
        }
        const rect = element.getBoundingClientRect();
        const itemWarmDistance = item.attribute === "data-chatgpt-rich-editor-state" ? effectiveEditorWarmDistance : effectiveWarmDistance;
        if (rect.bottom < -itemWarmDistance || rect.top > pageWindow.innerHeight + itemWarmDistance) {
          continue;
        }
        const visibleNow = rect.bottom >= 0 && rect.top <= pageWindow.innerHeight;
        if (visibleNow) {
          activate(item);
        } else {
          const distance = rect.top > pageWindow.innerHeight ? rect.top - pageWindow.innerHeight : Math.max(0, -rect.bottom);
          enqueueActivation(item, distance);
        }
      }
    };
    const scheduleWarmScan = () => {
      if (warmScanFrame != null)
        return;
      warmScanFrame = pageWindow.requestAnimationFrame(scanWarmDistance);
    };
    const registerHeavyElement = (element) => {
      const item = activationFor(element);
      if (!item || element.getAttribute(item.attribute) === "hot")
        return;
      if (element.hasAttribute(item.attribute)) {
        coldElements.add(element);
        const observer = item.attribute === "data-chatgpt-rich-editor-state" ? editorObserver : blockObserver;
        if (observer)
          observer.observe(element);
        else
          scheduleWarmScan();
        return;
      }
      const size = intrinsicSizeFor(element);
      element.style.setProperty("--chatgpt-rich-intrinsic-size", `${size}px`);
      element.setAttribute(item.attribute, "cold");
      coldElements.add(element);
      if (item.attribute === "data-chatgpt-rich-editor-state") {
        incrementMetric("chatgptRichTextEditorsCold");
      } else {
        incrementMetric("chatgptRichTextBlocksCold");
      }
      const observer = item.attribute === "data-chatgpt-rich-editor-state" ? editorObserver : blockObserver;
      if (observer)
        observer.observe(element);
      else
        scheduleWarmScan();
    };
    const releaseRemovedElements = (node) => {
      if (!(node instanceof pageWindow.Element) || node.isConnected)
        return;
      const selector = '[data-chatgpt-rich-editor-state="cold"], [data-chatgpt-rich-block-state="cold"]';
      const removed = [node, ...node.querySelectorAll(selector)];
      for (const element of removed) {
        if (!coldElements.has(element) || element.isConnected)
          continue;
        unobserveHeavyElement(element);
        queued.delete(element);
      }
      for (let index = activationQueue.length - 1;index >= 0; index -= 1) {
        if (!activationQueue[index].element.isConnected)
          activationQueue.splice(index, 1);
      }
    };
    const scanForHeavyElements = (node) => {
      if (!(node instanceof pageWindow.Element))
        return;
      registerHeavyElement(node);
      for (const element of node.querySelectorAll(`${RICH_BLOCK_SELECTOR},[class*="_codemirror"]`)) {
        registerHeavyElement(element);
      }
    };
    const root = pageWindow.document.documentElement;
    if (root) {
      root.dataset.chatgptRichVisibilityStrategy = blockObserver && editorObserver ? "intersection" : "geometry-fallback";
      root.dataset.chatgptRichTextWarmDistancePx = String(effectiveWarmDistance);
      root.dataset.chatgptCodeEditorWarmDistancePx = String(effectiveEditorWarmDistance);
      scanForHeavyElements(root);
      if (!blockObserver || !editorObserver) {
        pageWindow.addEventListener("scroll", scheduleWarmScan, { capture: true, passive: true });
        pageWindow.addEventListener("resize", scheduleWarmScan, { passive: true });
      }
      const mutationObserver = new pageWindow.MutationObserver((records) => {
        for (const record of records) {
          for (const removed of record.removedNodes)
            releaseRemovedElements(removed);
          for (const added of record.addedNodes)
            scanForHeavyElements(added);
        }
        if (!blockObserver || !editorObserver)
          scheduleWarmScan();
      });
      mutationObserver.observe(root, { childList: true, subtree: true });
      if (!blockObserver || !editorObserver)
        scheduleWarmScan();
    }
  }
  function showOptimizationToast(pageWindow, message, onLoadFull) {
    const id = "chatgpt-performance-fix-toast";
    const render = () => {
      if (!pageWindow.document.body || pageWindow.document.getElementById(id))
        return;
      const host = pageWindow.document.createElement("div");
      host.id = id;
      host.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
      ].join(";");
      const shadow = host.attachShadow({ mode: "open" });
      const panel = pageWindow.document.createElement("div");
      panel.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:10px",
        "padding:9px 11px",
        "border:1px solid rgba(127,127,127,.25)",
        "border-radius:12px",
        "background:rgba(24,24,24,.92)",
        "color:#fff",
        "box-shadow:0 8px 30px rgba(0,0,0,.24)",
        "backdrop-filter:blur(12px)"
      ].join(";");
      const text = pageWindow.document.createElement("span");
      text.textContent = message;
      const button = pageWindow.document.createElement("button");
      button.type = "button";
      button.textContent = "完整加载";
      button.style.cssText = [
        "appearance:none",
        "border:0",
        "border-radius:8px",
        "padding:5px 8px",
        "background:rgba(255,255,255,.14)",
        "color:inherit",
        "font:inherit",
        "cursor:pointer"
      ].join(";");
      button.addEventListener("click", onLoadFull);
      panel.append(text, button);
      shadow.append(panel);
      pageWindow.document.body.append(host);
      pageWindow.setTimeout(() => host.remove(), 8000);
    };
    if (pageWindow.document.body)
      render();
    else
      pageWindow.document.addEventListener("DOMContentLoaded", render, { once: true });
  }
  function cloneMaterializedResponse(pageWindow, response) {
    const clone = new pageWindow.Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    for (const [key, value] of [
      ["url", response.url],
      ["redirected", response.redirected],
      ["type", response.type]
    ]) {
      try {
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: false,
          value
        });
      } catch {}
    }
    return clone;
  }
  async function readResponseText(response) {
    INTERNAL_RESPONSE_READS.add(response);
    try {
      return await response.text();
    } finally {
      INTERNAL_RESPONSE_READS.delete(response);
    }
  }
  async function fingerprintResponseBody(pageWindow, body) {
    try {
      const encoded = new pageWindow.TextEncoder().encode(body);
      const digest = await pageWindow.crypto.subtle.digest("SHA-256", encoded);
      return `${body.length}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      const updateTime = body.match(/"update_time"\s*:\s*([^,}\n]+)/)?.[1] ?? "";
      const currentNode = body.match(/"current_node"\s*:\s*"([^"]+)"/)?.[1] ?? "";
      return `${body.length}:${updateTime}:${currentNode}:${body.slice(-256)}`;
    }
  }
  function cloneJsonPayload(pageWindow, payload, body) {
    try {
      return pageWindow.structuredClone(payload);
    } catch {
      return JSON.parse(body);
    }
  }
  function installLegacyResponseFallback(pageWindow, mode, observePayload) {
    const marker = "__chatgptPerformanceFixResponseFallback";
    const existing = Reflect.get(pageWindow, marker);
    if (existing?.clear)
      return { clear: existing.clear };
    const prototype = pageWindow.Response?.prototype;
    if (!prototype)
      return { clear: () => {
        return;
      } };
    const nativeJson = prototype.json;
    const nativeText = prototype.text;
    const perResponse = new WeakMap;
    const byUrl = new Map;
    const incrementMetric = (name) => {
      const root = pageWindow.document.documentElement;
      const current = Number(root.dataset[name] ?? "0");
      root.dataset[name] = String(current + 1);
    };
    const shouldHandle = (response) => {
      if (INTERNAL_RESPONSE_READS.has(response) || !response.ok || response.bodyUsed) {
        return false;
      }
      const match = matchConversationApiUrl(response.url, pageWindow.location.href);
      if (match?.kind !== "legacy-full")
        return false;
      try {
        const url = new pageWindow.URL(response.url, pageWindow.location.href);
        return !["1", "true"].includes(url.searchParams.get("include_full_conversation") ?? "");
      } catch {
        return false;
      }
    };
    const process = (response) => {
      const previous = perResponse.get(response);
      if (previous)
        return previous;
      const task = (async () => {
        const originalBody = await nativeText.call(response);
        const fingerprint = await fingerprintResponseBody(pageWindow, originalBody);
        const cached = byUrl.get(response.url);
        if (cached?.fingerprint === fingerprint) {
          incrementMetric("chatgptLegacyFallbackCacheHits");
          return cached;
        }
        let parsed = JSON.parse(originalBody);
        let body = originalBody;
        let stats;
        try {
          const result = optimizeConversationPayload(parsed, legacyOptimizerOptions(mode));
          stats = result.stats;
          if (result.stats.changed) {
            parsed = result.payload;
            body = JSON.stringify(result.payload);
            incrementMetric("chatgptLegacyFallbackOptimized");
            const root = pageWindow.document.documentElement;
            root.dataset.chatgptLegacyFallbackOriginalNodes = String(result.stats.originalNodes);
            root.dataset.chatgptLegacyFallbackKeptNodes = String(result.stats.keptNodes);
            root.dataset.chatgptPerformanceFix = "large";
          }
        } catch (error) {
          console.warn(`[${SCRIPT_NAME}] Legacy response fallback failed`, error);
        }
        observePayload?.(parsed);
        const value = { body, payload: parsed, fingerprint, stats };
        byUrl.set(response.url, value);
        while (byUrl.size > 8) {
          const oldest = byUrl.keys().next().value;
          if (typeof oldest !== "string")
            break;
          byUrl.delete(oldest);
        }
        return value;
      })();
      perResponse.set(response, task);
      return task;
    };
    const patchedJson = function() {
      if (!shouldHandle(this))
        return nativeJson.call(this);
      return process(this).then((value) => cloneJsonPayload(pageWindow, value.payload, value.body));
    };
    const patchedText = function() {
      if (!shouldHandle(this))
        return nativeText.call(this);
      return process(this).then((value) => value.body);
    };
    try {
      Object.defineProperty(patchedJson, "name", { value: "json" });
      Object.defineProperty(patchedText, "name", { value: "text" });
      Object.defineProperty(prototype, "json", {
        configurable: true,
        writable: true,
        value: patchedJson
      });
      Object.defineProperty(prototype, "text", {
        configurable: true,
        writable: true,
        value: patchedText
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not install response fallback`, error);
      return { clear: () => {
        return;
      } };
    }
    const controller = {
      clear: () => {
        byUrl.clear();
      }
    };
    Reflect.set(pageWindow, marker, controller);
    pageWindow.document.documentElement.dataset.chatgptResponseFallback = "enabled";
    return controller;
  }
  async function materializeAndOptimize(pageWindow, response, mode, exposedUrl = response.url, observePayload) {
    const originalBody = await readResponseText(response);
    let body = originalBody;
    let optimized = false;
    let cacheable = false;
    let activeConversation;
    let stats;
    if (response.ok) {
      try {
        const result = await optimizeLegacyOffMain(pageWindow, originalBody, MODE_OPTIONS[mode]);
        stats = result.stats;
        activeConversation = !isIdleConversation(result.payload);
        observePayload?.(result.payload);
        if (result.stats.changed) {
          body = JSON.stringify(result.payload);
          optimized = true;
          cacheable = !activeConversation;
        }
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] Conversation response was not optimized`, error);
      }
    }
    const headers = new pageWindow.Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (optimized && stats) {
      headers.set("x-chatgpt-performance-fix", `${stats.originalNodes}->${stats.keptNodes}`);
    }
    if (activeConversation != null) {
      headers.set("x-chatgpt-performance-fix-active", activeConversation ? "1" : "0");
    }
    return {
      body,
      headers: [...headers.entries()],
      status: response.status,
      statusText: response.statusText,
      url: exposedUrl,
      redirected: response.redirected,
      type: response.type,
      optimized,
      cacheable,
      activeConversation,
      stats,
      apiKind: "legacy-full"
    };
  }
  async function materializeAndOptimizePaginated(pageWindow, response, apiKind, mode, exposedUrl, requestWasClamped, createLocalCursor, workerJobToken, renderTurns = MODE_OPTIONS[mode].paginatedRenderTurns, observePayload) {
    const originalBody = await readResponseText(response);
    let body = originalBody;
    let optimized = requestWasClamped;
    let stats;
    let optimizedPayload;
    let cacheable = false;
    let activeConversation;
    let localPagePayloads = [];
    if (response.ok) {
      try {
        const result = workerJobToken ? await finishPaginatedWorkerJob(pageWindow, workerJobToken, apiKind, mode, renderTurns) : await optimizePaginatedOffMain(pageWindow, originalBody, apiKind, mode, renderTurns);
        stats = result.stats;
        cacheable = result.cacheable;
        activeConversation = result.active;
        optimizedPayload = result.payload;
        observePayload?.(result.payload);
        registerStaticCodeBlocks(pageWindow, result.codeBlocks);
        if (result.stats.changed || workerJobToken)
          optimized = true;
        const chunksNewestFirst = result.chunks;
        if (chunksNewestFirst.length > 1) {
          const originalPageInfo = result.payload.page_info && typeof result.payload.page_info === "object" ? { ...result.payload.page_info } : { has_previous_page: false, start_cursor: null };
          const localCursors = chunksNewestFirst.slice(1).map(() => createLocalCursor());
          optimizedPayload = {
            ...result.payload,
            messages: chunksNewestFirst[0],
            page_info: {
              ...originalPageInfo,
              has_previous_page: true,
              start_cursor: localCursors[0]
            }
          };
          localPagePayloads = chunksNewestFirst.slice(1).map((messages, index) => {
            const hasAnotherLocalPage = index + 1 < localCursors.length;
            return {
              cursor: localCursors[index],
              payload: {
                messages,
                page_info: hasAnotherLocalPage ? {
                  ...originalPageInfo,
                  has_previous_page: true,
                  start_cursor: localCursors[index + 1]
                } : originalPageInfo,
                safe_urls: result.payload.safe_urls ?? [],
                blocked_urls: result.payload.blocked_urls ?? []
              }
            };
          });
          optimized = true;
        }
        if (optimizedPayload)
          body = JSON.stringify(optimizedPayload);
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] Paginated response was not optimized`, error);
      }
    }
    const headers = new pageWindow.Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (stats) {
      headers.set("x-chatgpt-performance-fix-page", `${stats.originalMessages}->${stats.keptMessages}`);
    }
    headers.set("x-chatgpt-performance-fix-cacheable", cacheable ? "1" : "0");
    if (activeConversation != null) {
      headers.set("x-chatgpt-performance-fix-active", activeConversation ? "1" : "0");
    }
    const responseHeaders = [...headers.entries()];
    const localPages = localPagePayloads.map(({ cursor, payload }, index) => {
      const localHeaders = new pageWindow.Headers(responseHeaders);
      localHeaders.set("x-chatgpt-performance-fix-local-page", `${index + 1}/${localPagePayloads.length}`);
      return {
        cursor,
        response: {
          body: JSON.stringify(payload),
          headers: [...localHeaders.entries()],
          status: response.status,
          statusText: response.statusText,
          url: "",
          redirected: false,
          type: response.type,
          optimized: true,
          cacheable: false,
          activeConversation: false,
          apiKind: "paginated-messages"
        }
      };
    });
    return {
      body,
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
      url: exposedUrl,
      redirected: response.redirected,
      type: response.type,
      optimized,
      cacheable,
      activeConversation,
      stats,
      apiKind,
      localPages
    };
  }
  function requestSignal(input, init) {
    if (init?.signal)
      return init.signal;
    const signal = input?.signal;
    return signal != null && typeof signal.aborted === "boolean" ? signal : undefined;
  }
  async function prepareCompletePaginatedResponse(pageWindow, originalFetch, input, init, rewrittenUrl, apiKind, conversationId, completeAll = false) {
    const [firstInput, firstInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
    const firstResponse = await originalFetch(firstInput, firstInit);
    if (!firstResponse.ok) {
      return { response: firstResponse };
    }
    if (!ensureJsonWorker(pageWindow)) {
      return {
        response: apiKind === "paginated-messages" ? await fetchCompleteHistoryPage(pageWindow, originalFetch, input, init, rewrittenUrl, firstResponse) : await fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, conversationId, completeAll, firstResponse)
      };
    }
    let probe;
    try {
      probe = await startPaginatedWorkerJob(pageWindow, await firstResponse.clone().arrayBuffer(), apiKind === "paginated-messages");
      const seenCursors = new Set;
      for (let attempt = 0;attempt < (completeAll ? 64 : 9); attempt += 1) {
        if (!completeAll && probe.complete)
          break;
        const cursor = probe.cursor;
        if (!cursor || seenCursors.has(cursor))
          break;
        seenCursors.add(cursor);
        const olderUrl = apiKind === "paginated-initial" ? new pageWindow.URL(`/backend-api/conversations/${conversationId}/messages`, rewrittenUrl) : new pageWindow.URL(rewrittenUrl);
        olderUrl.searchParams.set("before", cursor);
        olderUrl.searchParams.set("include_has_versions", "true");
        olderUrl.searchParams.set("num_turns", String(Math.min(512, 2 ** Math.min(9, attempt + 2))));
        const [olderInput, olderInit] = rewriteGetRequest(pageWindow, input, init, olderUrl.href);
        const olderResponse = await originalFetch(olderInput, olderInit);
        if (!olderResponse.ok)
          break;
        probe = await prependPaginatedWorkerJob(pageWindow, probe.token, await olderResponse.arrayBuffer());
      }
      return { response: firstResponse, workerJobToken: probe.token };
    } catch (error) {
      if (probe?.token)
        await cancelPaginatedWorkerJob(pageWindow, probe.token);
      console.warn(`[${SCRIPT_NAME}] Worker page assembly fell back`, error);
      return {
        response: apiKind === "paginated-messages" ? await fetchCompleteHistoryPage(pageWindow, originalFetch, input, init, rewrittenUrl, firstResponse) : await fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, conversationId, completeAll, firstResponse)
      };
    }
  }
  async function fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, conversationId, completeAll = false, existingFirstResponse) {
    const firstResponse = existingFirstResponse ?? await (async () => {
      const [firstInput, firstInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
      return originalFetch(firstInput, firstInit);
    })();
    if (!firstResponse.ok)
      return firstResponse;
    let payload = await responseJsonOffMain(pageWindow, firstResponse.clone());
    const seenCursors = new Set;
    let combined = false;
    for (let attempt = 0;attempt < (completeAll ? 64 : 9); attempt += 1) {
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!completeAll && hasRenderableQuestionAnswerTurn(messages, false))
        break;
      const cursor = payload.page_info?.has_previous_page === true && typeof payload.page_info.start_cursor === "string" ? payload.page_info.start_cursor : null;
      if (!cursor || seenCursors.has(cursor))
        break;
      seenCursors.add(cursor);
      const olderUrl = new pageWindow.URL(`/backend-api/conversations/${conversationId}/messages`, rewrittenUrl);
      olderUrl.searchParams.set("before", cursor);
      olderUrl.searchParams.set("include_has_versions", "true");
      olderUrl.searchParams.set("num_turns", String(Math.min(512, 2 ** Math.min(9, attempt + 2))));
      const [olderInput, olderInit] = rewriteGetRequest(pageWindow, input, init, olderUrl.href);
      const olderResponse = await originalFetch(olderInput, olderInit);
      if (!olderResponse.ok)
        break;
      const olderPayload = await responseJsonOffMain(pageWindow, olderResponse);
      payload = {
        ...payload,
        messages: mergeChronologicalMessages(Array.isArray(olderPayload.messages) ? olderPayload.messages : [], messages),
        page_info: olderPayload.page_info,
        safe_urls: [...new Set([
          ...olderPayload.safe_urls ?? [],
          ...payload.safe_urls ?? []
        ])],
        blocked_urls: [...new Set([
          ...olderPayload.blocked_urls ?? [],
          ...payload.blocked_urls ?? []
        ])]
      };
      combined = true;
    }
    if (!combined)
      return firstResponse;
    return new pageWindow.Response(JSON.stringify(payload), {
      status: firstResponse.status,
      statusText: firstResponse.statusText,
      headers: firstResponse.headers
    });
  }
  async function fetchCompleteHistoryPage(pageWindow, originalFetch, input, init, rewrittenUrl, existingFirstResponse) {
    const firstResponse = existingFirstResponse ?? await (async () => {
      const [firstInput, firstInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
      return originalFetch(firstInput, firstInit);
    })();
    if (!firstResponse.ok)
      return firstResponse;
    let payload = await responseJsonOffMain(pageWindow, firstResponse.clone());
    const seenCursors = new Set;
    let combined = false;
    for (let attempt = 0;attempt < 9; attempt += 1) {
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (hasRenderableQuestionAnswerTurn(messages, true))
        break;
      const cursor = payload.page_info?.has_previous_page === true && typeof payload.page_info.start_cursor === "string" ? payload.page_info.start_cursor : null;
      if (!cursor || seenCursors.has(cursor))
        break;
      seenCursors.add(cursor);
      const olderUrl = new pageWindow.URL(rewrittenUrl);
      olderUrl.searchParams.set("before", cursor);
      olderUrl.searchParams.set("num_turns", String(Math.min(512, 2 ** Math.min(9, attempt + 2))));
      const [olderInput, olderInit] = rewriteGetRequest(pageWindow, input, init, olderUrl.href);
      const olderResponse = await originalFetch(olderInput, olderInit);
      if (!olderResponse.ok)
        break;
      const olderPayload = await responseJsonOffMain(pageWindow, olderResponse);
      payload = {
        ...payload,
        messages: mergeChronologicalMessages(Array.isArray(olderPayload.messages) ? olderPayload.messages : [], messages),
        page_info: olderPayload.page_info,
        safe_urls: [...new Set([
          ...olderPayload.safe_urls ?? [],
          ...payload.safe_urls ?? []
        ])],
        blocked_urls: [...new Set([
          ...olderPayload.blocked_urls ?? [],
          ...payload.blocked_urls ?? []
        ])]
      };
      combined = true;
    }
    if (!combined)
      return firstResponse;
    return new pageWindow.Response(JSON.stringify(payload), {
      status: firstResponse.status,
      statusText: firstResponse.statusText,
      headers: firstResponse.headers
    });
  }
  async function materializeLegacyRequestLazily(pageWindow, originalFetch, input, init, legacyUrl, conversationId, mode, settings, createLocalCursor, observePayload) {
    if (settings.initialTurns === "all") {
      const legacyResponse = await originalFetch(input, { ...init, cache: "no-store" });
      const materialized = await materializeAndOptimize(pageWindow, legacyResponse, mode, legacyUrl, observePayload);
      const headers = new pageWindow.Headers(materialized.headers);
      headers.set("x-chatgpt-performance-fix-initial-turns", "all");
      headers.set("x-chatgpt-performance-fix-cacheable", "0");
      return {
        ...materialized,
        headers: [...headers.entries()],
        cacheable: false
      };
    }
    const initialTurns = settings.initialTurns;
    const lazyUrl = new pageWindow.URL(`/backend-api/conversations/${conversationId}`, legacyUrl);
    lazyUrl.searchParams.set("include_has_versions", "true");
    lazyUrl.searchParams.set("num_turns", String(initialTurns));
    try {
      const prepared = await prepareCompletePaginatedResponse(pageWindow, originalFetch, input, { ...init, cache: "no-store" }, lazyUrl.href, "paginated-initial", conversationId);
      const nativeResponse = prepared.response;
      if (!nativeResponse.ok) {
        if (nativeResponse.status === 429) {
          const rateLimited = await materializeAndOptimizePaginated(pageWindow, nativeResponse, "paginated-initial", mode, legacyUrl, false, createLocalCursor, undefined, MODE_OPTIONS[mode].paginatedRenderTurns, observePayload);
          const headers = new pageWindow.Headers(rateLimited.headers);
          headers.set("x-chatgpt-performance-fix-lazy", "rate-limited");
          return {
            ...rateLimited,
            headers: [...headers.entries()],
            url: legacyUrl,
            cacheable: false,
            lazyInitial: true
          };
        }
        throw new Error(`Native pagination returned HTTP ${nativeResponse.status}`);
      }
      const nativeMaterialized = await materializeAndOptimizePaginated(pageWindow, nativeResponse, "paginated-initial", mode, legacyUrl, true, createLocalCursor, prepared.workerJobToken, initialTurns, observePayload);
      const optimizedNativePayload = await parseJsonOffMain(pageWindow, nativeMaterialized.body);
      const lazyPayload = convertNativeInitialToLazyConversation(optimizedNativePayload, conversationId, MODE_OPTIONS[mode].paginatedMaxTurns);
      if (!lazyPayload) {
        throw new Error("Native pagination response could not form a lazy conversation");
      }
      const headers = new pageWindow.Headers(nativeMaterialized.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("x-chatgpt-performance-fix-lazy", "native-pagination");
      headers.set("x-chatgpt-performance-fix-initial-turns", String(initialTurns));
      headers.set("x-chatgpt-performance-fix-cacheable", "0");
      return {
        ...nativeMaterialized,
        body: JSON.stringify(lazyPayload),
        headers: [...headers.entries()],
        url: legacyUrl,
        optimized: true,
        cacheable: false,
        lazyInitial: true
      };
    } catch (error) {
      if (requestSignal(input, init)?.aborted)
        throw error;
      console.warn(`[${SCRIPT_NAME}] Native lazy loading was unavailable; falling back to the legacy response`, error);
      const legacyResponse = await originalFetch(input, init);
      return materializeAndOptimize(pageWindow, legacyResponse, mode, legacyUrl, observePayload);
    }
  }
  function install(pageWindow) {
    if (!pageWindow.fetch || Reflect.get(pageWindow, "__chatgptPerformanceFixInstalled")) {
      return;
    }
    Reflect.set(pageWindow, "__chatgptPerformanceFixInstalled", true);
    const settings = readSettings(pageWindow.localStorage);
    const fullOnceKey = `${FULL_ONCE_PREFIX}${pageWindow.location.pathname}`;
    let bypassThisPageLoad = false;
    try {
      bypassThisPageLoad = pageWindow.sessionStorage.getItem(fullOnceKey) === "1";
      if (bypassThisPageLoad)
        pageWindow.sessionStorage.removeItem(fullOnceKey);
    } catch {}
    const loadCurrentConversationFully = () => {
      try {
        pageWindow.sessionStorage.setItem(`${FULL_ONCE_PREFIX}${pageWindow.location.pathname}`, "1");
      } catch {}
      pageWindow.location.reload();
    };
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("加载全部消息", loadCurrentConversationFully);
      GM_registerMenuCommand(`默认打开：${formatTurnLoadSetting(settings.initialTurns)}`, () => {
        (async () => {
          const next = await showTurnLoadSettingDialog(pageWindow, "打开会话时默认加载多少轮？选择“全部”会增加首次渲染开销。", settings.initialTurns);
          if (next == null)
            return;
          settings.initialTurns = next;
          writeSettings(pageWindow.localStorage, settings);
        })();
      });
      GM_registerMenuCommand(`历史批量：${formatTurnLoadSetting(settings.historyBatchTurns)}`, () => {
        (async () => {
          const next = await showTurnLoadSettingDialog(pageWindow, "每次“加载更多”默认加载多少轮？", settings.historyBatchTurns);
          if (next == null)
            return;
          settings.historyBatchTurns = next;
          writeSettings(pageWindow.localStorage, settings);
        })();
      });
      GM_registerMenuCommand(settings.showMessageMetadata ? "隐藏消息时间与模型" : "显示消息时间与模型", () => {
        settings.showMessageMetadata = !settings.showMessageMetadata;
        writeSettings(pageWindow.localStorage, settings);
        pageWindow.location.reload();
      });
      GM_registerMenuCommand(`切换模式（${settings.mode}）`, () => {
        const nextMode = settings.mode === "balanced" ? "aggressive" : settings.mode === "aggressive" ? "off" : "balanced";
        writeSettings(pageWindow.localStorage, { ...settings, mode: nextMode });
        pageWindow.location.reload();
      });
    }
    addVirtualizationCss(pageWindow);
    if (settings.mode !== "off") {
      installRichTextPerformanceFix(pageWindow, MODE_OPTIONS[settings.mode].richTextWarmDistancePx, MODE_OPTIONS[settings.mode].codeEditorWarmDistancePx);
    }
    const deepLink = new pageWindow.URLSearchParams(pageWindow.location.search);
    if (settings.mode === "off" || bypassThisPageLoad || deepLink.has("message") || deepLink.has("messageId")) {
      return;
    }
    const activeMode = settings.mode;
    const messageMetadataDisplay = settings.showMessageMetadata ? installMessageMetadataDisplay(pageWindow) : null;
    const responseFallback = installLegacyResponseFallback(pageWindow, activeMode, messageMetadataDisplay?.ingestPayload);
    installManualPaginationObserver(pageWindow, settings);
    const originalFetch = pageWindow.fetch.bind(pageWindow);
    const backendRequestContext = createBackendRequestContext(pageWindow);
    const sidebarFreshness = installSidebarFreshness(pageWindow, originalFetch, backendRequestContext);
    const deliveryVerifier = installDeliveryVerifier(pageWindow);
    const cache = new Map;
    const initialSnapshots = new Map;
    const responseBudget = new CacheBudget(RESPONSE_CACHE_BUDGET_BYTES);
    const responseBytes = (response) => 2 * (response.body.length + response.url.length + response.statusText.length + response.headers.reduce((sum, [name, value]) => sum + name.length + value.length, 0)) + (response.localPages ?? []).reduce((sum, page) => sum + 2 * page.cursor.length + responseBytes(page.response), 0);
    let cacheCleanupTimer;
    let cacheCleanupAt = Infinity;
    const scheduleCacheCleanup = () => {
      if (cache.size === 0)
        return;
      let next = Infinity;
      for (const value of cache.values())
        next = Math.min(next, value.expiresAt);
      if (cacheCleanupTimer != null && cacheCleanupAt <= next)
        return;
      if (cacheCleanupTimer != null)
        pageWindow.clearTimeout(cacheCleanupTimer);
      cacheCleanupAt = next;
      cacheCleanupTimer = pageWindow.setTimeout(() => {
        cacheCleanupTimer = undefined;
        cacheCleanupAt = Infinity;
        const now = Date.now();
        for (const [key, value] of cache) {
          if (value.expiresAt > now)
            continue;
          cache.delete(key);
          responseBudget.delete(`history:${key}`);
        }
        scheduleCacheCleanup();
      }, Math.max(0, next - Date.now()));
    };
    const initialSnapshotEpochs = new Map;
    const asyncStatusActivity = new Map;
    let globalInitialSnapshotEpoch = 0;
    const inFlight = new Map;
    const notifiedKeys = new Set;
    const localPages = new Map;
    const localCursorSession = pageWindow.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    let localCursorCounter = 0;
    const createLocalCursor = () => `cgptperf-${localCursorSession}-${(++localCursorCounter).toString(36)}`;
    const initialSnapshotKey = (kind, conversationId) => `${kind}:${conversationId}:${String(settings.initialTurns)}`;
    const initialSnapshotEpoch = (conversationId) => `${globalInitialSnapshotEpoch}:${initialSnapshotEpochs.get(conversationId) ?? 0}`;
    const invalidateInitialSnapshots = (conversationId) => {
      if (conversationId) {
        initialSnapshotEpochs.set(conversationId, (initialSnapshotEpochs.get(conversationId) ?? 0) + 1);
      } else {
        globalInitialSnapshotEpoch += 1;
      }
      for (const [key, snapshot] of initialSnapshots) {
        if (snapshot.rateLimited)
          continue;
        if (!conversationId || key.includes(`:${conversationId}:`)) {
          initialSnapshots.delete(key);
          responseBudget.delete(`snapshot:${key}`);
        }
      }
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptInitialSnapshotInvalidations = String(Number(root.dataset.chatgptInitialSnapshotInvalidations ?? "0") + 1);
    };
    const readInitialSnapshot = (key, exposedUrl) => {
      const snapshot = initialSnapshots.get(key);
      if (!snapshot)
        return null;
      if (snapshot.expiresAt <= Date.now()) {
        initialSnapshots.delete(key);
        responseBudget.delete(`snapshot:${key}`);
        return null;
      }
      initialSnapshots.delete(key);
      initialSnapshots.set(key, snapshot);
      responseBudget.touch(`snapshot:${key}`);
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptInitialSnapshotHits = String(Number(root.dataset.chatgptInitialSnapshotHits ?? "0") + 1);
      if (snapshot.rateLimited) {
        root.dataset.chatgptInitialRateLimitSuppressions = String(Number(root.dataset.chatgptInitialRateLimitSuppressions ?? "0") + 1);
      }
      const headers = new pageWindow.Headers(snapshot.response.headers);
      headers.set("x-chatgpt-performance-fix-initial-snapshot", snapshot.rateLimited ? "rate-limit-backoff" : "hit");
      return cloneMaterializedResponse(pageWindow, {
        ...snapshot.response,
        headers: [...headers.entries()],
        url: exposedUrl
      });
    };
    const storeInitialSnapshot = (key, response, conversationId, requestEpoch) => {
      const successful = response.status >= 200 && response.status < 300;
      const rateLimited = response.status === 429;
      if (!successful && !rateLimited)
        return;
      const epochIsCurrent = requestEpoch === initialSnapshotEpoch(conversationId);
      if (successful && epochIsCurrent && response.activeConversation != null) {
        asyncStatusActivity.set(conversationId, response.activeConversation);
      }
      if (successful && (response.activeConversation !== false || !epochIsCurrent)) {
        const existing = initialSnapshots.get(key);
        if (existing && !existing.rateLimited) {
          initialSnapshots.delete(key);
          responseBudget.delete(`snapshot:${key}`);
        }
        const root = pageWindow.document.documentElement;
        const reason = response.activeConversation === true ? "Active" : "StaleOrUnknown";
        const datasetKey = `chatgptInitialSnapshotSkipped${reason}`;
        root.dataset[datasetKey] = String(Number(root.dataset[datasetKey] ?? "0") + 1);
        return;
      }
      const now = Date.now();
      const expiresAt = rateLimited ? now + retryAfterBackoffMs(new pageWindow.Headers(response.headers), INITIAL_RATE_LIMIT_BACKOFF_MS, now) : Number.POSITIVE_INFINITY;
      initialSnapshots.delete(key);
      responseBudget.delete(`snapshot:${key}`);
      initialSnapshots.set(key, { response, expiresAt, rateLimited });
      if (!rateLimited) {
        responseBudget.set(`snapshot:${key}`, responseBytes(response), () => initialSnapshots.delete(key));
      }
      while (initialSnapshots.size > MAX_INITIAL_CONVERSATION_SNAPSHOTS) {
        const oldest = initialSnapshots.keys().next().value;
        if (typeof oldest !== "string")
          break;
        initialSnapshots.delete(oldest);
        responseBudget.delete(`snapshot:${oldest}`);
      }
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptInitialSnapshotsStored = String(Number(root.dataset.chatgptInitialSnapshotsStored ?? "0") + 1);
      if (rateLimited) {
        root.dataset.chatgptInitialRateLimitBackoffUntil = String(expiresAt);
      }
    };
    const clearLiveConversationCache = (conversationId) => {
      invalidateInitialSnapshots(conversationId);
      for (const key of cache.keys())
        responseBudget.delete(`history:${key}`);
      cache.clear();
      if (cacheCleanupTimer != null)
        pageWindow.clearTimeout(cacheCleanupTimer);
      cacheCleanupTimer = undefined;
      cacheCleanupAt = Infinity;
      inFlight.clear();
      responseFallback.clear();
    };
    const wrappedFetch = async (input, init) => {
      const rawUrl = requestUrl(pageWindow, input, pageWindow.location.href);
      const method = requestMethod(input, init);
      const capturedBackendContext = backendRequestContext.capture(input, init, rawUrl);
      if (capturedBackendContext)
        sidebarFreshness.requestContextChanged();
      const apiMatch = matchConversationApiUrl(rawUrl, pageWindow.location.href);
      const mutationKind = conversationMutationKind(rawUrl, method, pageWindow.location.href);
      if (mutationKind) {
        const restoredInit = restoreStaticCodeRequestInit(init);
        const fallbackProbe = {
          conversationId: currentConversationId(pageWindow),
          messageId: null,
          text: null,
          hasUserMessage: false,
          createdAtMs: null,
          requestedModelSlug: null
        };
        const inspected = mutationKind === "send" ? await inspectOutgoingRequest(input, restoredInit) : fallbackProbe;
        const probe = {
          ...inspected,
          conversationId: inspected.conversationId ?? fallbackProbe.conversationId
        };
        const trackUserSend = mutationKind === "send" && probe.hasUserMessage;
        if (trackUserSend) {
          messageMetadataDisplay?.noteOutgoing(probe);
          deliveryVerifier.begin(probe);
        }
        const mutationConversationId = mutationKind === "content" ? apiMatch?.conversationId ?? probe.conversationId : probe.conversationId ?? apiMatch?.conversationId ?? currentConversationId(pageWindow);
        if (mutationConversationId && (mutationKind === "send" || mutationKind === "resume")) {
          asyncStatusActivity.set(mutationConversationId, true);
        }
        clearLiveConversationCache(mutationConversationId);
        try {
          const response = await originalFetch(input, restoredInit);
          if (mutationKind === "send" || mutationKind === "resume") {
            messageMetadataDisplay?.observeResponse(response);
          }
          if (trackUserSend) {
            if (response.ok) {
              deliveryVerifier.accepted(probe);
            } else {
              deliveryVerifier.failed(probe, `HTTP ${response.status}`);
            }
          }
          return response;
        } catch (error) {
          if (trackUserSend) {
            deliveryVerifier.failed(probe, error instanceof Error ? error.message : String(error));
          }
          throw error;
        }
      }
      const statusConversationId = conversationStatusUpdateId(rawUrl, method, pageWindow.location.href);
      if (statusConversationId) {
        const statusProbePromise = inspectAsyncStatusRequest(input, init);
        const response = await originalFetch(input, init);
        if (response.ok) {
          const statusProbe = await statusProbePromise;
          if (statusProbe.found) {
            const active = isActiveAsyncStatus(statusProbe.value);
            const hadPrevious = asyncStatusActivity.has(statusConversationId);
            const previous = asyncStatusActivity.get(statusConversationId);
            asyncStatusActivity.set(statusConversationId, active);
            if (!hadPrevious || previous !== active) {
              invalidateInitialSnapshots(statusConversationId);
            }
          }
        }
        return response;
      }
      if (method !== "GET" || !apiMatch) {
        return originalFetch(input, init);
      }
      const normalizedRawUrl = new pageWindow.URL(rawUrl, pageWindow.location.href).href;
      const requestUrlObject = new pageWindow.URL(normalizedRawUrl);
      if (apiMatch.kind === "paginated-messages") {
        const before = requestUrlObject.searchParams.get("before");
        const localPage = before == null ? undefined : localPages.get(before);
        if (localPage) {
          await yieldUntilInteractionIdle(pageWindow);
          const cloned = cloneMaterializedResponse(pageWindow, {
            ...localPage,
            url: normalizedRawUrl
          });
          dispatchHistorySettledAfterCommit(pageWindow);
          return cloned;
        }
      }
      if (apiMatch.kind !== "legacy-full" && requestUrlObject.searchParams.has("include_message_id")) {
        return originalFetch(input, init);
      }
      let key;
      let task;
      let finiteBatchServerRequest = false;
      let requestInitialSnapshotEpoch;
      if (apiMatch.kind === "legacy-full") {
        const explicitlyFull = ["true", "1"].includes(requestUrlObject.searchParams.get("include_full_conversation") ?? "");
        if (explicitlyFull)
          return originalFetch(input, init);
        key = initialSnapshotKey("legacy-full", apiMatch.conversationId);
        const snapshot = readInitialSnapshot(key, normalizedRawUrl);
        if (snapshot)
          return snapshot;
        requestInitialSnapshotEpoch = initialSnapshotEpoch(apiMatch.conversationId);
        task = inFlight.get(key);
        if (!task) {
          task = materializeLegacyRequestLazily(pageWindow, originalFetch, input, init, normalizedRawUrl, apiMatch.conversationId, activeMode, settings, createLocalCursor, messageMetadataDisplay?.ingestPayload);
          inFlight.set(key, task);
        }
      } else {
        const completeAll = apiMatch.kind === "paginated-initial" && settings.initialTurns === "all";
        let renderTurns = MODE_OPTIONS[activeMode].paginatedRenderTurns;
        let rewrittenUrl;
        if (apiMatch.kind === "paginated-initial") {
          const initialTurns = completeAll ? ALL_INITIAL_FIRST_PAGE_TURNS : settings.initialTurns;
          const url = new pageWindow.URL(normalizedRawUrl);
          url.searchParams.set("num_turns", String(initialTurns));
          rewrittenUrl = url.href;
          renderTurns = completeAll ? Number.MAX_SAFE_INTEGER : initialTurns;
        } else {
          const root = pageWindow.document.documentElement;
          const before = requestUrlObject.searchParams.get("before");
          const requestedTurns = Number(root.dataset.chatgptHistoryFiniteRequestedTurns ?? "0");
          const finiteServerRequestPending = root.dataset.chatgptHistoryBatchActive === "true" && root.dataset.chatgptHistoryBatchMode === "count" && root.dataset.chatgptHistoryFiniteServerRequestPending === "true" && Number.isFinite(requestedTurns) && requestedTurns > 0 && before != null && !before.startsWith("cgptperf-");
          if (finiteServerRequestPending) {
            const url = new pageWindow.URL(normalizedRawUrl);
            url.searchParams.set("num_turns", String(Math.floor(requestedTurns)));
            rewrittenUrl = url.href;
            renderTurns = 1;
            root.dataset.chatgptHistoryFiniteServerRequestPending = "false";
            root.dataset.chatgptHistoryFiniteServerRequestTurns = String(Math.floor(requestedTurns));
            finiteBatchServerRequest = true;
          } else {
            rewrittenUrl = clampPaginatedNumTurns(normalizedRawUrl, pageWindow.location.href, MODE_OPTIONS[activeMode].paginatedMaxTurns);
          }
        }
        const requestWasClamped = rewrittenUrl !== normalizedRawUrl;
        if (apiMatch.kind === "paginated-initial") {
          key = initialSnapshotKey("paginated-initial", apiMatch.conversationId);
          const snapshot = readInitialSnapshot(key, normalizedRawUrl);
          if (snapshot)
            return snapshot;
          requestInitialSnapshotEpoch = initialSnapshotEpoch(apiMatch.conversationId);
        } else {
          key = `paginated:${rewrittenUrl}`;
          const cached = cache.get(key);
          if (cached && cached.expiresAt > Date.now()) {
            responseBudget.touch(`history:${key}`);
            const root = pageWindow.document.documentElement;
            const hits = Number(root.dataset.chatgptHistoryCacheHits ?? "0");
            root.dataset.chatgptHistoryCacheHits = String(hits + 1);
            await yieldUntilInteractionIdle(pageWindow);
            const cloned = cloneMaterializedResponse(pageWindow, cached.response);
            if (finiteBatchServerRequest) {
              pageWindow.dispatchEvent(new pageWindow.CustomEvent("chatgpt-performance-fix:history-finite-plan", {
                detail: {
                  localPages: cached.response.localPages?.length ?? 0
                }
              }));
            }
            dispatchHistorySettledAfterCommit(pageWindow);
            return cloned;
          }
          if (cached) {
            cache.delete(key);
            responseBudget.delete(`history:${key}`);
          }
        }
        task = inFlight.get(key);
        if (!task) {
          const responseTask = prepareCompletePaginatedResponse(pageWindow, originalFetch, input, init, rewrittenUrl, apiMatch.kind, apiMatch.conversationId, completeAll);
          task = responseTask.then((prepared) => materializeAndOptimizePaginated(pageWindow, prepared.response, apiMatch.kind, activeMode, normalizedRawUrl, requestWasClamped, createLocalCursor, prepared.workerJobToken, renderTurns, messageMetadataDisplay?.ingestPayload));
          inFlight.set(key, task);
        }
      }
      try {
        const materialized = await task;
        if (apiMatch.kind === "legacy-full" || apiMatch.kind === "paginated-initial") {
          storeInitialSnapshot(key, materialized, apiMatch.conversationId, requestInitialSnapshotEpoch ?? initialSnapshotEpoch(apiMatch.conversationId));
        }
        if (finiteBatchServerRequest) {
          pageWindow.dispatchEvent(new pageWindow.CustomEvent("chatgpt-performance-fix:history-finite-plan", {
            detail: {
              localPages: materialized.localPages?.length ?? 0
            }
          }));
        }
        for (const localPage of materialized.localPages ?? []) {
          localPages.set(localPage.cursor, localPage.response);
        }
        while (localPages.size > 256) {
          const oldest = localPages.keys().next().value;
          if (typeof oldest !== "string")
            break;
          localPages.delete(oldest);
        }
        if (materialized.apiKind === "paginated-messages" && materialized.optimized) {
          cache.set(key, {
            expiresAt: Date.now() + HISTORY_CACHE_TTL_MS,
            response: materialized
          });
          responseBudget.set(`history:${key}`, responseBytes(materialized), () => cache.delete(key));
          scheduleCacheCleanup();
        }
        if ((materialized.apiKind === "legacy-full" || materialized.lazyInitial) && materialized.optimized && materialized.cacheable) {
          cache.set(key, {
            expiresAt: Date.now() + CACHE_TTL_MS,
            response: materialized
          });
          responseBudget.set(`history:${key}`, responseBytes(materialized), () => cache.delete(key));
          scheduleCacheCleanup();
        }
        if (materialized.optimized) {
          const stats = materialized.stats;
          pageWindow.document.documentElement.dataset.chatgptPerformanceFix = "large";
          const notificationKind = materialized.lazyInitial ? "lazy-initial" : materialized.apiKind;
          const notificationKey = `${apiMatch.conversationId}:${notificationKind}`;
          if (stats && !notifiedKeys.has(notificationKey)) {
            notifiedKeys.add(notificationKey);
            console.info(`[${SCRIPT_NAME}]`, {
              apiKind: materialized.apiKind,
              ...stats,
              paginatedMaxTurns: MODE_OPTIONS[activeMode].paginatedMaxTurns,
              manualHistoryLoading: true,
              responseCacheTtlMs: materialized.cacheable ? CACHE_TTL_MS : 0
            });
            if (materialized.lazyInitial && "originalMessages" in stats) {
              showOptimizationToast(pageWindow, `已启用长会话加速`, loadCurrentConversationFully);
            } else if (materialized.apiKind === "legacy-full" && "originalNodes" in stats) {
              showOptimizationToast(pageWindow, `长会话已加速`, loadCurrentConversationFully);
            } else if (materialized.apiKind === "paginated-initial" && "originalMessages" in stats) {
              showOptimizationToast(pageWindow, `历史按需加载`, loadCurrentConversationFully);
            }
          }
        }
        if (materialized.apiKind === "paginated-messages") {
          await yieldUntilInteractionIdle(pageWindow);
          const cloned = cloneMaterializedResponse(pageWindow, materialized);
          dispatchHistorySettledAfterCommit(pageWindow);
          return cloned;
        }
        return cloneMaterializedResponse(pageWindow, materialized);
      } catch (error) {
        if (apiMatch.kind === "paginated-messages") {
          dispatchHistorySettledAfterCommit(pageWindow, false);
        }
        throw error;
      } finally {
        if (inFlight.get(key) === task)
          inFlight.delete(key);
      }
    };
    try {
      Object.defineProperty(wrappedFetch, "name", { value: "fetch" });
      Object.defineProperty(pageWindow, "fetch", {
        configurable: true,
        writable: true,
        value: wrappedFetch
      });
    } catch {
      pageWindow.fetch = wrappedFetch;
    }
  }
  var pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  install(pageWindow);
})();
