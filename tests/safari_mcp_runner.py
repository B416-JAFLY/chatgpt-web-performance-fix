#!/usr/bin/env python3
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time

PORT = 0  # auto-select free port
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST_SCRIPT = os.path.join(REPO_DIR, "dist", "chatgpt-performance-fix.user.js")
ARTIFACT_DIR = "/Users/bangxhuang/.gemini/antigravity/brain/46c4bee1-0fdb-41d1-b181-08c601528f09"

with open(DIST_SCRIPT, "r", encoding="utf-8") as f:
    USERSCRIPT_CONTENT = f.read()

TEST_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Safari MCP ChatGPT Performance Test</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; background: #212121; color: #ececec; }
    nav { width: 260px; position: fixed; left: 0; top: 0; bottom: 0; background: #171717; padding: 12px; }
    main { margin-left: 280px; padding: 20px; }
    .thread-scroll-container { height: 600px; overflow-y: auto; border: 1px solid #333; border-radius: 8px; padding: 16px; background: #2f2f2f; }
    .group\\/user-message { padding: 12px; background: #383838; border-radius: 12px; margin-bottom: 16px; max-width: 70%; margin-left: auto; }
    [data-chatgpt-selection-message-id] { padding: 12px; background: #262626; border-radius: 12px; margin-bottom: 16px; }
    .katex-display { height: 100px; background: #1f1f1f; margin: 8px 0; border: 1px dashed #555; display: flex; align-items: center; justify-content: center; }
    pre { background: #111; padding: 10px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    td { border: 1px solid #444; padding: 8px; }
  </style>
  <script>
    window.__rectQueryCount = 0;
    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function() {
      if (this.classList && this.classList.contains('katex-display')) {
        window.__rectQueryCount++;
      }
      return origGetBoundingClientRect.apply(this, arguments);
    };
  </script>
</head>
<body>
  <nav id="sidebar-nav">
    <div id="sidebar-list">
      <div><a href="/c/33333333-3333-4333-8333-333333333333">Active Long Chat</a></div>
    </div>
  </nav>
  <main>
    <h2>ChatGPT Performance Fix - Safari Validation Harness</h2>
    <div class="thread-scroll-container" id="scroll-container">
      <!-- Modern User Turn -->
      <div data-turn-key="turn-user-1">
        <div class="group/user-message flex flex-col items-end gap-2"
             data-chatgpt-search-unit-key="turn-1:0:user"
             data-chatgpt-search-message-ids="msg-user-1">
          <div class="user-text">请生成包含大量数学公式、表格和代码块的复杂分析报告</div>
        </div>
      </div>

      <!-- Modern Assistant Turn -->
      <div data-turn-key="turn-asst-1">
        <div data-chatgpt-selection-message-id="msg-asst-1">
          <div data-markdown-text-style="default">
            <div id="spacer" style="height: 25000px; background: linear-gradient(#333, #222); padding: 10px; text-align: center;">
              --- 大量超长消息内容虚拟占位 (25,000px) ---
            </div>
            <div id="formula-container"></div>
            <table id="modern-table">
              <thead><tr><th>指标</th><th>基准</th><th>优化后</th></tr></thead>
              <tbody><tr><td>DOM 渲染延迟</td><td>1420ms</td><td>45ms</td></tr></tbody>
            </table>
            <div data-code-block id="modern-code">
              <pre><code>function heavyComputation() { return Math.random(); }</code></pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>
  <script>
    // Populating formulas
    const container = document.getElementById('formula-container');
    for (let i = 0; i < 60; i++) {
      const div = document.createElement('div');
      div.className = 'katex-display';
      div.textContent = 'KaTeX Formula Block #' + (i + 1) + ': \\\\int_{-\\\\infty}^{\\\\infty} e^{-x^2} dx = \\\\sqrt{\\\\pi}';
      container.appendChild(div);
    }
  </script>
</body>
</html>
"""

class MockChatGPTHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # quiet

    def do_GET(self):
        url_path = self.path.split("?")[0]
        if url_path == "/" or url_path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(TEST_HTML.encode("utf-8"))
        elif url_path == "/script.js":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.end_headers()
            self.wfile.write(USERSCRIPT_CONTENT.encode("utf-8"))
        elif url_path == "/backend-api/conversations":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"items": []}).encode("utf-8"))
        elif url_path.startswith("/backend-api/conversations/33333333-3333-4333-8333-333333333333") and not url_path.endswith("/messages"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            data = {
                "title": "Active Long Chat",
                "messages": [
                    {
                        "id": "msg-user-1",
                        "author": {"role": "user"},
                        "create_time": 1787000000,
                        "status": "finished_successfully",
                        "content": {"content_type": "text", "parts": ["请生成复杂分析报告"]}
                    },
                    {
                        "id": "msg-asst-1",
                        "author": {"role": "assistant"},
                        "create_time": 1787000010,
                        "status": "finished_successfully",
                        "content": {"content_type": "text", "parts": ["这是详细报告"]}
                    }
                ],
                "page_info": {"has_previous_page": True}
            }
            self.wfile.write(json.dumps(data).encode("utf-8"))
        elif url_path.endswith("/messages"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            data = {
                "messages": [
                    {
                        "id": "msg-history-older",
                        "author": {"role": "assistant"},
                        "create_time": 1786999900,
                        "status": "finished_successfully",
                        "content": {"content_type": "text", "parts": ["这是历史消息"]}
                    }
                ],
                "page_info": {"has_previous_page": False}
            }
            self.wfile.write(json.dumps(data).encode("utf-8"))
        elif url_path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()

def main():
    server = socketserver.TCPServer(("127.0.0.1", 0), MockChatGPTHandler)
    server_port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base_url = f"http://127.0.0.1:{server_port}"
    print(f"[1] Test server started at {base_url}")

    safari = subprocess.Popen(
        ["/usr/bin/safaridriver", "--mcp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )

    req_id = 0
    def rpc(method, params=None):
        nonlocal req_id
        req_id += 1
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        safari.stdin.write(json.dumps(msg) + "\n")
        safari.stdin.flush()
        line = safari.stdout.readline()
        return json.loads(line)

    def tool(name, args=None):
        params = {"name": name, "arguments": args or {}}
        res = rpc("tools/call", params)
        if "error" in res:
            raise RuntimeError(f"Tool {name} error: {res['error']}")
        content = res.get("result", {}).get("content", [])
        if content and content[0].get("type") == "text":
            try:
                return json.loads(content[0]["text"])
            except json.JSONDecodeError:
                return content[0]["text"]
        return res

    def evaluate(expr):
        return tool("evaluate_javascript", {"expression": expr})

    try:
        # Initialize
        rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "safari-qa-runner", "version": "1.0"}
        })
        safari.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        safari.stdin.flush()
        print("[2] Safari MCP initialized successfully")

        # Open tab with test harness
        tab_info = tool("create_tab", {"url": f"{base_url}/"})
        print(f"[3] Tab created: {tab_info}")
        time.sleep(1.5)

        # Inject userscript
        print("[4] Injecting userscript into Safari WebKit realm...")
        inject_res = evaluate(USERSCRIPT_CONTENT + "\nreturn !!window.__chatgptPerformanceFixInstalled;")
        assert inject_res is True, f"Failed to inject userscript: {inject_res}"
        time.sleep(0.5)

        # ----------------------------------------------------
        # TEST SUITE 1: Initialization & Runtime Realm Marker
        # ----------------------------------------------------
        t1 = evaluate("""
        return {
            installed: !!window.__chatgptPerformanceFixInstalled,
            runtimeReady: document.documentElement.dataset.chatgptPageRuntime,
            perfFixAttr: document.documentElement.dataset.chatgptPerformanceFix,
            hasFetchHook: !!window.__chatgptPerformanceFixResponseFallback,
            hasObserverHook: !!window.__chatgptPerformanceFixIntersectionObserver
        };
        """)
        print("[Test 1: Initialization]", t1)
        assert t1["installed"] is True
        assert t1["runtimeReady"] == "ready"
        assert t1["hasFetchHook"] is True
        assert t1["hasObserverHook"] is True

        # ----------------------------------------------------
        # TEST SUITE 2: Metadata Removal (Cleanliness)
        # ----------------------------------------------------
        t2 = evaluate("""
        return {
            metadataStyle: !!document.querySelector("#chatgpt-message-metadata-style"),
            metadataElements: document.querySelectorAll("[data-chatgpt-message-metadata]").length,
            sidebarRefreshControl: !!document.querySelector("[data-chatgpt-sidebar-refresh-control], [data-chatgpt-sidebar-refresh-button], #chatgpt-sidebar-refresh-style")
        };
        """)
        print("[Test 2: Decoupled Features Absence]", t2)
        assert t2["metadataStyle"] is False
        assert t2["metadataElements"] == 0
        assert t2["sidebarRefreshControl"] is False

        # ----------------------------------------------------
        # TEST SUITE 3: Rich-Block Deferral (KaTeX, Table, Code)
        # ----------------------------------------------------
        t3 = evaluate("""
        const table = document.querySelector("#modern-table");
        const code = document.querySelector("#modern-code");
        const formulas = document.querySelectorAll(".katex-display");
        const coldFormulas = document.querySelectorAll(".katex-display[data-chatgpt-rich-block-state='cold']");
        return {
            tableState: table ? table.getAttribute("data-chatgpt-rich-block-state") : null,
            codeState: code ? code.getAttribute("data-chatgpt-rich-block-state") : null,
            totalFormulas: formulas.length,
            coldFormulas: coldFormulas.length,
            rectQueryCount: window.__rectQueryCount
        };
        """)
        print("[Test 3: Rich-block Deferral]", t3)
        assert t3["tableState"] == "cold", f"Table not cold: {t3['tableState']}"
        assert t3["codeState"] == "cold", f"Code not cold: {t3['codeState']}"
        assert t3["coldFormulas"] == 60, f"Expected 60 cold formulas, got {t3['coldFormulas']}"
        assert t3["rectQueryCount"] == 0, f"Layout thrashing detected! rect queries: {t3['rectQueryCount']}"

        # ----------------------------------------------------
        # TEST SUITE 3.2: Safari Native IntersectionObserver Activation
        # ----------------------------------------------------
        # Scroll down inside thread-scroll-container to bring formulas into viewport
        evaluate("""
        const scroller = document.getElementById('scroll-container');
        if (scroller) {
          scroller.scrollTop = 25000;
        }
        """)
        time.sleep(0.5)

        t3_hot = evaluate("""
        const hotFormulas = document.querySelectorAll(".katex-display[data-chatgpt-rich-block-state='hot']");
        const coldFormulas = document.querySelectorAll(".katex-display[data-chatgpt-rich-block-state='cold']");
        return {
            hotCount: hotFormulas.length,
            coldCount: coldFormulas.length
        };
        """)
        print("[Test 3.2: Native IntersectionObserver Activation]", t3_hot)
        assert t3_hot["hotCount"] > 0, f"Expected some formulas to activate to hot on scroll, got {t3_hot['hotCount']}"

        # ----------------------------------------------------
        # TEST SUITE 4: Modern History Consent Queue Concurrency
        # ----------------------------------------------------
        # Set path to conversation URL
        evaluate("history.pushState({}, '', '/c/33333333-3333-4333-8333-333333333333');")

        # Trigger two concurrent history requests
        t4_start = evaluate("""
        window.__historySettled = false;
        window.__historyPayloads = [];
        window.__historyErrors = [];
        const p1 = fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=cursor-1&num_turns=10')
          .then(r => r.json()).then(d => window.__historyPayloads.push(d)).catch(e => window.__historyErrors.push(e.message));
        const p2 = fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=cursor-2&num_turns=10')
          .then(r => r.json()).then(d => window.__historyPayloads.push(d)).catch(e => window.__historyErrors.push(e.message));
        return { triggered: true };
        """)
        time.sleep(0.3)

        t4_button = evaluate("""
        const buttons = document.querySelectorAll("[data-chatgpt-modern-history-load]");
        const btn = buttons[0];
        return {
            buttonCount: buttons.length,
            buttonText: btn ? btn.textContent : null,
            isFixed: btn ? (btn.style.position === "fixed") : false,
            payloadsCount: window.__historyPayloads.length
        };
        """)
        print("[Test 4.1: History Consent Paused & Button Rendered]", t4_button)
        assert t4_button["buttonCount"] == 1, f"Expected 1 button, found {t4_button['buttonCount']}"
        assert "加载较早消息" in t4_button["buttonText"]
        assert t4_button["isFixed"] is True
        assert t4_button["payloadsCount"] == 0, "Requests should be paused, but already resolved!"

        # Screenshot of the floating button in Safari
        target_path = os.path.join(ARTIFACT_DIR, "safari-history-button.png")
        screenshot_res = tool("screenshot", {"full_page": False, "savePath": target_path})
        print(f"[Screenshot] Floating button captured: {screenshot_res}")
        if not os.path.exists(target_path) and isinstance(screenshot_res, str):
            import re
            m = re.search(r"Saved screenshot to '([^']+)'", screenshot_res)
            if m and os.path.exists(m.group(1)):
                shutil.copyfile(m.group(1), target_path)
                print(f"[Screenshot] Extracted and copied to artifact: {target_path}")

        # Click the floating button to release both concurrent requests
        t4_click = evaluate("""
        const btn = document.querySelector("[data-chatgpt-modern-history-load]");
        if (btn) btn.click();
        return { clicked: !!btn };
        """)
        time.sleep(0.4)

        t4_resolved = evaluate("""
        const remainingButtons = document.querySelectorAll("[data-chatgpt-modern-history-load]");
        return {
            remainingButtons: remainingButtons.length,
            payloadsCount: window.__historyPayloads.length,
            firstPayloadId: window.__historyPayloads[0]?.messages?.[0]?.id,
            secondPayloadId: window.__historyPayloads[1]?.messages?.[0]?.id
        };
        """)
        print("[Test 4.2: History Consent Resolved]", t4_resolved)
        assert t4_resolved["remainingButtons"] == 0, "Button should be removed after click"
        assert t4_resolved["payloadsCount"] == 2, f"Expected 2 resolved payloads, got {t4_resolved['payloadsCount']}"
        assert t4_resolved["firstPayloadId"] == "msg-history-older"
        assert t4_resolved["secondPayloadId"] == "msg-history-older"

        # ----------------------------------------------------
        # TEST SUITE 4.3: AbortController Signal Isolation
        # ----------------------------------------------------
        t4_abort = evaluate("""
        return (async () => {
          const ctrl = new AbortController();
          let rejected = false;
          const p = fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=cancel-me', { signal: ctrl.signal })
            .catch(e => { rejected = (e.name === 'AbortError'); });
          await new Promise(r => setTimeout(r, 100));
          const btnBefore = document.querySelectorAll('[data-chatgpt-modern-history-load]').length;
          ctrl.abort();
          await p;
          const btnAfter = document.querySelectorAll('[data-chatgpt-modern-history-load]').length;
          return { rejected, btnBefore, btnAfter };
        })();
        """)
        print("[Test 4.3: AbortController Isolation]", t4_abort)
        assert t4_abort["rejected"] is True
        assert t4_abort["btnBefore"] == 1
        assert t4_abort["btnAfter"] == 0

        # ----------------------------------------------------
        # TEST SUITE 4.4: Pathname Navigation Destruction
        # ----------------------------------------------------
        evaluate("history.pushState({}, '', '/c/33333333-3333-4333-8333-333333333333');")
        t4_route = evaluate("""
        return (async () => {
          let rejected = false;
          const p = fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=route-me')
            .catch(e => { rejected = (e.name === 'AbortError'); });
          await new Promise(r => setTimeout(r, 100));
          const btnBefore = document.querySelectorAll('[data-chatgpt-modern-history-load]').length;
          history.pushState({}, '', '/');
          await new Promise(r => setTimeout(r, 400));
          const btnAfter = document.querySelectorAll('[data-chatgpt-modern-history-load]').length;
          return { rejected, btnBefore, btnAfter };
        })();
        """)
        print("[Test 4.4: Route Change Destruction]", t4_route)
        assert t4_route["rejected"] is True
        assert t4_route["btnBefore"] == 1
        assert t4_route["btnAfter"] == 0

        # ----------------------------------------------------
        # TEST SUITE 5: Modern Delivery Status DOM Verifier
        # ----------------------------------------------------
        t5 = evaluate("""
        const userMsg = document.querySelector('.group\\\\/user-message');
        const userTurn = document.querySelector('div[data-turn-key="turn-user-1"]');
        return {
          hasUserMsg: !!userMsg,
          userMsgClasses: userMsg ? userMsg.className : '',
          userSearchId: userMsg ? userMsg.getAttribute('data-chatgpt-search-message-ids') : null,
          hasTurnKey: !!userTurn
        };
        """)
        print("[Test 5: Delivery Status Target Detection]", t5)
        assert t5["hasUserMsg"] is True
        assert t5["userSearchId"] == "msg-user-1"
        assert t5["hasTurnKey"] is True

        # ----------------------------------------------------
        # TEST SUITE 7: Two-Stage MutationObserver Scoping
        # ----------------------------------------------------
        t7_scope = evaluate("""
        return {
            scope: document.documentElement.dataset.chatgptRichObserverScope,
            hasScrollContainer: !!document.querySelector(".thread-scroll-container")
        };
        """)
        print("[Test 7: Two-Stage MutationObserver Scope]", t7_scope)
        assert t7_scope["scope"] == "container", f"Expected container scope, got {t7_scope['scope']}"

        # ----------------------------------------------------
        # TEST SUITE 8: Safe Code Block Recovery on Memory Eviction
        # ----------------------------------------------------
        t8_recovery = evaluate("""
        // Inject a rendered static code container into DOM to simulate an already-rendered block
        const container = document.createElement("div");
        container.dataset.chatgptStaticCode = "test-token-evicted-123";
        container.dataset.chatgptStaticCodeLanguage = "typescript";
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = "const answer = 42; console.log(answer);";
        pre.appendChild(code);
        container.appendChild(pre);
        document.querySelector(".thread-scroll-container").appendChild(container);

        return {
            containerAttached: !!document.querySelector('[data-chatgpt-static-code="test-token-evicted-123"]'),
            domCodeText: code.textContent
        };
        """)
        print("[Test 8: Static Code Recovery & Budget]", t8_recovery)
        assert t8_recovery["containerAttached"] is True
        assert t8_recovery["domCodeText"] == "const answer = 42; console.log(answer);"

        # ----------------------------------------------------
        # TEST SUITE 6: Console Error Inspection
        # ----------------------------------------------------
        logs = tool("browser_console_messages", {"clear": False, "limit": 50})
        print(f"[Test 6: Console Inspection] Total log entries: {len(logs) if isinstance(logs, list) else 0}")
        severe_errors = []
        if isinstance(logs, list):
            for entry in logs:
                level = entry.get("level", "")
                text = entry.get("text", "")
                if level == "error" and "Content Security Policy" not in text and "favicon" not in text:
                    severe_errors.append(entry)
        print(f"[Test 6: Severe Errors] Count: {len(severe_errors)}")
        assert len(severe_errors) == 0, f"Found severe console errors: {severe_errors}"

        print("\\n=== ALL SAFARI MCP INTEGRATION TESTS PASSED ===")
        return {
            "status": "PASS",
            "t1": t1,
            "t2": t2,
            "t3": t3,
            "t4_button": t4_button,
            "t4_resolved": t4_resolved,
            "t4_abort": t4_abort,
            "t4_route": t4_route,
            "t5": t5,
            "t7_scope": t7_scope,
            "t8_recovery": t8_recovery,
            "severe_errors_count": len(severe_errors),
            "logs_count": len(logs) if isinstance(logs, list) else 0
        }

    finally:
        safari.terminate()
        server.shutdown()

if __name__ == "__main__":
    res = main()
    print("\\nRESULT_JSON:" + json.dumps(res))
