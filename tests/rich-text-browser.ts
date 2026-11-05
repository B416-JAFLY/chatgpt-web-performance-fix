import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChromeBinary } from "./helpers";

const script = readFileSync("dist/chatgpt-performance-fix.user.js", "utf8");
const html = `<!doctype html><meta charset="utf-8"><script>
window.__rects=0;const original=Element.prototype.getBoundingClientRect;
window.__nativeFetch=window.fetch.bind(window);
window.Worker=undefined;
Element.prototype.getBoundingClientRect=function(){if(this.matches('.katex-display'))window.__rects++;return original.call(this)};
window.__observers=[];
window.IntersectionObserver=class {
 constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();window.__observers.push(this)}
 observe(target){this.targets.add(target)} unobserve(target){this.targets.delete(target)} disconnect(){this.targets.clear()} takeRecords(){return []}
};
</script><script src="/script.js"></script><nav><div id="sidebar-list"><div><a href="/c/33333333-3333-4333-8333-333333333333">First conversation</a></div></div></nav><main><div class="thread-scroll-container" style="height:600px;overflow:auto"><div data-turn-key="fixture-user"><div class="group/user-message flex flex-col items-end gap-2" data-chatgpt-search-unit-key="turn-1:0:user" data-chatgpt-search-message-ids="fixture-user-message"><div class="user-text">hello user</div></div></div><div data-turn-key="fixture"><div data-chatgpt-selection-message-id="fixture-message"><div data-markdown-text-style="default"><div style="height:30000px"></div><div id="blocks"></div><table id="modern-table"><tr><td>fixture</td></tr></table><div data-code-block id="modern-code"><pre>fixture</pre></div></div></div></div></div></main><pre id="result">PENDING</pre><script>
(async()=>{try {
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const response=await window.__nativeFetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333?num_turns=2');
 const payload=await response.json();
 if(payload.messages?.[0]?.id!=='fixture-user-message')throw Error('response was changed');
 await wait(300);
 if(document.querySelector('[data-chatgpt-message-metadata]'))throw Error('unexpected message metadata rendered');
 const blocks=document.querySelector('#blocks');
 for(let i=0;i<80;i++){const x=document.createElement('div');x.className='katex-display';x.style.height='120px';x.textContent='formula';blocks.append(x)}
 await wait(300);
 const sidebar=document.querySelector('#sidebar-list');
 sidebar.append(document.createElement('div'));await wait(100);
 if(document.querySelector('[data-chatgpt-sidebar-refresh-control], [data-chatgpt-sidebar-refresh-button], #chatgpt-sidebar-refresh-style'))throw Error('unexpected sidebar refresh control');
 if(sidebar.firstElementChild?.querySelector('a')?.textContent!=='First conversation')throw Error('first sidebar entry changed');
 if(document.querySelectorAll('[data-chatgpt-rich-block-state=cold]').length!==82)throw Error('far blocks not cold');
 if(document.querySelector('#modern-table').getAttribute('data-chatgpt-rich-block-state')!=='cold')throw Error('modern ChatGPT table not detected');
 if(document.querySelector('#modern-code').getAttribute('data-chatgpt-rich-block-state')!=='cold')throw Error('modern code block not detected');
 window.scrollTo(0,100);await wait(200);
 if(window.__rects!==0)throw Error('scroll queried block geometry '+window.__rects);
 const item=blocks.firstElementChild;
 const observer=window.__observers.find(o=>o.targets.has(item));
 if(!observer)throw Error('block was not observed');
 if(observer.options.root!==document.querySelector('.thread-scroll-container'))throw Error('incorrect scroll root');
 item.remove();await wait(100);
 if(observer.targets.has(item))throw Error('detached block remains observed');
 blocks.prepend(item);await wait(100);
 if(!observer.targets.has(item))throw Error('reinserted block not observed');
 observer.callback([{target:item,isIntersecting:true,boundingClientRect:{top:0,bottom:100}}]);await wait(100);
 if(item.getAttribute('data-chatgpt-rich-block-state')!=='hot')throw Error('reinserted block did not activate');
 history.pushState({},'', '/c/33333333-3333-4333-8333-333333333333');
 let settled=false;
 const pending=fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=server-cursor&num_turns=10').then(r=>{settled=true;return r});
 const pending2=fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=server-cursor-2&num_turns=10');
 await wait(300);
 if(settled)throw Error('history was not paused');
 const loadButtons=document.querySelectorAll('[data-chatgpt-modern-history-load]');
 if(loadButtons.length!==1)throw Error('expected exactly 1 modern history load button, found '+loadButtons.length);
 loadButtons[0].click();
 const [res1, res2]=await Promise.all([pending, pending2]);
 const historyPayload=await res1.json();
 if(historyPayload.messages?.[0]?.id!=='history-message')throw Error('history response changed');
 const historyPayload2=await res2.json();
 if(historyPayload2.messages?.[0]?.id!=='history-message')throw Error('history response 2 changed');
 const controller=new AbortController();
 const cancelled=fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=next', {signal:controller.signal}).then(()=>false,e=>e.name==='AbortError');
 await wait(100);controller.abort();
 if(!await cancelled || document.querySelector('[data-chatgpt-modern-history-load]'))throw Error('history cancellation failed');
 const routed=fetch('/backend-api/conversations/33333333-3333-4333-8333-333333333333/messages?before=route').then(()=>false,e=>e.name==='AbortError');
 await wait(100);history.pushState({},'', '/');await wait(400);
 if(!await routed || document.querySelector('[data-chatgpt-modern-history-load]'))throw Error('route cancellation failed');
 document.querySelector('#result').textContent='PASS';
 }catch(e){document.querySelector('#result').textContent='FAIL '+e.message}})();
</script>`;
let sidebarRequests = 0;
let historyRequests = 0;
const server = Bun.serve({hostname:"127.0.0.1", port:0, fetch(req) {
 const pathname = new URL(req.url).pathname;
 if (pathname === "/backend-api/conversations") sidebarRequests++;
 if (pathname.endsWith('/messages')) { historyRequests++; return Response.json({messages:[{id:'history-message'}],page_info:{has_previous_page:false}}); }
 if (pathname === "/backend-api/conversations/33333333-3333-4333-8333-333333333333") return Response.json({messages:[{id:"fixture-user-message",author:{role:"user"},create_time:1699999900,status:"finished_successfully",content:{content_type:"text",parts:["hello user"]}},{id:new URL(req.url).searchParams.has("format")?"text-message":"fixture-message",author:{role:"assistant"},create_time:1700000000,status:"finished_successfully",channel:"final",content:{content_type:"text",parts:["fixture"]},metadata:{model_slug:"fixture-model"}}],page_info:{has_previous_page:false}});
 return pathname === "/script.js"
  ? new Response(script, {headers:{"content-type":"text/javascript; charset=utf-8"}})
  : new Response(html, {headers:{"content-type":"text/html; charset=utf-8"}});
}});
const profile = mkdtempSync(join(tmpdir(), "rich-text-test-"));
try {
 const chrome = resolveChromeBinary();
 const proc = Bun.spawn([chrome,"--headless=new","--disable-gpu","--no-first-run",`--user-data-dir=${profile}`,"--virtual-time-budget=12000","--dump-dom",server.url.href], {stdout:"pipe",stderr:"pipe"});
 const output = await new Response(proc.stdout).text();
 const error = await new Response(proc.stderr).text();
 if (await proc.exited !== 0 || !output.includes('<pre id="result">PASS</pre>')) throw Error(`Browser regression failed: ${output.match(/<pre id="result">[^<]*/)?.[0] ?? output.slice(-1000)} ${error.slice(-300)}`);
 if (sidebarRequests !== 0) throw Error(`Unexpected sidebar requests: ${sidebarRequests}`);
 if (historyRequests !== 2) throw Error(`Unexpected history requests: ${historyRequests}`);
 console.log("Rich-text browser regression passed");
} finally { server.stop(true); rmSync(profile,{recursive:true,force:true}); }
