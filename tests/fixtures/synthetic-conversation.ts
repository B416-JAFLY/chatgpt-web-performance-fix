import type { ConversationMessage, ConversationNode, ConversationPayload } from "../../src/optimizer";

// Generated data is intentionally fictional and contains no captured account data.
export function syntheticConversation(): { payload: ConversationPayload; turns: ConversationMessage[][]; inactiveIds: string[] } {
  const mapping: Record<string, ConversationNode> = {
    root: { id: "root", parent: null, children: [], message: null },
  };
  let parent = "root";
  const turns: ConversationMessage[][] = [];
  for (let turn = 0; turn < 3; turn++) {
    const messages: ConversationMessage[] = [
      { id: `user-${turn}`, author: { role: "user" }, content: { content_type: "text", parts: [`Question ${turn}`] } },
    ];
    for (let index = 0; index < 80; index++) {
      messages.push(
        { id: `call-${turn}-${index}`, author: { role: "assistant" }, recipient: "tool.example", content: { content_type: "code", parts: ["x".repeat(300)] } },
        { id: `tool-${turn}-${index}`, author: { role: "tool" }, content: { content_type: "execution_output", parts: ["y".repeat(300)] } },
      );
    }
    messages.push({ id: `answer-${turn}`, author: { role: "assistant" }, channel: "final", content: { content_type: "text", parts: [`Answer ${turn}`] } });
    for (const message of messages) {
      const id = message.id!;
      mapping[parent].children!.push(id);
      mapping[id] = { id, parent, children: [], message };
      parent = id;
    }
    turns.push(messages);
  }
  const inactiveIds = ["branch-user", "branch-answer"];
  mapping.root.children!.push(inactiveIds[0]);
  mapping[inactiveIds[0]] = { id: inactiveIds[0], parent: "root", children: [inactiveIds[1]], message: { id: inactiveIds[0], author: { role: "user" }, content: { content_type: "text", parts: ["Alternative question"] } } };
  mapping[inactiveIds[1]] = { id: inactiveIds[1], parent: inactiveIds[0], children: [], message: { id: inactiveIds[1], author: { role: "assistant" }, channel: "final", content: { content_type: "text", parts: ["Alternative answer"] } } };
  return { payload: { current_node: parent, mapping }, turns, inactiveIds };
}
