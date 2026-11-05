import { describe, expect, test } from "bun:test";
import { waitForHistoryConsent } from "../src/modern-history";

class MockElement {
  type = "button";
  dataset: Record<string, string> = {};
  textContent = "";
  style: Record<string, string> = {};
  onclick?: () => void;
  parentElement: MockElement | null = null;
  children: MockElement[] = [];

  set cssText(val: string) {}

  append(...elements: MockElement[]) {
    for (const el of elements) {
      el.parentElement = this;
      this.children.push(el);
    }
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }
}

function createMockPage(initialPath = "/c/123") {
  const docBody = new MockElement();
  const listeners: Record<string, Set<EventListenerOrEventListenerObject>> = {};
  let intervalId = 1;
  const intervals = new Map<number, () => void>();

  const page = {
    location: { pathname: initialPath },
    document: {
      body: docBody,
      documentElement: docBody,
      createElement: () => new MockElement(),
    },
    DOMException: globalThis.DOMException,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners[type] = listeners[type] ?? new Set();
      listeners[type].add(listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      listeners[type]?.delete(listener);
    },
    setInterval: (cb: () => void, ms: number) => {
      const id = intervalId++;
      intervals.set(id, cb);
      return id;
    },
    clearInterval: (id: number) => {
      intervals.delete(id);
    },
    _tick: () => {
      for (const cb of [...intervals.values()]) cb();
    },
    _emit: (type: string) => {
      for (const listener of [...(listeners[type] ?? [])]) {
        if (typeof listener === "function") listener(new Event(type));
        else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(new Event(type));
      }
    },
  } as unknown as Window & typeof globalThis & { _tick: () => void; _emit: (type: string) => void };

  return { page, docBody, intervals };
}

describe("waitForHistoryConsent", () => {
  test("creates a button and resolves when clicked", async () => {
    const { page, docBody } = createMockPage();
    let resolved = false;
    const promise = waitForHistoryConsent(page).then(() => {
      resolved = true;
    });

    expect(docBody.children.length).toBe(1);
    const button = docBody.children[0];
    expect(button.dataset.chatgptModernHistoryLoad).toBe("true");
    expect(resolved).toBe(false);

    button.onclick?.();
    await promise;
    expect(resolved).toBe(true);
    expect(docBody.children.length).toBe(0);
  });

  test("deduplicates concurrent requests to a single button and resolves all on click", async () => {
    const { page, docBody } = createMockPage();
    let res1 = false;
    let res2 = false;

    const p1 = waitForHistoryConsent(page).then(() => { res1 = true; });
    const p2 = waitForHistoryConsent(page).then(() => { res2 = true; });

    expect(docBody.children.length).toBe(1);
    const button = docBody.children[0];

    button.onclick?.();
    await Promise.all([p1, p2]);
    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(docBody.children.length).toBe(0);
  });

  test("handles individual abort without aborting sibling consent", async () => {
    const { page, docBody } = createMockPage();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();

    let err1: Error | null = null;
    let res2 = false;

    const p1 = waitForHistoryConsent(page, ctrl1.signal).catch((e) => { err1 = e; });
    const p2 = waitForHistoryConsent(page, ctrl2.signal).then(() => { res2 = true; });

    expect(docBody.children.length).toBe(1);
    ctrl1.abort();
    await p1;

    expect(err1?.name).toBe("AbortError");
    expect(docBody.children.length).toBe(1);
    expect(res2).toBe(false);

    docBody.children[0].onclick?.();
    await p2;
    expect(res2).toBe(true);
    expect(docBody.children.length).toBe(0);
  });

  test("aborts and cleans up when pathname changes", async () => {
    const { page, docBody, intervals } = createMockPage("/c/old-conv");
    let err: Error | null = null;
    const p = waitForHistoryConsent(page).catch((e) => { err = e; });

    expect(docBody.children.length).toBe(1);
    expect(intervals.size).toBe(1);

    page.location.pathname = "/c/new-conv";
    page._tick();
    await p;

    expect(err?.name).toBe("AbortError");
    expect(docBody.children.length).toBe(0);
    expect(intervals.size).toBe(0);
  });

  test("fails immediately if signal is already aborted", async () => {
    const { page, docBody } = createMockPage();
    const ctrl = new AbortController();
    ctrl.abort();

    let err: Error | null = null;
    await waitForHistoryConsent(page, ctrl.signal).catch((e) => { err = e; });

    expect(err?.name).toBe("AbortError");
    expect(docBody.children.length).toBe(0);
  });
});
