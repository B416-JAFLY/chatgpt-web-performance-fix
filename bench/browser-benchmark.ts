import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCapturedConversation,
  resolveChromeBinary,
  traceActivePath,
} from "../tests/helpers";
import type { ConversationMessage } from "../src/optimizer";

const chrome = resolveChromeBinary();
const optimizedUserscript = readFileSync(
  "dist/chatgpt-performance-fix.user.js",
  "utf8",
);

function loadBaselineUserscript(): string {
  const proc = Bun.spawnSync([
    "git",
    "show",
    "8f69235:dist/chatgpt-performance-fix.user.js",
  ]);
  if (proc.exitCode === 0 && proc.stdout.byteLength > 0) {
    return new TextDecoder().decode(proc.stdout);
  }
  return optimizedUserscript;
}

const previousForkUserscript = loadBaselineUserscript();
const { payload, text: conversationText } = await loadCapturedConversation();
const activeMessages = traceActivePath(payload)
  .map(({ node }) => node.message)
  .filter((message): message is ConversationMessage => message != null);

const conversationId = "33333333-3333-4333-8333-333333333333";
const switchedConversationId = "aaaa1111-1111-4111-8111-111111111111";

// Construct a 100-code-block assistant reply to benchmark offscreen static code
// lazy loading, DOM node count, scroll frame timing, and memory retention.
const hundredCodeBlocksMarkdown = Array.from({ length: 100 }, (_, blockIdx) => {
  const lines = Array.from(
    { length: 90 },
    (__, lineIdx) =>
      `export const block_${blockIdx}_line_${lineIdx} = "${"x".repeat(64)}_${blockIdx}_${lineIdx}";`,
  ).join("\n");
  return `### Module ${blockIdx + 1}\n\`\`\`ts\n${lines}\n\`\`\``;
}).join("\n\n");

const richBenchmarkMessages: ConversationMessage[] = [
  {
    id: "bench-user-1",
    author: { role: "user" },
    content: {
      content_type: "text",
      parts: ["Generate 100 large TypeScript modules for the benchmark."],
    },
    status: "finished_successfully",
  },
  {
    id: "bench-assistant-1",
    author: { role: "assistant" },
    recipient: "all",
    channel: "final",
    content: {
      content_type: "text",
      parts: [hundredCodeBlocksMarkdown],
    },
    status: "finished_successfully",
  },
];

type VariantName = "native" | "previousFork" | "optimizedFork";

interface VariantBenchmarkResult {
  variant: VariantName;
  jsHeapUsedBytes: number;
  jsHeapUsedMB: number;
  afterSwitchJsHeapUsedBytes: number;
  afterSwitchJsHeapUsedMB: number;
  heapDropBytes: number;
  heapDropMB: number;
  heapDropPercent: number;
  domNodeCountPeak: number;
  domNodeCountAfterScroll: number;
  domNodeCountAfterSwitch: number;
  populatedCodeCharsPeak: number;
  populatedCodeCharsAfterScroll: number;
  readyStaticCodeBlocksAfterLoad: number;
  coldStaticCodeBlocksAfterLoad: number;
  readyStaticCodeBlocksAfterScroll: number;
  coldStaticCodeBlocksAfterScroll: number;
  longTasksCount: number;
  longTasksTotalMs: number;
  inpMedianMs: number;
  inpP95Ms: number;
  inpMaxMs: number;
  scrollFrameP50Ms: number;
  scrollFrameP95Ms: number;
  scrollFrameMaxMs: number;
  scrollJankFramesOver16ms: number;
  mutationObserverCallbacks: number;
  mutationObserverTotalMs: number;
  mutationObserverP95Ms: number;
  mutationObserverMaxMs: number;
}

class CdpClient {
  readonly socket: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id == null) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "CDP command failed"));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)), {
        once: true,
      });
      socket.addEventListener(
        "error",
        () => reject(new Error(`Could not connect to ${url}`)),
        { once: true },
      );
    });
  }

  call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForDevToolsPort(profile: string): Promise<number> {
  const path = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const port = Number(readFileSync(path, "utf8").split(/\r?\n/, 1)[0]);
        if (Number.isInteger(port) && port > 0) return port;
      } catch {
        // Ignore transient Windows EBUSY lock while Chrome writes DevToolsActivePort.
      }
    }
    await Bun.sleep(50);
  }
  throw new Error("Chrome did not publish DevToolsActivePort");
}

function buildBenchmarkHtml(variant: VariantName): string {
  const scriptTag =
    variant === "native"
      ? ""
      : `<script src="/userscript-${variant}.js"></script>`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>A/B/C Benchmark (${variant})</title>
    <script>
      window.__benchMutationSamples = [];
      window.__benchMutationTotalMs = 0;
      window.__benchMutationCallbacks = 0;
      window.__benchLongTasks = [];
      try {
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__benchLongTasks.push(entry.duration);
          }
        });
        po.observe({ entryTypes: ["longtask"] });
      } catch {}

      const NativeMO = window.MutationObserver;
      window.MutationObserver = class BenchInstrumentedMutationObserver extends NativeMO {
        constructor(callback) {
          super((records, observer) => {
            const t0 = performance.now();
            try {
              return callback(records, observer);
            } finally {
              const dt = Math.max(0, performance.now() - t0);
              window.__benchMutationCallbacks += 1;
              window.__benchMutationTotalMs += dt;
              window.__benchMutationSamples.push(dt);
            }
          });
        }
      };
    </script>
    ${scriptTag}
  </head>
  <body>
    <main>
      <div class="thread-scroll-container" id="scroll-root" style="height:720px;width:960px;overflow:auto;position:relative">
        <div id="conversation-root"></div>
      </div>
      <button id="inp-probe-btn" type="button">Interact</button>
    </main>
    <script type="module">
      const variant = ${JSON.stringify(variant)};
      const convId = ${JSON.stringify(conversationId)};
      const switchedId = ${JSON.stringify(switchedConversationId)};

      function percentile(values, p) {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
        return sorted[idx] ?? 0;
      }

      async function measureInteractionLatency() {
        const btn = document.getElementById("inp-probe-btn");
        const samples = [];
        for (let i = 0; i < 12; i += 1) {
          const t0 = performance.now();
          await new Promise((resolve) => {
            btn.addEventListener(
              "click",
              () => {
                requestAnimationFrame(() => {
                  setTimeout(() => {
                    samples.push(Math.max(0, performance.now() - t0));
                    resolve();
                  }, 0);
                });
              },
              { once: true },
            );
            btn.click();
          });
        }
        return samples;
      }

      function renderMarkdownIntoTurn(container, markdownText) {
        // Parse either static code markers or raw fenced code blocks
        const markerRe = /\\[代码块\\]\\((https:\\/\\/chatgpt\\.com\\/#cgptperf-code=[^)]+)\\)/g;
        const markers = [...markdownText.matchAll(markerRe)];
        if (markers.length > 0) {
          for (const match of markers) {
            const p = document.createElement("p");
            const a = document.createElement("a");
            a.href = match[1];
            a.textContent = "代码块";
            p.append(a);
            container.append(p);
          }
          return;
        }
        const fenceRe = /\`\`\`([^\\n\`]*)\\n([\\s\\S]*?)\`\`\`/g;
        for (const match of markdownText.matchAll(fenceRe)) {
          const codeText = match[2] ?? "";
          const wrapper = document.createElement("div");
          wrapper.className = "co8dpq_SmoothedCodeBlock";
          wrapper.setAttribute("data-animate-height", "");
          const editor = document.createElement("div");
          editor.className = "Rx43rG_codemirror";
          const scroller = document.createElement("div");
          scroller.className = "cm-scroller";
          const content = document.createElement("div");
          content.className = "cm-content";
          for (const line of codeText.split("\\n")) {
            const lineEl = document.createElement("div");
            lineEl.className = "cm-line";
            lineEl.textContent = line;
            content.append(lineEl);
          }
          scroller.append(content);
          editor.append(scroller);
          wrapper.append(editor);
          container.append(wrapper);
        }
      }

      window.__runBenchmarkPhase1 = async () => {
        const root = document.getElementById("conversation-root");
        const tLoad0 = performance.now();
        const convRes = await fetch("/backend-api/conversation/" + convId);
        const convData = await convRes.json();
        // Retain the hydrated conversation graph in the active store just as
        // ChatGPT's client state store does while the conversation is open.
        window.__activeConversationStore = {
          payload: convData,
          hydratedNodes: Object.values(convData.mapping ?? {}).map((node) => ({
            id: node.id,
            parent: node.parent,
            children: [...(node.children ?? [])],
            message: node.message ? { ...node.message } : null,
          })),
        };
        // Render the initial payload nodes returned by /backend-api/conversation/:id
        // just as ChatGPT's client does on initial mount.
        const initialFragment = document.createDocumentFragment();
        const mappingNodes = Object.values(convData.mapping ?? {});
        for (let i = 0; i < mappingNodes.length; i += 1) {
          const msg = mappingNodes[i]?.message;
          if (!msg) continue;
          const turnSec = document.createElement("section");
          turnSec.dataset.turn = msg.author?.role === "user" ? "user" : "assistant";
          const msgDiv = document.createElement("div");
          msgDiv.dataset.messageId = msg.id ?? ("init-" + i);
          const textPart = Array.isArray(msg.content?.parts) ? String(msg.content.parts[0] ?? "") : "";
          msgDiv.textContent = textPart.slice(0, 512);
          turnSec.append(msgDiv);
          initialFragment.append(turnSec);
        }
        root.append(initialFragment);
        const tLoadElapsed = performance.now() - tLoad0;
        if (tLoadElapsed > 50) {
          window.__benchLongTasks.push(tLoadElapsed);
        }

        // Render 200 historical user turns into the DOM (simulating "Load All"
        // on a long thread) so delivery verification and scroll observers face
        // a realistic large DOM.
        const histFragment = document.createDocumentFragment();
        for (let i = 0; i < 200; i += 1) {
          const userSec = document.createElement("section");
          userSec.dataset.turn = "user";
          userSec.dataset.testid = "conversation-turn-u-" + i;
          const outerCandidate = document.createElement("div");
          outerCandidate.dataset.messageAuthorRole = "user";
          const innerCandidate = document.createElement("div");
          innerCandidate.dataset.messageAuthorRole = "user";
          innerCandidate.dataset.messageId = "hist-user-" + i;
          innerCandidate.textContent = "Historical user prompt number " + i + " with details";
          outerCandidate.append(innerCandidate);
          userSec.append(outerCandidate);
          histFragment.append(userSec);
        }
        root.append(histFragment);

        // Fetch and render the 100-code-block message page.
        const richRes = await fetch(
          "/backend-api/conversations/" + convId + "/messages?before=bench-rich&num_turns=4",
        );
        const richPage = await richRes.json();
        const richMsg = richPage.messages?.find((m) => m.author?.role === "assistant");
        const richText = richMsg?.content?.parts?.[0] ?? "";

        const richArticle = document.createElement("article");
        richArticle.dataset.messageId = "bench-rich-article";
        const tRender0 = performance.now();
        renderMarkdownIntoTurn(richArticle, richText);
        root.append(richArticle);
        const tRenderElapsed = performance.now() - tRender0;
        if (tRenderElapsed > 50) {
          window.__benchLongTasks.push(tRenderElapsed);
        }

        // Let idle callbacks run so previousFork's eager staticCodeFillQueue
        // executes while optimizedFork keeps offscreen blocks cold.
        await new Promise((r) => setTimeout(r, 500));

        const codeNodes = [...document.querySelectorAll("[data-chatgpt-static-code] code, .cm-content")];
        const populatedCodeCharsPeak = codeNodes.reduce(
          (sum, el) => sum + (el.textContent?.length ?? 0),
          0,
        );
        const readyStaticCodeBlocksAfterLoad = document.querySelectorAll(
          '[data-chatgpt-static-code-state="ready"]',
        ).length;
        const coldStaticCodeBlocksAfterLoad = document.querySelectorAll(
          '[data-chatgpt-static-code-state="cold"]',
        ).length;

        return {
          domNodeCountPeak: document.getElementsByTagName("*").length,
          populatedCodeCharsPeak,
          readyStaticCodeBlocksAfterLoad,
          coldStaticCodeBlocksAfterLoad,
        };
      };

      window.__runBenchmarkPhase2Scroll = async () => {
        const scroller = document.getElementById("scroll-root");
        const frameDurations = [];
        let lastFrame = performance.now();
        for (let step = 0; step < 60; step += 1) {
          await new Promise((resolve) => {
            requestAnimationFrame((now) => {
              const dt = Math.max(0, now - lastFrame);
              lastFrame = now;
              if (step > 0) frameDurations.push(dt);
              scroller.scrollTop += 320;
              scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
              window.dispatchEvent(new Event("scroll"));
              resolve();
            });
          });
        }
        await new Promise((r) => setTimeout(r, 200));

        // Now simulate sending a new user message where React initially renders the
        // optimistic user turn by text (before server assigns data-message-id),
        // followed by 120 streaming DOM mutations while the SSE send request is open.
        const root = document.getElementById("conversation-root");
        const outgoingSec = document.createElement("section");
        outgoingSec.dataset.turn = "user";
        outgoingSec.dataset.testid = "conversation-turn-outgoing";
        const outgoingOuter = document.createElement("div");
        outgoingOuter.dataset.messageAuthorRole = "user";
        const outgoingEl = document.createElement("div");
        outgoingEl.dataset.messageAuthorRole = "user";
        outgoingEl.textContent = "Benchmark outgoing streaming probe";
        outgoingOuter.append(outgoingEl);
        outgoingSec.append(outgoingOuter);
        root.append(outgoingSec);

        const sendPromise = fetch("/backend-api/f/conversation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversation_id: convId,
            messages: [
              {
                id: "bench-outgoing-msg-1",
                author: { role: "user" },
                content: { content_type: "text", parts: ["Benchmark outgoing streaming probe"] },
              },
            ],
          }),
        });
        await new Promise((r) => setTimeout(r, 20));

        const replySec = document.createElement("section");
        replySec.dataset.turn = "assistant";
        replySec.dataset.testid = "conversation-turn-reply";
        const replyEl = document.createElement("div");
        replyEl.className = "agent-turn";
        replyEl.textContent = "Streaming: ";
        replySec.append(replyEl);
        root.append(replySec);
        await new Promise((r) => setTimeout(r, 20));

        // 120 streaming token mutations while SSE send request is still open
        for (let step = 0; step < 120; step += 1) {
          const span = document.createElement("span");
          span.textContent = "token_" + step + " ";
          replyEl.append(span);
          if (step % 15 === 0) {
            await new Promise((r) => setTimeout(r, 4));
          }
        }
        await sendPromise;

        const inpSamples = await measureInteractionLatency();
        const codeNodes = [...document.querySelectorAll("[data-chatgpt-static-code] code, .cm-content")];
        const populatedCodeCharsAfterScroll = codeNodes.reduce(
          (sum, el) => sum + (el.textContent?.length ?? 0),
          0,
        );
        return {
          domNodeCountAfterScroll: document.getElementsByTagName("*").length,
          populatedCodeCharsAfterScroll,
          readyStaticCodeBlocksAfterScroll: document.querySelectorAll(
            '[data-chatgpt-static-code-state="ready"]',
          ).length,
          coldStaticCodeBlocksAfterScroll: document.querySelectorAll(
            '[data-chatgpt-static-code-state="cold"]',
          ).length,
          inpMedianMs: percentile(inpSamples, 0.5),
          inpP95Ms: percentile(inpSamples, 0.95),
          inpMaxMs: Math.max(0, ...inpSamples),
          scrollFrameP50Ms: percentile(frameDurations, 0.5),
          scrollFrameP95Ms: percentile(frameDurations, 0.95),
          scrollFrameMaxMs: Math.max(0, ...frameDurations),
          scrollJankFramesOver16ms: frameDurations.filter((d) => d > 16.7).length,
        };
      };

      window.__runBenchmarkPhase3Switch = async () => {
        const root = document.getElementById("conversation-root");
        window.__activeConversationStore = {
          payload: { current_node: "switched-1", mapping: {} },
          hydratedNodes: [],
        };
        history.pushState({}, "", "/c/" + switchedId);
        window.dispatchEvent(new PopStateEvent("popstate"));
        root.innerHTML = '<article data-message-id="switched-1"><p>Short switched conversation</p></article>';
        await new Promise((r) => setTimeout(r, 300));
        const mutSamples = window.__benchMutationSamples ?? [];
        const longTasks = window.__benchLongTasks ?? [];
        return {
          domNodeCountAfterSwitch: document.getElementsByTagName("*").length,
          longTasksCount: longTasks.length,
          longTasksTotalMs: longTasks.reduce((a, b) => a + b, 0),
          mutationObserverCallbacks: window.__benchMutationCallbacks ?? 0,
          mutationObserverTotalMs: window.__benchMutationTotalMs ?? 0,
          mutationObserverP95Ms: percentile(mutSamples, 0.95),
          mutationObserverMaxMs: Math.max(0, ...mutSamples),
        };
      };

      document.documentElement.dataset.benchReady = "true";
    </script>
  </body>
</html>`;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === `/c/${conversationId}`) {
      const variant = (url.searchParams.get("variant") ?? "native") as VariantName;
      return new Response(buildBenchmarkHtml(variant), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/userscript-previousFork.js") {
      return new Response(previousForkUserscript, {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
    if (url.pathname === "/userscript-optimizedFork.js") {
      return new Response(optimizedUserscript, {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
    if (
      url.pathname === `/backend-api/conversation/${conversationId}` &&
      req.method === "GET"
    ) {
      return new Response(conversationText, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    }
    if (
      url.pathname === `/backend-api/conversations/${conversationId}` &&
      req.method === "GET"
    ) {
      return Response.json({
        title: "Benchmark Conversation",
        conversation_id: conversationId,
        current_node: payload.current_node,
        async_status: null,
        messages: activeMessages.slice(-(565 + 53)),
        page_info: {
          has_previous_page: true,
          start_cursor: "bench-rich",
        },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (
      url.pathname ===
        `/backend-api/conversations/${conversationId}/messages` &&
      req.method === "GET"
    ) {
      return Response.json({
        messages: richBenchmarkMessages,
        page_info: {
          has_previous_page: false,
          start_cursor: null,
        },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === "/backend-api/f/conversation" && req.method === "POST") {
      await Bun.sleep(120);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});

async function getJsHeapUsedBytes(cdp: CdpClient): Promise<number> {
  await cdp.call("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.call<{
    metrics: Array<{ name: string; value: number }>;
  }>("Performance.getMetrics");
  const heap = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  return heap;
}

async function runVariantBenchmark(
  variant: VariantName,
): Promise<VariantBenchmarkResult> {
  const profile = mkdtempSync(join(tmpdir(), `chatgpt-perf-bench-${variant}-`));
  const child = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  try {
    const port = await waitForDevToolsPort(profile);
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then(
      (r) => r.json(),
    )) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const pageTarget = targets.find(
      (t) => t.type === "page" && t.webSocketDebuggerUrl,
    );
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No debuggable page target");
    }

    const cdp = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
    try {
      await cdp.call("Page.enable");
      await cdp.call("Runtime.enable");
      await cdp.call("Performance.enable");
      await cdp.call("HeapProfiler.enable");

      await cdp.call("Page.navigate", {
        url: `http://${server.hostname}:${server.port}/c/${conversationId}?variant=${variant}`,
      });

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const ready = await cdp.call<{ result?: { value?: unknown } }>(
          "Runtime.evaluate",
          {
            expression:
              'document.documentElement.dataset.benchReady === "true"',
            returnByValue: true,
          },
        );
        if (ready.result?.value === true) break;
        await Bun.sleep(40);
      }

      const phase1Eval = await cdp.call<{ result?: { value?: any } }>(
        "Runtime.evaluate",
        {
          expression: "window.__runBenchmarkPhase1()",
          awaitPromise: true,
          returnByValue: true,
        },
      );
      const phase1 = phase1Eval.result?.value;
      const jsHeapUsedBytes = await getJsHeapUsedBytes(cdp);

      const phase2Eval = await cdp.call<{ result?: { value?: any } }>(
        "Runtime.evaluate",
        {
          expression: "window.__runBenchmarkPhase2Scroll()",
          awaitPromise: true,
          returnByValue: true,
        },
      );
      const phase2 = phase2Eval.result?.value;

      const phase3Eval = await cdp.call<{ result?: { value?: any } }>(
        "Runtime.evaluate",
        {
          expression: "window.__runBenchmarkPhase3Switch()",
          awaitPromise: true,
          returnByValue: true,
        },
      );
      const phase3 = phase3Eval.result?.value;
      const afterSwitchJsHeapUsedBytes = await getJsHeapUsedBytes(cdp);

      const heapDropBytes = Math.max(
        0,
        jsHeapUsedBytes - afterSwitchJsHeapUsedBytes,
      );
      const round2 = (n: number) => Math.round(n * 100) / 100;

      return {
        variant,
        jsHeapUsedBytes,
        jsHeapUsedMB: round2(jsHeapUsedBytes / (1024 * 1024)),
        afterSwitchJsHeapUsedBytes,
        afterSwitchJsHeapUsedMB: round2(
          afterSwitchJsHeapUsedBytes / (1024 * 1024),
        ),
        heapDropBytes,
        heapDropMB: round2(heapDropBytes / (1024 * 1024)),
        heapDropPercent:
          jsHeapUsedBytes > 0
            ? round2((heapDropBytes / jsHeapUsedBytes) * 100)
            : 0,
        domNodeCountPeak: phase1.domNodeCountPeak,
        domNodeCountAfterScroll: phase2.domNodeCountAfterScroll,
        domNodeCountAfterSwitch: phase3.domNodeCountAfterSwitch,
        populatedCodeCharsPeak: phase1.populatedCodeCharsPeak,
        populatedCodeCharsAfterScroll: phase2.populatedCodeCharsAfterScroll,
        readyStaticCodeBlocksAfterLoad: phase1.readyStaticCodeBlocksAfterLoad,
        coldStaticCodeBlocksAfterLoad: phase1.coldStaticCodeBlocksAfterLoad,
        readyStaticCodeBlocksAfterScroll:
          phase2.readyStaticCodeBlocksAfterScroll,
        coldStaticCodeBlocksAfterScroll: phase2.coldStaticCodeBlocksAfterScroll,
        longTasksCount: phase3.longTasksCount,
        longTasksTotalMs: round2(phase3.longTasksTotalMs),
        inpMedianMs: round2(phase2.inpMedianMs),
        inpP95Ms: round2(phase2.inpP95Ms),
        inpMaxMs: round2(phase2.inpMaxMs),
        scrollFrameP50Ms: round2(phase2.scrollFrameP50Ms),
        scrollFrameP95Ms: round2(phase2.scrollFrameP95Ms),
        scrollFrameMaxMs: round2(phase2.scrollFrameMaxMs),
        scrollJankFramesOver16ms: phase2.scrollJankFramesOver16ms,
        mutationObserverCallbacks: phase3.mutationObserverCallbacks,
        mutationObserverTotalMs: round2(phase3.mutationObserverTotalMs),
        mutationObserverP95Ms: round2(phase3.mutationObserverP95Ms),
        mutationObserverMaxMs: round2(phase3.mutationObserverMaxMs),
      };
    } finally {
      cdp.close();
    }
  } finally {
    child.kill();
    await child.exited.catch(() => undefined);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Ignore transient Windows profile lock.
    }
  }
}

try {
  const variants: VariantName[] = ["native", "previousFork", "optimizedFork"];
  const results: Record<string, VariantBenchmarkResult> = {};
  for (const variant of variants) {
    results[variant] = await runVariantBenchmark(variant);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    variants: results,
  };

  mkdirSync("analysis/output", { recursive: true });
  await Bun.write(
    "analysis/output/ab-browser-benchmark.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.stop(true);
}
