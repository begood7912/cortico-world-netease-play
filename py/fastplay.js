// 快路径点播（不抢窗口，全程只在渲染层动，不用 orpheus 协议）。
//
// 2026-11-22 定稿思路（照老大说的老做法）：
//   1) 先看当前列表第一行是不是这首歌 —— 是就直接双击（最快，约 0.4 秒）
//   2) 不是就调接口「先删后加」把歌顶到第一位（实测删 0.10 秒 + 加 0.10 秒），
//      然后只点第一行。**不去歌单里翻找**：歌单 159 首，虚拟列表只渲染一屏，翻不到。
//
// 为什么不用 orpheus://{"type":"song","cmd":"play"}：它虽快（下发 0.1 秒），
// 但会把客户端窗口抢到前台，老大力了明确不要。
// 为什么不用 Input 双击之外的招：CDP 派发鼠标事件不经窗口管理器，不会抢焦点。
//
// 用法: node fastplay.js '{"title":"永夜","artist":"谭维维","songId":"1320122579","playlist":"小菱的歌单"}'

let CDP_PORT = process.env.NCM_CDP_PORT || "9229";
const t0 = Date.now();
const { readFileSync, writeFileSync } = await import("node:fs");
const { join, dirname } = await import("node:path");
const { fileURLToPath } = await import("node:url");
/* 0.1.21（用户口径）：把 4.5 秒一刀切改成**分段预算**，每段自己计时。
   以前等页面标题就给了 4 秒、切歌单又 3 秒，冷态时还没走到「删+加」整条就超时了；
   实测正路只用 1.1~1.5 秒（del 90ms / add 80ms / 等第一行 350~560ms / 点击确认 250~350ms）。 */
const stages = {};
let tMark = t0;
const mark = (k) => {
  const n = Date.now();
  stages[k] = n - tMark;
  tMark = n;
  // 0.1.21：超时那一刻进程会被 kill、done() 来不及跑 —— 每段顺手写一行 stderr，
  // 这样 `fast.out/err` 里能看到「卡在哪一段」，不用再猜。
  try { process.stderr.write(`stage ${k}=${stages[k]}ms\n`); } catch { /* ignore */ }
};
const done = (o) => {
  o.ms = Date.now() - t0;
  if (Object.keys(stages).length) o.stages = stages;
  console.log(JSON.stringify(o));
  process.exit(0);
};

let want = {};
try {
  const raw = process.argv[2] || "";
  // 参数优先按 base64 解（宿主那边就是这么传的，避免中文经 argv 丢字段）
  try {
    want = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    want = JSON.parse(raw || "{}");
  }
} catch { /* ignore */ }
// 端口优先由调用方参数传进来（宿主不再改环境变量，避免子进程启动异常）
if (want.cdpPort) CDP_PORT = String(want.cdpPort);
const wantName = String(want.title || want.name || "").trim();
const wantArtist = String(want.artist || "").trim();
const wantPlaylist = String(want.playlist || "").trim();
let wantId = String(want.songId || want.id || "").trim();
// 0.1.21：重试那一趟跳过「等页面标题」——页面早就热了，再等纯属浪费预算
const SKIP_HEAD = !!want.skipHead;
if (!wantName) done({ ok: false, reason: "no-title" });

// 行文本归一：整段去掉括号（「素颜（Live）」「[SQ]」这类后缀/标记），再去空白和分隔符，然后比
const norm = (s) =>
  String(s || "").toLowerCase()
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")
    .replace(/[\s\-_·,'"’“”]/g, "");
const normW = (s) => norm(s);
// 歌手栏可能是「陈奕迅/王菲」「A、B」—— 拆成片段，任意一段对上就算同一首
const artistBits = wantArtist
  .split(/[\/、,，&;&]/)
  .map((x) => norm(x))
  .filter(Boolean);

// 0.17.41（第 90 节 B6-3）：这里原来定义在下面 ④ 那段（388 行），但 ① 的
// 「第一行就是这首」分支（320 行）会先用到它 —— 真按 TDZ 崩过一次：
// 没给 songId 且命中那个分支时抛 ReferenceError，被外层 catch 成 ok:false，
// 白落 5~10 秒的慢路径。提到所有使用点之前，两个分支共用。
const rowMatches = (txt) => {
  const t = norm(txt);
  // 0.1.31：歌手名常被客户端塞进括号里（「起风了（原曲…）冯沁苑(买辣椒也用券)」），
  // 而 norm() 为了去掉 (Live)/[SQ] 这类标记会把整段括号删掉 —— 歌手就跟着括号一起没了。
  // 所以歌手这一关再补一个「原文本」比对：只去空格和分隔符，不动括号。
  const loose = String(txt || "").toLowerCase().replace(/[\s\-_·,'"’“”]/g, "");
  if (!t.includes(normW(wantName))) return false;
  if (!artistBits.length) return true;
  return artistBits.some((p) => t.includes(p) || loose.includes(p));
};

let page;
try {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const pages = targets.filter((t) => t.type === "page");
  page = pages.filter((t) => (t.url || "").includes("orpheus")).pop() || pages.pop();
} catch (e) {
  done({ ok: false, reason: "cdp-unreachable", err: String(e.message || e) });
}
if (!page) done({ ok: false, reason: "no-page" });

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++seq;
    const to = setTimeout(() => { pending.delete(mid); rej(new Error("CDP 无响应 " + method)); }, 6000);
    pending.set(mid, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
};
try {
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error(`连不上 CDP ${CDP_PORT}`));
  });
  await send("Runtime.enable");
} catch (e) {
  done({ ok: false, reason: "ws-fail", err: String(e.message || e) });
}

const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面报错");
  return r.result ? r.result.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function click(x, y, count) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: count,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: count,
  });
}

const bar = () => ev(`(()=>{
  let t='', cid='', n=0, playing=false;
  // 第 115 节：新版界面上 DefaultBarWrapper 这个 class 已经没了（实测 b=null）。
  // 0.16.86（第 132 节 A9）：连带把依赖它的 on（暂停图标判断）一起删掉 ——
  // 它恒为 false，日志里 startedOn 永远是 false，只会误导排查。现在只读两样：
  //   cid = params.s_cid（当前播放 id，读一次 1ms）、t = 播放条文本（兜底比对用）。
  // 两个坑都要绕开：
  //   ① 切歌那一瞬间播放条会短暂不在 → 退一步在 footer 里再扫一遍 [data-log]；
  //   ② 不能整页扫 —— 列表行的 data-log 里也有 s_cid（第 106 节），整页扫会读到「第一行」的 id，串歌。
  const grab=(root, sel)=>{
    const hits=[];
    for (const e of root.querySelectorAll(sel)) {
      let p={};
      try { p=(JSON.parse(e.getAttribute('data-log')||'{}').params)||{}; } catch (err) { continue; }
      if (p.s_cid) hits.push({cid:String(p.s_cid), e:e});
    }
    return hits;
  };
  let hits=grab(document,'[data-log*="page_pc_mini_bar"]');
  if (!hits.length) {
    const foot=document.querySelector('[class*=page-footer]')||document.querySelector('.page-footer');
    if (foot) hits=grab(foot,'[data-log]');
  }
  n=hits.length;
  for (const h of hits) {
    if (!cid) cid=h.cid;
    if (!t) {
      const txt=(h.e.textContent||'').replace(/\\s+/g,' ').trim();
      // 「01:11 / 03:33去远方VIP…」这种带进度前缀的先跳过，取更干净的那个兄弟元素
      if (txt && !/^\\d{1,2}:\\d{2} \\//.test(txt)) t=txt.slice(0,70);
    }
  }
  if (!cid) return '';
  /* 0.1.31：顺手读「到底在不在播」——
     3.1.10 实测：暂停时播放键的图标是 cmd-icon-play，播放时同一处是 cmd-icon-pause。
     以前这里只读 id 和文本，所以「双击把正在播的那首切成了暂停」这种失败看不见
     （id 对得上 → 判定成功 → 播报说播了，其实静音）。 */
  const host=hits.length ? hits[0].e : null;
  if (host) playing=!!host.querySelector('[class*="cmd-icon-pause"]');
  return JSON.stringify({t:t,cid:cid,n:n,playing:playing});
})()`);
const pageHead = () => ev(`(()=>{const h=document.querySelector('h1,h2');return h?(h.textContent||'').trim():''})()`);

/* 0.1.30（黑胶播放页，2026-11-28 实测）：
   用户在客户端里停「播放页·黑胶」时，body 上挂 `vinyl-mode`，整块主界面被 `VinylPageContainer` 盖住。
   这时侧栏和列表**都还在 DOM 里**、坐标也读得到，但 `elementFromPoint(第一行中心)` 命中的是
   `cover-area`（唱片封面）—— 双击等于点封面，歌不响；而 `h1` 仍是被盖住的那个歌单名，
   于是 ②「不在目标歌单页才切」也被骗过去，直接落到 ④ 双击空气，报 clicked-not-playing。

   解法（探针实测）：**不点坐标，直接对侧栏歌单项派发 click 事件**。
   实测派发后 1 秒内 body 的 vinyl-mode 就掉了、h1 变成目标歌单、第一行的 elementFromPoint
   变回 `td-title`，之后双击就能正常起播。全程不抢窗口、不动播放。 */
const onVinyl = async () => {
  const r = await ev(`(()=>{
    if(((document.body.className||'')+'').includes('vinyl-mode')) return 'class';
    const v=document.querySelector('[class*=VinylPageContainer]');
    if(!v) return '';
    const g=v.getBoundingClientRect();
    return (g.width>10 && getComputedStyle(v).display!=='none') ? 'visible' : '';
  })()`);
  return !!r;
};

// 侧栏歌单项：DOM 派发点击（不经坐标，被页面盖住时也照样能切路由）
const sidebarClick = async (name) => ev(`(()=>{
  const items=[...document.querySelectorAll('[class*=PlayListItemContent]')];
  const t=items.find(e=>(e.textContent||'').trim()===${JSON.stringify(name)});
  if(!t) return '';
  const g=t.getBoundingClientRect();
  const o={bubbles:true,cancelable:true,view:window,button:0};
  t.dispatchEvent(new PointerEvent('pointerdown',o));
  t.dispatchEvent(new MouseEvent('mousedown',o));
  t.dispatchEvent(new MouseEvent('mouseup',o));
  t.dispatchEvent(new MouseEvent('click',o));
  return JSON.stringify({w:Math.round(g.width)});
})()`);

// 侧栏收起来了就先点展开图标
const ensureSidebar = async () => ev(`(()=>{
  const e=document.querySelector('[class*=cmd-icon-sidebar_unfold]');
  if(!e) return '';
  const o={bubbles:true,cancelable:true,view:window,button:0};
  e.dispatchEvent(new MouseEvent('click',o));
  return 'unfold';
})()`);

// 侧栏任意一项：优先「当前选中」的，其次第一个 —— 只为先把播放页关掉
const sidebarClickAny = async () => ev(`(()=>{
  const items=[...document.querySelectorAll('[class*=PlayListItemContent]')];
  const t=items.find(e=>(e.className||'').toString().includes('selected'))
    || items.find(e=>{const g=e.getBoundingClientRect();return g.width>8;});
  if(!t) return '';
  const o={bubbles:true,cancelable:true,view:window,button:0};
  t.dispatchEvent(new PointerEvent('pointerdown',o));
  t.dispatchEvent(new MouseEvent('mousedown',o));
  t.dispatchEvent(new MouseEvent('mouseup',o));
  t.dispatchEvent(new MouseEvent('click',o));
  return JSON.stringify({name:(t.textContent||'').trim()});
})()`);

async function waitOffVinyl(max = 14) {
  for (let i = 0; i < max; i += 1) {
    await sleep(80);
    if (!(await onVinyl())) return true;
  }
  return false;
}

// 退出黑胶播放页：切到指定歌单，等 body 掉 vinyl-mode
async function leaveVinyl(name) {
  let ok = await sidebarClick(name);
  if (!ok) {
    await ensureSidebar();
    await sleep(200);
    ok = await sidebarClick(name);
  }
  if (!ok) return false;
  return waitOffVinyl();
}

// 目标歌单不在侧栏时：点当前选中/第一项，先离开播放页（切歌单交给后面 ②）
async function leaveVinylAny() {
  let ok = await sidebarClickAny();
  if (!ok) {
    await ensureSidebar();
    await sleep(200);
    ok = await sidebarClickAny();
  }
  if (!ok) return false;
  return waitOffVinyl();
}

// 点之前先确认这个坐标真的落在「列表行」上（黑胶页里会落到 cover-area 上）
const pointOnRow = async (x, y) => {
  const r = await ev(`(()=>{
    const el=document.elementFromPoint(${Math.round(x)},${Math.round(y)});
    if(!el) return false;
    return !!el.closest('[class*=td-title]');
  })()`);
  return !!r;
};

// 列表第一行：歌名文本 + 可点坐标（y 落在视口内才算可点）+ **这一行的歌曲 id**
// 第 116 节：行 DOM 的 data-log 里带 params.s_cid（第 106 节实测），顺手读出来 —— 
// 这样日志里就能出现「playedId=287398 wantId=287398」，而不是只有歌名让人瞎猜。
const firstRow = () => ev(`(()=>{
  const cidOf=(node)=>{
    if(!node) return '';
    try{
      const j=JSON.parse((node.getAttribute&&node.getAttribute('data-log'))||'{}');
      if(j.params&&j.params.s_cid) return String(j.params.s_cid);
    }catch(e){}
    for(const el of node.querySelectorAll('[data-log]')){
      try{
        const j=JSON.parse(el.getAttribute('data-log')||'{}');
        if(j.params&&j.params.s_cid) return String(j.params.s_cid);
      }catch(e){}
    }
    return '';
  };
  const wrap=document.querySelector('[class*=XVirtualizeListWrapper]');
  if(!wrap) return '';
  const row=wrap.querySelector('[class*=innerScrollContainer] > div');
  if(!row) return '';
  const tt=row.querySelector('[class*=td-title]')||row;
  const g=tt.getBoundingClientRect();
  if(g.width<8) return '';
  return JSON.stringify({x:Math.round(g.x+g.width/2),y:Math.round(g.y+g.height/2),txt:(tt.textContent||'').trim().slice(0,40),cid:cidOf(row)});
})()`);

async function wheel(deltaY, wait = 60) {
  const box = await ev(`(()=>{
    const w=document.querySelector('[class*=XVirtualizeListWrapper]')||document.querySelector('[class*=td-title]');
    if(!w) return '';
    const g=w.getBoundingClientRect();
    return JSON.stringify({x:Math.round(g.x+40),y:Math.round(Math.min(Math.max(g.y+g.height/2, 120), innerHeight-100))});
  })()`);
  if (!box) return false;
  const b = JSON.parse(box);
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: b.x, y: b.y, deltaX: 0, deltaY, button: "none", buttons: 0,
  });
  await sleep(wait);
  return true;
}

// 让第一行落在「能点」的位置：顶部表头下面是 y≈100~140，被顶到负值就要往回滚。
// 已经就在可点位置时直接返回，不做无谓的滚动（每次滚动加等待要 ~180ms，白花）。
async function firstRowUsable() {
  const raw0 = await firstRow();
  if (!raw0) return null;
  const o0 = JSON.parse(raw0);
  if (o0.y >= 90 && o0.y <= 900) return o0;

  await wheel(-900, 45);
  await wheel(-900, 45);
  await sleep(60);
  for (let i = 0; i < 3; i += 1) {
    const raw = await firstRow();
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o.y >= 90 && o.y <= 900) return o;
    // 被顶部栏/表头盖住了，往下拨一点
    await wheel(o.y < 90 ? 120 : -120, 55);
  }
  const raw = await firstRow();
  return raw ? JSON.parse(raw) : null;
}

async function dblRow(row) {
  await click(row.x, row.y, 1);
  await sleep(70);
  await click(row.x, row.y, 2);
}

/* ---------- 0.1.31：这一行「是不是这首歌」的判定，以及「点完真的在响吗」的补救 ---------- */

/** 第一行算不算目标：有 id 就只认 id（3.1.10/3.1.44 两版实测，行自身 data-log 的 s_cid 都是歌 id），
    没有 id 才退回文本（原来那套，歌手现在会连括号原文一起看）。 */
const isTargetRow = (r) => {
  if (!r) return false;
  if (wantId && r.cid && String(r.cid) === String(wantId)) return true;
  return rowMatches(r.txt);
};

const asObj = (raw) => {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const barNow = async () => asObj(await bar());

/** 按一下播放条上的播放/暂停键（只在「确认暂停」时用，不会把正在播的弄停）。 */
const playPause = () => ev(`(()=>{
  const b=document.querySelector('[data-log*="btn_pc_minibar_play"]');
  if(!b) return false;
  const g=b.getBoundingClientRect();
  const o={bubbles:true,cancelable:true,view:window,button:0,
    clientX:Math.round(g.left+g.width/2),clientY:Math.round(g.top+g.height/2),pointerType:'mouse'};
  b.dispatchEvent(new PointerEvent('pointerdown',o));
  b.dispatchEvent(new MouseEvent('mousedown',o));
  b.dispatchEvent(new PointerEvent('pointerup',o));
  b.dispatchEvent(new MouseEvent('mouseup',o));
  b.dispatchEvent(new MouseEvent('click',o));
  return true;
})()`);

/** 播放条已经是这首歌、但停在暂停 → 补按播放，最多三次。
    3.1.10 实测：双击「正在播放的那一行」等于播放/暂停切换，会把歌按停（进度停在整分整秒不动）。 */
async function ensureRunning(cid) {
  let p = await barNow();
  for (let i = 0; i < 3; i += 1) {
    if (!p || !cid || String(p.cid) !== String(cid) || p.playing) return p;
    await playPause();
    await sleep(260);
    p = await barNow();
  }
  return p;
}

// 最多等 0.4 秒：常听的歌播放条 0.3~0.5 秒就更新了，
// 没等到也不代表失败（第一行已经确认是这首歌、也确实双击了），只是起播慢一点。
/**
 * 点完以后等「播放条上真的变成这首」。
 *
 * 第 115 节修的是这里：原来 6×70ms = **420ms 就放弃**，而实测起播是 693~2143ms
 * （日志里四天都是这个量级）—— 窗口太短必然读空，上层又拿 `ok: true` 兜着，
 * 于是「播报了但一声没响」被当成播放成功。
 * 现在放宽到 12×90ms（约 1.1 秒），并且**优先比播放条上的 s_cid**：
 * id 精确，不会被「VIP/MV/歌手拼接」糊掉；文本比对只做兜底。
 */
async function waitPlaying(max = 12) {
  for (let i = 0; i < max; i += 1) {
    await sleep(90);
    const raw = await bar();
    let o = null;
    try { o = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    if (!o) continue;
    if (wantId && o.cid && String(o.cid) === String(wantId)) return o;
    if (o.t && o.t.includes(wantName)) return o;
  }
  return null;
}

// ---------- 接口部分 ----------
async function cookies() {
  // 不调 Network.enable：getCookies 不需要它，线上实测多这一步要多花几十毫秒
  const r = await send("Network.getCookies", { urls: ["https://music.163.com", "https://music.163.com/"] });
  const jar = {};
  for (const c of (r && r.cookies) || []) jar[c.name] = c.value;
  return jar;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function apiPost(path, form, cookie) {
  /* 0.1.22：实测 add 请求偶尔会挂住（《归期雨抄》两趟各 8 秒/5 秒 timeout，stderr 只到 switch 段），
     一刀切 2.5 秒超时——挂了就当这趟失败，交给上层重试第二趟，不要让它吃光整趟预算。 */
  try {
    const r = await fetch(`https://music.163.com${path}`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Referer: "https://music.163.com/",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(2500),
    });
    return r.json();
  } catch (e) {
    return { code: -1, message: `api-timeout:${e && e.name ? e.name : e}` };
  }
}

async function searchId(cookie, name, artist) {
  const d = await apiPost("/api/search/get", {
    s: artist ? `${artist} ${name}` : name, type: "1", limit: "10", offset: "0",
  }, cookie);
  const songs = ((d.result || {}).songs) || [];
  if (!songs.length) return null;
  let best = songs[0];
  for (const so of songs) {
    const names = (so.name || "").toLowerCase();
    const artists = (so.artists || []).map((a) => (a.name || "").toLowerCase()).join(" ");
    if (artist && artists.includes(artist.toLowerCase()) && names) { best = so; break; }
  }
  return String(best.id);
}

// 歌单 id 会一直不变，缓存到本地文件，省掉每次那一次网络往返（约 200ms）
const PID_CACHE = join(dirname(fileURLToPath(import.meta.url)), ".pidcache.json");

/** 删掉某个名字的缓存（歌单被删 / 改名 / 接口回 404 时用）。写不了也不影响本次。 */
function forgetPid(name) {
  try {
    const cache = JSON.parse(readFileSync(PID_CACHE, "utf8"));
    if (!(name in cache)) return;
    delete cache[name];
    writeFileSync(PID_CACHE, JSON.stringify(cache));
  } catch { /* 没缓存 / 文件坏了都无所谓，下次重新查 */ }
}

async function playlistId(cookie, name) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(PID_CACHE, "utf8")); } catch { /* 没有就算了 */ }
  if (cache[name]) return cache[name];

  const me = await apiPost("/api/nuser/account/get", {}, cookie);
  const uid = (me.account || {}).id;
  if (!uid) return null;
  const r = await fetch(`https://music.163.com/api/user/playlist?uid=${uid}&limit=1000&offset=0`, {
    headers: { "User-Agent": UA, Referer: "https://music.163.com/", Cookie: cookie },
  });
  const d = await r.json();
  for (const pl of (d.playlist || [])) {
    if ((pl.name || "").trim() === name && (pl.creator || {}).userId === uid) {
      const pid = String(pl.id);
      cache[name] = pid;
      try { writeFileSync(PID_CACHE, JSON.stringify(cache)); } catch { /* 写不了也不影响 */ }
      return pid;
    }
  }
  return null;
}

try {
  // 0.1.17（B3）：客户端刚启动时页面还没渲染完，pageHead() 拿到空串 →
  // 后面直接判 no-playlist-in-sidebar（11-25 17:51 现场：head 为空）。
  // 先等标题出来，最多等 4 秒；等不到再按老逻辑往下走。
  let head0 = await pageHead();
  // 0.1.21：冷启动等标题 20×200（最多 4 秒）→ 4×180（约 0.9 秒）；重试那一趟直接跳过。
  for (let i = 0; i < (SKIP_HEAD ? 1 : 4) && !head0; i += 1) {
    await sleep(180);
    head0 = await pageHead();
  }
  mark("head");

  // 0.1.30：先确认自己不在「播放页·黑胶」里。在的话先把路由切回目标歌单（或当前选中的歌单），
  // 否则后面取到的第一行坐标会落在唱片封面上，点了不响。
  let leftVinyl = "";
  if (await onVinyl()) {
    const target = wantPlaylist
      || (await ev(`(()=>{const i=document.querySelector('[class*=PlayListItemContent].selected');return i?(i.textContent||'').trim():''})()`))
      || "";
    if (!target || !(await leaveVinyl(target))) {
      // 目标歌单一时不在侧栏（比如收在「收藏的歌单」里没展开）时，退一步：
      // 点当前选中/第一项先把播放页关掉，② 再负责切到目标歌单。
      if (!(await leaveVinylAny())) done({ ok: false, reason: "vinyl-stuck", playlist: target || "" });
    }
    leftVinyl = "left";
    head0 = await pageHead();
    // 路由刚切完，列表可能还在画：等第一行冒出来，最多 1.1 秒
    for (let i = 0; i < 12; i += 1) {
      if (await firstRow()) break;
      await sleep(90);
    }
  }
  mark("vinyl");

  // ① 当前列表第一行就是这首歌 → 直接双击
  const r0 = await firstRowUsable();
  if (isTargetRow(r0) && (!wantPlaylist || head0 === wantPlaylist)) {
    mark("already-check");
    /* 0.1.31：目标就是这一行、而且**已经在这首上放着** → 一个指头都别动。
       3.1.10 实测：对「正在播放的那一行」双击等于播放/暂停切换，会把正放的歌按停，
       而播放条 id 又对得上，所以以前会误报成功（播报说播了，其实静音）。
       这里拿「第一行的 id」和「播放条的 id」自己比，所以只报了歌名的场景也管用。 */
    const cur0 = await barNow();
    if (cur0 && r0.cid && String(cur0.cid) === String(r0.cid) && cur0.playing) {
      done({
        ok: true, clicked: false, confirmed: true, how: "already-playing", leftVinyl,
        played: r0.txt, playedId: r0.cid || "", bar: cur0.t || "", cid: cur0.cid || "", id: wantId,
      });
    }
    // 0.1.30：这一行必须真的是可点的（没被播放页/其它浮层盖住），否则先别点
    if (!(await pointOnRow(r0.x, r0.y))) {
      done({ ok: false, reason: "row-covered", how: "already-first", played: r0.txt });
    }
    await dblRow(r0);
    let p = await waitPlaying(16);
    // 0.1.31：点完 id 对、可是停着 → 补按一次播放（只报了歌名的场景就用第一行的 id 确认）
    const expect0 = wantId || (r0 && r0.cid) || "";
    if (p && expect0 && p.cid && String(p.cid) === String(expect0) && !p.playing) p = await ensureRunning(expect0);
    mark("click");
    // 第 116 节：和主路径同一个坑 —— 点了不等于响了。
    // 而且**有 id 就只认 id**（用户 108.2 口径：id 在这边全局唯一，不可能指错歌），
    // 文本比对只留给「本来就没有 id」的旧链路。
    const confirmed0 = !!(p && p.playing && ((wantId && p.cid && String(p.cid) === String(wantId))
      || (!wantId && p.t && rowMatches(p.t))));
    done({
      ok: confirmed0,
      clicked: true,
      confirmed: confirmed0,
      reason: confirmed0 ? undefined : "clicked-not-playing",
      how: "already-first",
      leftVinyl,
      played: r0.txt,
      playedId: r0.cid || "",
      bar: (p && p.t) || "",
      cid: (p && p.cid) || "",
      // 0.16.86（第 132 节 A9）：`startedOn` 删了 —— 它依赖已不存在的 DefaultBarWrapper，恒 false。
      id: wantId,
    });
  }

  // ② 不在目标歌单页就先切过去（点侧栏，不抢窗口）
  let how = "";
  if (wantPlaylist && head0 !== wantPlaylist) {
    // 0.1.17（B3）：侧栏是懒渲染的 —— 刚切入/刚启动时这一项可能还没画出来，
    // 老逻辑一取不到就报 no-playlist-in-sidebar。改成最多重试 8 次（约 1.6 秒）。
    // 0.1.30：改成 DOM 派发点击 —— 黑胶播放页里侧栏被盖住，坐标点不到（原来那招会静默失败）。
    let hit = "";
    for (let i = 0; i < (SKIP_HEAD ? 3 : 6); i += 1) {
      hit = await sidebarClick(wantPlaylist);
      if (hit) break;
      await ensureSidebar();
      await sleep(150);
    }
    if (!hit) done({ ok: false, reason: "no-playlist-in-sidebar", head: head0 });
    // 0.1.21：12×110（1.3 秒）→ 10×90（0.9 秒），实测切完 350~400ms 列表就出来了
    for (let i = 0; i < 10; i += 1) {
      await sleep(90);
      if ((await pageHead()) === wantPlaylist) break;
    }
    // 0.1.21（实测踩到的坑）：标题对上≠列表画完。列表还在加载时就去 del+add，
    // 新行要等 2.6 秒才冒出来（「耻辱柱」那次就是，白耗一趟重试）。
    // 这里再多等「第一行真的画出来」，最多 1.2 秒（列表本来有歌，通常 400ms 内就有）。
    for (let i = 0; i < 13; i += 1) {
      const rr = await firstRow();
      if (rr) break;
      await sleep(90);
    }
    how = "switched";
  }
  mark("switch");

  // ③ 定 id（没有就搜） → del + add 顶到第一位
  const jar = await cookies();
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (!jar.MUSIC_U) done({ ok: false, reason: "no-cookie" });
  const csrf = jar.__csrf || "";

  let searched = false;
  if (!wantId) {
    const id = await searchId(cookie, wantName, wantArtist);
    if (!id) done({ ok: false, reason: "not-found" });
    wantId = id;
    searched = true;
  }

  let pid = await playlistId(cookie, wantPlaylist);
  if (!pid) done({ ok: false, reason: "no-playlist", playlist: wantPlaylist });

  /* 0.1.31：歌单 id 是缓存在 py/.pidcache.json 里的，但「删掉歌单」或「改名」之后缓存不会失效 ——
     下次同名重建，就会拿着已经不存在的旧 id 去 add，接口回 404「歌单不存在」。
     （2026-11-28 实测踩到：建了个同名测试歌单，直接 404。）
     所以 404 时把这条缓存清掉、重查一次；还是拿不到才算真没这个歌单。 */
  const addTo = async () => {
    // 删了再加：接口对不在歌单里的 id 也返回 200，所以不用先查在不在
    await apiPost("/api/playlist/manipulate/tracks", {
      op: "del", pid, trackIds: JSON.stringify([Number(wantId)]), csrf_token: csrf,
    }, cookie);
    return apiPost("/api/playlist/manipulate/tracks", {
      op: "add", pid, trackIds: JSON.stringify([Number(wantId)]), imme: "true", csrf_token: csrf,
    }, cookie);
  };
  let added = await addTo();
  if (added && added.code === 404) {
    forgetPid(wantPlaylist);
    const pid2 = await playlistId(cookie, wantPlaylist);
    if (pid2 && String(pid2) !== String(pid)) {
      pid = pid2;
      /* 光换 id 还不够：页面这会儿挂的是「已经不存在的那个歌单」的旧内容
         （实测：head 对得上，列表里却是旧歌单那几行）—— 得重新点一次同名侧栏项，
         逼它按新 id 再拉一遍，否则后面「等第一行」永远等不到目标。 */
      await sidebarClick(wantPlaylist);
      for (let i = 0; i < 8; i += 1) {
        await sleep(120);
        if ((await pageHead()) === wantPlaylist) break;
      }
      added = await addTo();
    }
  }
  if (added.code && ![200, 201, 502].includes(added.code)) {
    done({ ok: false, reason: "add-failed", api: added });
  }
  how = how || "add-then-first";

  mark("api");

  // ④ 等第一行变成这首歌，然后点它
  // 0.1.21：12×90（1.1 秒）→ 26×90（2.3 秒）。实测加完 345~563ms 就到位，这里给足余量；
  // 超时才是真失败（以前 1.1 秒卡死过几次「第一行还没刷新出来」）。
  // 0.17.41：`rowMatches` 已提到文件上方（① 分支也要用，原来这里有 TDZ）。
  let row = null;
  for (let i = 0; i < 26; i += 1) {
    await sleep(90);
    const r = await firstRowUsable();
    if (isTargetRow(r)) { row = r; break; }
  }
  mark("row");
  if (!row) done({ ok: false, reason: "first-row-not-target", how, id: wantId, searched, wantName, wantArtist });
  // 0.1.30：坐标必须真的落在这一行上，否则点了也只会点到别的东西（黑胶页/浮层）
  if (!(await pointOnRow(row.x, row.y))) {
    done({ ok: false, reason: "row-covered", how, id: wantId, played: row.txt, searched, wantName, wantArtist });
  }

  await dblRow(row);
  /* 0.1.22（用户实测「每一个都要点两次才能成功」）：根子在「刚加进歌单的新歌」——
     add 之后那一行虽然画出来了，客户端还没把这行绑好，第一下点下去播放条不亮（实测要 2.6 秒以上），
     人再点第二下才 249ms 就响。所以不再干等：**先看一眼 0.7 秒，没响就当场再点一下**，
     然后给足 3.6 秒确认。这样一次尝试内部就补上了第二下，不用退回给用户重点。 */
  let playing = await waitPlaying(8);
  let clicks = 1;
  if (!playing) {
    await dblRow(row);
    clicks = 2;
    playing = await waitPlaying(40);
  }
  // 0.1.31：点了、id 也对，但它是停着的（双击落在「正在播的那行」= 切换暂停）→ 补按播放再确认
  if (playing && wantId && String(playing.cid) === String(wantId) && !playing.playing) {
    playing = await ensureRunning(wantId);
  }
  mark("click");
  // 第 115 节：**必须确认它真响起来了**才算成功。
  // 原来这里写的是 `ok: true`（注释「点了就算成功」），实测代价很大：
  // 列表第一行换成了目标、播放条却一声没响，照样回报 ok →
  // 上层把 base 记成这首新歌 → 3 秒后采样发现播放条还是旧歌 → 判成「切歌」→ 整轮收场。
  // 用户看到的就是：播报是对的，歌没放，接力断了。
  const confirmed = !!(playing && playing.playing
    && ((wantId && playing.cid && String(playing.cid) === String(wantId))
      || (!wantId && playing.t && rowMatches(playing.t))));
  done({
    ok: confirmed,
    clicked: true,
    clicks,
    confirmed,
    // 点了、但播放条没证明它响了 → 失败，交给上层按第 93 节重试（20 秒一次、最多 3 次）
    reason: confirmed ? undefined : "clicked-not-playing",
    how,
    leftVinyl,
    // 第 116 节：`played` 是**列表第一行**的文本（我们点的那个），不是播放条的反馈，
    // 光看它容易误判成「放对了」。所以再记一个 `playedId`（同一行的 s_cid），
    // 排查时直接看 `id` / `playedId` / `cid` 三个 id 对不对得上，别再靠歌名。
    played: row.txt,
    playedId: row.cid || "",
    bar: (playing && playing.t) || "",
    cid: (playing && playing.cid) || "",
    // 0.16.86（第 132 节 A9）：`startedOn` 删了 —— 它依赖已不存在的 DefaultBarWrapper，恒 false。
    id: wantId,
    via: confirmed ? (playing && playing.cid && String(playing.cid) === String(wantId) ? "id" : "text") : "",
    searched,
  });
} catch (e) {
  done({ ok: false, reason: "error", err: String(e.message || e) });
}
