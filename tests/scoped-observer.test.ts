import { describe, expect, test } from "bun:test";
import { deduplicateAddedNodes, ScopedContainerObserver } from "../src/scoped-observer";

describe("deduplicateAddedNodes", () => {
  test("returns empty array when records have no added elements", () => {
    const textNode = { nodeType: 3 /* Node.TEXT_NODE */ } as unknown as Node;
    const records = [
      { addedNodes: [textNode] } as unknown as MutationRecord,
      { addedNodes: [] } as unknown as MutationRecord,
    ];
    expect(deduplicateAddedNodes(records)).toEqual([]);
  });

  test("returns single element directly", () => {
    const div = { nodeType: 1, contains: () => false } as unknown as Element;
    const records = [{ addedNodes: [div] } as unknown as MutationRecord];
    expect(deduplicateAddedNodes(records)).toEqual([div]);
  });

  test("deduplicates child when parent element is also in added nodes", () => {
    const parent = {
      nodeType: 1,
      name: "parent",
      contains: (el: any) => el === child,
    } as unknown as Element;
    const child = {
      nodeType: 1,
      name: "child",
      contains: () => false,
    } as unknown as Element;
    const sibling = {
      nodeType: 1,
      name: "sibling",
      contains: () => false,
    } as unknown as Element;

    const records = [
      { addedNodes: [parent, child] } as unknown as MutationRecord,
      { addedNodes: [sibling] } as unknown as MutationRecord,
    ];

    const result = deduplicateAddedNodes(records);
    expect(result).toHaveLength(2);
    expect(result).toContain(parent);
    expect(result).toContain(sibling);
    expect(result).not.toContain(child);
  });
});

describe("ScopedContainerObserver", () => {
  class MockDOMElement {
    nodeType = 1;
    isConnected = true;
    contains(other: any) {
      return other === this;
    }
  }

  class MockMutationObserver {
    target: any = null;
    options: any = null;
    static instances: MockMutationObserver[] = [];

    constructor(public callback: (records: any[]) => void) {
      MockMutationObserver.instances.push(this);
    }

    observe(target: any, options: any) {
      this.target = target;
      this.options = options;
    }

    disconnect() {
      this.target = null;
      this.options = null;
    }
  }

  function createMockPage() {
    MockMutationObserver.instances = [];
    const docElement = new MockDOMElement();
    let container: MockDOMElement | null = null;
    const intervals: (() => void)[] = [];

    const page = {
      document: {
        documentElement: docElement,
      },
      MutationObserver: MockMutationObserver as any,
      setInterval: (fn: () => void) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => {},
    } as any;

    return { page, docElement, getContainer: () => container, setContainer: (c: MockDOMElement | null) => { container = c; }, intervals };
  }

  test("starts globally when container does not exist yet", () => {
    const { page, docElement, getContainer } = createMockPage();
    const recordsReceived: any[] = [];
    let migratedTarget: any = undefined;

    const observer = new ScopedContainerObserver(
      page,
      (records) => recordsReceived.push(...records),
      getContainer,
      (c) => { migratedTarget = c; },
    );

    observer.start();
    expect(observer.isContainerScoped).toBe(false);
    expect(observer.activeContainer).toBe(null);
    expect(migratedTarget).toBe(null);

    // Initial observer attached to documentElement
    const globalObs = MockMutationObserver.instances[0];
    expect(globalObs.target).toBe(docElement);

    observer.disconnect();
  });

  test("migrates to container once discovered during mutations", () => {
    const { page, docElement, getContainer, setContainer } = createMockPage();
    const recordsReceived: any[] = [];
    let migratedTarget: any = undefined;

    const observer = new ScopedContainerObserver(
      page,
      (records) => recordsReceived.push(...records),
      getContainer,
      (c) => { migratedTarget = c; },
    );

    observer.start();
    const globalObs = MockMutationObserver.instances[0];

    // Container is created and added
    const container = new MockDOMElement();
    setContainer(container);

    // Global mutation fires
    globalObs.callback([{ addedNodes: [container] }]);

    expect(observer.isContainerScoped).toBe(true);
    expect(observer.activeContainer).toBe(container);
    expect(migratedTarget).toBe(container);

    // Global observer disconnected and container observer attached
    expect(globalObs.target).toBe(null);
    const containerObs = MockMutationObserver.instances[1];
    expect(containerObs.target).toBe(container);

    observer.disconnect();
  });

  test("falls back to global when container is disconnected", () => {
    const { page, getContainer, setContainer } = createMockPage();
    const container = new MockDOMElement();
    setContainer(container);

    const observer = new ScopedContainerObserver(
      page,
      () => {},
      getContainer,
    );

    observer.start();
    expect(observer.isContainerScoped).toBe(true);

    // Container removed from DOM
    container.isConnected = false;
    setContainer(null);

    const containerObs = MockMutationObserver.instances[0];
    containerObs.callback([]);

    expect(observer.isContainerScoped).toBe(false);
    expect(observer.activeContainer).toBe(null);

    observer.disconnect();
  });
});
