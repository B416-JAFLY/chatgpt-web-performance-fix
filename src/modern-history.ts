/** Pause only the request already initiated by ChatGPT. Never invent cursors. */

interface PendingConsent {
  resolve: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal | null;
  cleanupSignal?: () => void;
}

let activePath: string | null = null;
const activePending = new Set<PendingConsent>();
let activeButton: HTMLElement | null = null;
let activeTimer: number | undefined;

export function waitForHistoryConsent(
  page: Window & typeof globalThis,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new page.DOMException("History request cancelled", "AbortError"));
      return;
    }

    const path = page.location.pathname;

    const cleanupActive = () => {
      if (activeButton) {
        activeButton.remove();
        activeButton = null;
      }
      if (activeTimer != null) {
        page.clearInterval(activeTimer);
        activeTimer = undefined;
      }
      activePath = null;
    };

    const abortAll = () => {
      cleanupActive();
      const pendingList = [...activePending];
      activePending.clear();
      for (const item of pendingList) {
        item.cleanupSignal?.();
        item.reject(new page.DOMException("History request cancelled", "AbortError"));
      }
    };

    if (activePath !== null && activePath !== path) {
      abortAll();
    }

    const consentItem: PendingConsent = { resolve, reject, signal };

    const abortThisItem = () => {
      consentItem.cleanupSignal?.();
      activePending.delete(consentItem);
      reject(new page.DOMException("History request cancelled", "AbortError"));
      if (activePending.size === 0) {
        cleanupActive();
      }
    };

    if (signal) {
      const onAbort = () => abortThisItem();
      signal.addEventListener("abort", onAbort, { once: true });
      consentItem.cleanupSignal = () => signal.removeEventListener("abort", onAbort);
    }

    activePending.add(consentItem);
    activePath = path;

    if (!activeButton) {
      const button = page.document.createElement("button");
      button.type = "button";
      button.dataset.chatgptModernHistoryLoad = "true";
      button.textContent = "加载较早消息";
      button.style.cssText =
        "position:fixed;right:24px;bottom:100px;z-index:1000;padding:10px 16px;border:1px solid #888;border-radius:12px;background:var(--main-surface-primary,#fff);color:var(--text-primary,#222);cursor:pointer";

      button.onclick = () => {
        cleanupActive();
        const pendingList = [...activePending];
        activePending.clear();
        for (const item of pendingList) {
          item.cleanupSignal?.();
          item.resolve();
        }
      };

      page.addEventListener("pagehide", abortAll, { once: true });
      activeTimer = page.setInterval(() => {
        if (page.location.pathname !== activePath) {
          abortAll();
        }
      }, 250);

      (page.document.body ?? page.document.documentElement).append(button);
      activeButton = button;
    }
  });
}
