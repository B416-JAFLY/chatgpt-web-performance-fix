import { mkdirSync, rmSync } from "node:fs";

const VERSION = "0.1.9";

const header = `// ==UserScript==
// @name         ChatGPT Performance Fix (B416-JAFLY fork)
// @name:zh-CN   ChatGPT 性能优化（B416-JAFLY fork）
// @namespace    https://github.com/B416-JAFLY
// @version      ${VERSION}
// @description  Improve ChatGPT performance on long conversations.
// @description:zh-CN 改善 ChatGPT 长会话性能。
// @author       canxin
// @homepageURL  https://github.com/B416-JAFLY/chatgpt-web-performance-fix
// @supportURL   https://github.com/B416-JAFLY/chatgpt-web-performance-fix/issues
// @updateURL    https://raw.githubusercontent.com/B416-JAFLY/chatgpt-web-performance-fix/main/dist/chatgpt-performance-fix.user.js
// @downloadURL  https://raw.githubusercontent.com/B416-JAFLY/chatgpt-web-performance-fix/main/dist/chatgpt-performance-fix.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==
`;

mkdirSync("dist", { recursive: true });
rmSync("dist/.build", { recursive: true, force: true });
rmSync("dist/.worker", { recursive: true, force: true });

const workerResult = await Bun.build({
  entrypoints: ["src/optimizer-worker.ts"],
  outdir: "dist/.worker",
  target: "browser",
  format: "iife",
  minify: true,
  sourcemap: "none",
});
if (!workerResult.success || workerResult.outputs.length !== 1) {
  for (const log of workerResult.logs) console.error(log);
  throw new Error("Optimizer worker build failed");
}
const optimizerWorkerSource = await workerResult.outputs[0].text();

const result = await Bun.build({
  entrypoints: ["src/chatgpt-performance-fix.user.ts"],
  outdir: "dist/.build",
  target: "browser",
  format: "iife",
  minify: false,
  sourcemap: "none",
  define: {
    __CHATGPT_OPTIMIZER_WORKER_SOURCE__: JSON.stringify(optimizerWorkerSource),
  },
});

if (!result.success || result.outputs.length !== 1) {
  for (const log of result.logs) console.error(log);
  throw new Error("Userscript build failed");
}

const bundled = await result.outputs[0].text();
// Safari may run a userscript in an isolated world even with @sandbox raw.
// Install in the page realm; a shared DOM acknowledgement proves execution.
const loader = `(() => {
  const doc = document;
  if (doc.documentElement.dataset.chatgptPageRuntime === "ready") return;
  const channel = "cgptperf-menu-" + Math.random().toString(36).slice(2);
  doc.addEventListener(channel, event => {
    const detail = event.detail;
    if (typeof GM_registerMenuCommand === "function" && detail && typeof detail.label === "string") {
      GM_registerMenuCommand(detail.label, () => doc.dispatchEvent(new CustomEvent(channel + "-" + detail.id)));
    }
  });
  const runtime = '(function(){ const GM_registerMenuCommand = (label, callback) => { const id = Math.random().toString(36).slice(2); document.addEventListener(' + JSON.stringify(channel) + ' + "-" + id, callback); document.dispatchEvent(new CustomEvent(' + JSON.stringify(channel) + ', {detail:{label,id}})); };\\n' + ${JSON.stringify(bundled)} + '\\n})();';
  let observer, timer, attempted = false;
  const inject = () => {
    if (attempted) return;
    const nonce = doc.querySelector('script[nonce]')?.nonce;
    if (!nonce && doc.readyState === "loading") return;
    attempted = true;
    observer?.disconnect(); clearTimeout(timer);
    const script = doc.createElement("script");
    if (nonce) script.nonce = nonce;
    script.textContent = runtime;
    (doc.head || doc.documentElement).append(script);
    script.remove();
    if (doc.documentElement.dataset.chatgptPageRuntime !== "ready") doc.documentElement.dataset.chatgptPageRuntime = "blocked";
  };
  observer = new MutationObserver(inject);
  observer.observe(doc.documentElement, {childList:true,subtree:true});
  doc.addEventListener("DOMContentLoaded", inject, {once:true});
  timer = setTimeout(() => { inject(); observer.disconnect(); }, 3000);
  inject();
})();`;
await Bun.write("dist/chatgpt-performance-fix.user.js", `${header}\n${loader}`);
rmSync("dist/.build", { recursive: true, force: true });
rmSync("dist/.worker", { recursive: true, force: true });

console.log(
  `Built dist/chatgpt-performance-fix.user.js (${(
    (header.length + bundled.length) /
    1024
  ).toFixed(1)} KiB)`,
);
