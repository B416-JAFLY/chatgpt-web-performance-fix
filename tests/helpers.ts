import { existsSync } from "node:fs";
import { readCdx, readWarcResponse } from "../analysis/lib/wacz";
import {
  hasPrivateCapture,
  PRIVATE_WACZ_INDEX,
  PRIVATE_WARC_ARCHIVE,
} from "../analysis/lib/private-paths";
import type {
  ConversationMessage,
  ConversationNode,
  ConversationPayload,
} from "../src/optimizer";

export interface CapturedConversation {
  payload: ConversationPayload;
  text: string;
}

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate): candidate is string => Boolean(candidate));

export function resolveChromeBinary(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return (
    process.env.CHROME_BIN ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
}

function buildSyntheticCodeBlock(blockIndex: number): string {
  const lines = Array.from(
    { length: 64 },
    (_, lineIndex) =>
      `export const syntheticBlock${blockIndex}_line${lineIndex} = "${"x".repeat(42)}_${blockIndex}_${lineIndex}";`,
  );
  return `\`\`\`ts\n${lines.join("\n")}\n\`\`\``;
}

function buildSyntheticCapturedConversation(): CapturedConversation {
  // Deterministic 16-turn conversation matching the structural invariants of
  // the reference capture (5,405 total nodes, 3,720 active-path nodes, 1,685
  // off-path nodes, 53 messages in the newest turn, 565 in turn -2, 773 in the
  // largest turn, and 6 large fenced code blocks in the richest code turn).
  const turnLengths = [
    182, 182, 182, 182, 182, 182, 148, 773, 182, 182, 182, 182, 180, 180, 565,
    53,
  ];
  const mapping: Record<string, ConversationNode> = {};
  const rootId = "00000000-0000-4000-8000-000000000000";
  mapping[rootId] = {
    id: rootId,
    parent: null,
    children: [],
    message: null,
  };

  let previousId = rootId;
  let currentLeafId = rootId;

  const appendActiveNode = (id: string, message: ConversationMessage) => {
    mapping[id] = {
      id,
      parent: previousId,
      children: [],
      message,
    };
    mapping[previousId]!.children!.push(id);
    previousId = id;
    currentLeafId = id;
  };

  for (let turnIndex = 0; turnIndex < turnLengths.length; turnIndex += 1) {
    const totalMessages = turnLengths[turnIndex]!;
    const isLastTurn = turnIndex === turnLengths.length - 1;
    const isRichCodeTurn = turnIndex === 6;

    const userId = `turn-${turnIndex}-user`;
    appendActiveNode(userId, {
      id: userId,
      author: { role: "user" },
      content: {
        content_type: "text",
        parts: [`Synthetic user question for turn ${turnIndex + 1}`],
      },
      status: "finished_successfully",
    });

    const internalBeforeFinal = isLastTurn
      ? totalMessages - 4
      : totalMessages - 2;

    for (let step = 0; step < internalBeforeFinal; step += 1) {
      const msgId = `turn-${turnIndex}-internal-${step}`;
      const isTool = step % 2 === 1;
      appendActiveNode(
        msgId,
        isTool
          ? {
              id: msgId,
              author: { role: "tool", name: "python" },
              content: {
                content_type: "execution_output",
                parts: [`output_${turnIndex}_${step}_${"y".repeat(96)}`],
              },
              status: "finished_successfully",
            }
          : {
              id: msgId,
              author: { role: "assistant" },
              recipient: "python",
              content: {
                content_type: "code",
                parts: [`run_step(${turnIndex}, ${step}); // ${"z".repeat(96)}`],
              },
              status: "finished_successfully",
            },
      );
    }

    const finalId = `turn-${turnIndex}-final`;
    const finalText = isRichCodeTurn
      ? [
          `Here are the generated modules for turn ${turnIndex + 1}:`,
          buildSyntheticCodeBlock(1),
          buildSyntheticCodeBlock(2),
          buildSyntheticCodeBlock(3),
          buildSyntheticCodeBlock(4),
          buildSyntheticCodeBlock(5),
          buildSyntheticCodeBlock(6),
        ].join("\n\n")
      : `Final assistant answer for turn ${turnIndex + 1}.`;

    appendActiveNode(finalId, {
      id: finalId,
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      content: {
        content_type: "text",
        parts: [finalText],
      },
      status: "finished_successfully",
    });

    if (isLastTurn) {
      const parentToolCallId = `turn-${turnIndex}-tail-call`;
      const tailToolId = `turn-${turnIndex}-tail-tool`;
      appendActiveNode(parentToolCallId, {
        id: parentToolCallId,
        author: { role: "assistant" },
        recipient: "python",
        content: {
          content_type: "code",
          parts: ["cleanup_temp_artifacts()"],
        },
        status: "finished_successfully",
      });
      appendActiveNode(tailToolId, {
        id: tailToolId,
        author: { role: "tool", name: "python" },
        content: {
          content_type: "execution_output",
          parts: ["cleaned"],
        },
        status: "finished_successfully",
        metadata: {
          parent_id: parentToolCallId,
        },
      });
    }
  }

  for (let branchIdx = 0; branchIdx < 1_685; branchIdx += 1) {
    const branchId = `off-path-node-${branchIdx}`;
    mapping[branchId] = {
      id: branchId,
      parent: rootId,
      children: [],
      message: {
        id: branchId,
        author: { role: "assistant" },
        recipient: "python",
        content: {
          content_type: "thoughts",
          parts: [`abandoned branch thought ${branchIdx}`],
        },
        status: "finished_successfully",
      },
    };
    mapping[rootId]!.children!.push(branchId);
  }

  const payload: ConversationPayload = {
    title: "Synthetic Long Conversation Capture",
    current_node: currentLeafId,
    mapping,
    moderation_results: [],
  };
  return {
    payload,
    text: JSON.stringify(payload),
  };
}

let cached: Promise<CapturedConversation> | undefined;

export function loadCapturedConversation(): Promise<CapturedConversation> {
  cached ??= (async () => {
    if (!hasPrivateCapture()) {
      return buildSyntheticCapturedConversation();
    }
    const records = await readCdx(PRIVATE_WACZ_INDEX);
    const record = records.find((candidate) => {
      if (candidate.mime !== "application/json") return false;
      return /\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(
        new URL(candidate.url).pathname,
      );
    });

    if (!record) throw new Error("Captured legacy conversation response not found");

    const response = readWarcResponse(
      PRIVATE_WARC_ARCHIVE,
      record,
    );
    const text = response.body.toString("utf8");
    return {
      payload: JSON.parse(text) as ConversationPayload,
      text,
    };
  })();

  return cached;
}

export function traceActivePath(
  payload: ConversationPayload,
): Array<{ id: string; node: ConversationNode }> {
  const mapping = payload.mapping;
  if (!mapping || typeof payload.current_node !== "string") {
    throw new Error("Conversation payload has no mapping/current node");
  }

  const reversePath: Array<{ id: string; node: ConversationNode }> = [];
  const seen = new Set<string>();
  let id: string | null | undefined = payload.current_node;

  while (id != null) {
    if (seen.has(id)) throw new Error(`Cycle at ${id}`);
    seen.add(id);
    const node = mapping[id];
    if (!node) throw new Error(`Missing node ${id}`);
    reversePath.push({ id, node });
    id = node.parent;
  }

  return reversePath.reverse();
}
