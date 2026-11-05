import { describe, expect, test } from "bun:test";
import { sidebarMayHaveChanged } from "../src/sidebar-mutations";

function element(options: { inSidebar?: boolean; sidebar?: boolean; containsSidebar?: boolean } = {}): Element {
  return {
    nodeType: 1,
    closest: () => options.inSidebar ? {} : null,
    matches: () => !!options.sidebar,
    querySelector: () => options.containsSidebar ? {} : null,
  } as unknown as Element;
}

function mutation(target: Element, addedNodes: Node[] = []): MutationRecord {
  return { target, addedNodes } as unknown as MutationRecord;
}

describe("sidebar mutation filtering", () => {
  test("ignores streamed message changes and text nodes", () => {
    expect(sidebarMayHaveChanged([mutation(element(), [element(), { nodeType: 3 } as Node])])).toBe(false);
  });
  test("detects sidebar changes including removal of the control", () => {
    expect(sidebarMayHaveChanged([mutation(element({ inSidebar: true }))])).toBe(true);
  });
  test("detects inserted sidebars directly or inside a replacement subtree", () => {
    expect(sidebarMayHaveChanged([mutation(element(), [element({ sidebar: true })])])).toBe(true);
    expect(sidebarMayHaveChanged([mutation(element(), [element({ containsSidebar: true })])])).toBe(true);
  });
});
