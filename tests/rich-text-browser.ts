import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync("dist/chatgpt-performance-fix.user.js", "utf8");
const html = `<!doctype html><meta charset="utf-8"><script>
window.__rects=0;const original=Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect=function(){if(this.matches('.katex-display'))window.__rects++;return original.call(this)};
window.__observers=[];
window.IntersectionObserver=class {
 constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();window.__observers.push(this)}
 observe(target){this.targets.add(target)} unobserve(target){this.targets.delete(target)} disconnect(){this.targets.clear()} takeRecords(){return []}
};
</script><script src="/script.js"></script><nav><div id="sidebar-list"><div><a href="/c/33333333-3333-4333-8333-333333333333">First conversation</a></div></div></nav><main><div class="thread-scroll-container" style="height:600px;overflow:auto"><div data-turn-key="fixture"><div data-markdown-text-style="default"><div style="height:30000px"></div><div id="blocks"></div><table id="modern-table"><tr><td>fixture</td></tr></table></div></div></div></main><pre id="result">PENDING</pre><script>
(async()=>{try {
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const blocks=document.querySelector('#blocks');
 for(let i=0;i<80;i++){const x=document.createElement('div');x.className='katex-display';x.style.height='120px';x.textContent='formula';blocks.append(x)}
 await wait(300);
 const sidebar=document.querySelector('#sidebar-list');
 sidebar.append(document.createElement('div'));await wait(100);
 if(document.querySelector('[data-chatgpt-sidebar-refresh-control], [data-chatgpt-sidebar-refresh-button], #chatgpt-sidebar-refresh-style'))throw Error('unexpected sidebar refresh control');
 if(sidebar.firstElementChild?.querySelector('a')?.textContent!=='First conversation')throw Error('first sidebar entry changed');
 if(document.querySelectorAll('[data-chatgpt-rich-block-state=cold]').length!==81)throw Error('far blocks not cold');
 if(document.querySelector('#modern-table').getAttribute('data-chatgpt-rich-block-state')!=='cold')throw Error('modern ChatGPT table not detected');
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
 document.querySelector('#result').textContent='PASS';
 }catch(e){document.querySelector('#result').textContent='FAIL '+e.message}})();
</script>`;
let sidebarRequests = 0;
const server = Bun.serve({hostname:"127.0.0.1", port:0, fetch(req) {
 const pathname = new URL(req.url).pathname;
 if (pathname === "/backend-api/conversations") sidebarRequests++;
 return pathname === "/script.js"
  ? new Response(script, {headers:{"content-type":"text/javascript; charset=utf-8"}})
  : new Response(html, {headers:{"content-type":"text/html; charset=utf-8"}});
}});
const profile = mkdtempSync(join(tmpdir(), "rich-text-test-"));
try {
 const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
 const proc = Bun.spawn([chrome,"--headless=new","--disable-gpu","--no-first-run",`--user-data-dir=${profile}`,"--virtual-time-budget=4000","--dump-dom",server.url.href], {stdout:"pipe",stderr:"pipe"});
 const output = await new Response(proc.stdout).text();
 const error = await new Response(proc.stderr).text();
 if (await proc.exited !== 0 || !output.includes('<pre id="result">PASS</pre>')) throw Error(`Browser regression failed: ${output.slice(-1000)} ${error.slice(-1000)}`);
 if (sidebarRequests !== 0) throw Error(`Unexpected sidebar requests: ${sidebarRequests}`);
 console.log("Rich-text browser regression passed");
} finally { server.stop(true); rmSync(profile,{recursive:true,force:true}); }
