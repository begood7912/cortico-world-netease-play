// 打开指定歌单 → 双击第一行 → 队列=整张歌单、从第一首开始连续播。
// 用法: node cm-play-first.js "AI队列"
// 输出: {"ok":true,"page":"AI队列","first":"夜空中最亮的星","playing":"夜空中最亮的星"}
const CDP_PORT = process.env.NCM_CDP_PORT || "9229";
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
const page = targets.filter((t) => t.type === "page").pop();
if (!page) { console.log(JSON.stringify({ ok: false, err: "没有可用的页面" })); process.exit(1); }

const CDP_TO = Number(process.env.CM_CDP_TIMEOUT || 8000);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++seq;
    const to = setTimeout(() => { pending.delete(mid); rej(new Error("CDP 无响应 " + method)); }, CDP_TO);
    pending.set(mid, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`连不上 ${CDP_PORT}，客户端没开或没带调试端口`)); });
await send("Runtime.enable");

const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面里报错：" + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ""));
  return r.result ? r.result.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function click(x, y, count = 1) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: count });
  await sleep(50);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: count });
}

const out = { ok: false };
try {
  const name = process.argv[2] || "";
  out.target = name;

  const head = await ev(`(()=>{const h=document.querySelector('h1,h2');return h?(h.textContent||'').trim():''})()`);
  out.page = head;

  // 不在这个歌单页就点侧栏切过去
  if (name && head !== name) {
    const item = await ev(`(()=>{
      const all=[...document.querySelectorAll('[class*=PlayListItemContent]')];
      for(const e of all){ if((e.textContent||'').trim()!==${JSON.stringify(name)}) continue;
        const r=e.getBoundingClientRect(); if(r.width<8) continue;
        return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); }
      return ''})()`);
    if (item) {
      const p = JSON.parse(item);
      await click(p.x, p.y);
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        const h = await ev(`(()=>{const h=document.querySelector('h1,h2');return h?(h.textContent||'').trim():''})()`);
        if (h === name) break;
      }
      out.page = await ev(`(()=>{const h=document.querySelector('h1,h2');return h?(h.textContent||'').trim():''})()`);
    }
  }

  // 双击第一行
  // 2026-11-21 改：先等第一行真的变成刚加进去的那首（expect），再双击。
  // 否则歌单页还没重绘，双击落在旧的第一行 —— 表现就是「点在歌 A，放出来是歌 B」。
  // 2026-11-22 改：等待收紧。原来 16×400ms（最坏 6.4 秒）太久了，
  // 报给面板的就是「点了十秒才响」。实测加歌后列表 1 秒内就刷出来了，
  // 所以前 6 次（1.5 秒）严格等，之后放宽，别死等。
  const expect = process.argv[3] || "";
  out.expect = expect;
  let first = null;
  const waitedFrom = Date.now();
  for (let i = 0; i < 10; i++) {
    const t = await ev(`(()=>{
      const wrap=document.querySelector('[class*=XVirtualizeListWrapper]');
      if(!wrap) return '';
      const row=wrap.querySelector('[class*=innerScrollContainer] > div');
      if(!row) return '';
      const tt=row.querySelector('[class*=td-title]')||row;
      const r=tt.getBoundingClientRect();
      if(r.width<8) return '';
      return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),txt:(tt.textContent||'').trim().slice(0,40)});
    })()`);
    if (t) {
      const o = JSON.parse(t);
      // 前 6 次（约 1.5 秒）严格等目标歌；等不到就放宽，不能干等
      if (!expect || (o.txt || "").includes(expect) || i >= 6) { first = o; break; }
    }
    await sleep(250);
  }
  out.waitMs = Date.now() - waitedFrom;
  if (!first) throw new Error("歌单里没有可点的行（空歌单？）");
  out.first = first.txt;
  if (expect && !(first.txt || "").includes(expect)) out.expectMiss = true;

  const before = await ev(`(()=>{const b=document.querySelector('[class*=DefaultBarWrapper]');return b?(b.textContent||'').replace(/\\s+/g,' ').trim():''})()`);
  await click(first.x, first.y, 1);
  await sleep(150);
  await click(first.x, first.y, 2);

  // 2026-11-21 改：双击已经点过了，播放基本立刻开始，没必要死等 6 秒。
  // 2026-11-22 改：再收紧到 0.9 秒上限 —— 起播通常在 100~300ms 内就有反馈。
  for (let i = 0; i < 6; i++) {
    await sleep(150);
    const st = await ev(`(()=>{const b=document.querySelector('[class*=DefaultBarWrapper]');if(!b)return '';const on=[...b.querySelectorAll('[class*=cmd-icon]')].some(e=>/cmd-icon-pause(\\s|$)/.test(e.className.toString()));return JSON.stringify({on:on,t:(b.textContent||'').replace(/\\s+/g,' ').trim()});})()`);
    let o = null;
    try { o = st ? JSON.parse(st) : null; } catch {}
    if (o && (o.on || (o.t && o.t !== before))) break;
  }
  out.playing = await ev(`(()=>{const b=document.querySelector('[class*=DefaultBarWrapper]');return b?(b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60):''})()`);
  out.ok = !!out.playing;
} catch (err) {
  out.err = String(err.message || err);
}
console.log(JSON.stringify(out));
process.exit(0);
