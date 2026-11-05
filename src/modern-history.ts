/** Pause only the request already initiated by ChatGPT. Never invent cursors. */
export function waitForHistoryConsent(page: Window & typeof globalThis, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const path = page.location.pathname;
    const button = page.document.createElement("button");
    button.type = "button";
    button.dataset.chatgptModernHistoryLoad = "true";
    button.textContent = "加载较早消息";
    button.style.cssText = "position:fixed;right:24px;bottom:100px;z-index:1000;padding:10px 16px;border:1px solid #888;border-radius:12px;background:var(--main-surface-primary,#fff);color:var(--text-primary,#222);cursor:pointer";
    let timer: number | undefined;
    const cleanup = () => {
      button.remove();
      if (timer != null) page.clearInterval(timer);
      signal?.removeEventListener("abort", abort);
      page.removeEventListener("pagehide", abort);
    };
    const abort = () => { cleanup(); reject(new page.DOMException("History request cancelled", "AbortError")); };
    button.onclick = () => { cleanup(); resolve(); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    page.addEventListener("pagehide", abort, { once: true });
    timer = page.setInterval(() => { if (page.location.pathname !== path) abort(); }, 250);
    (page.document.body ?? page.document.documentElement).append(button);
  });
}
