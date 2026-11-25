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
const done = (o) => {
  o.ms = Date.now() - t0;
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
  if (!t.includes(normW(wantName))) return false;
  if (!artistBits.length) return true;
  return artistBits.some((p) => t.includes(p));
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
  let t='', cid='', n=0;
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
  return JSON.stringify({t:t,cid:cid,n:n});
})()`);
const pageHead = () => ev(`(()=>{const h=document.querySelector('h1,h2');return h?(h.textContent||'').trim():''})()`);

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
  const r = await fetch(`https://music.163.com${path}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Referer: "https://music.163.com/",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: new URLSearchParams(form).toString(),
  });
  return r.json();
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
  for (let i = 0; i < 20 && !head0; i += 1) {
    await sleep(200);
    head0 = await pageHead();
  }

  // ① 当前列表第一行就是这首歌 → 直接双击
  const r0 = await firstRowUsable();
  if (r0 && (r0.txt || "").includes(wantName) && (!wantPlaylist || head0 === wantPlaylist)) {
    await dblRow(r0);
    const p = await waitPlaying();
    // 第 116 节：和主路径同一个坑 —— 点了不等于响了。
    // 而且**有 id 就只认 id**（用户 108.2 口径：id 在这边全局唯一，不可能指错歌），
    // 文本比对只留给「本来就没有 id」的旧链路。
    const confirmed0 = !!(p && ((wantId && p.cid && String(p.cid) === String(wantId))
      || (!wantId && p.t && rowMatches(p.t))));
    done({
      ok: confirmed0,
      clicked: true,
      confirmed: confirmed0,
      reason: confirmed0 ? undefined : "clicked-not-playing",
      how: "already-first",
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
    let item = "";
    for (let i = 0; i < 8; i += 1) {
      item = await ev(`(()=>{
      const all=[...document.querySelectorAll('[class*=PlayListItemContent]')];
      for(const e of all){ if((e.textContent||'').trim()!==${JSON.stringify(wantPlaylist)}) continue;
        const r=e.getBoundingClientRect(); if(r.width<8) continue;
        return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}); }
      return ''})()`);
      if (item) break;
      await sleep(200);
    }
    if (!item) done({ ok: false, reason: "no-playlist-in-sidebar", head: head0 });
    const p = JSON.parse(item);
    await click(p.x, p.y, 1);
    for (let i = 0; i < 12; i += 1) {
      await sleep(110);
      if ((await pageHead()) === wantPlaylist) break;
    }
    how = "switched";
  }

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

  const pid = await playlistId(cookie, wantPlaylist);
  if (!pid) done({ ok: false, reason: "no-playlist", playlist: wantPlaylist });

  // 删了再加：接口对不在歌单里的 id 也返回 200，所以不用先查在不在
  await apiPost("/api/playlist/manipulate/tracks", {
    op: "del", pid, trackIds: JSON.stringify([Number(wantId)]), csrf_token: csrf,
  }, cookie);
  const added = await apiPost("/api/playlist/manipulate/tracks", {
    op: "add", pid, trackIds: JSON.stringify([Number(wantId)]), imme: "true", csrf_token: csrf,
  }, cookie);
  if (added.code && ![200, 201, 502].includes(added.code)) {
    done({ ok: false, reason: "add-failed", api: added });
  }
  how = how || "add-then-first";

  // ④ 等第一行变成这首歌，然后点它
  // 0.16.66（第 92 节 G）：以前只比歌名 —— 同名不同歌手（翻唱、别人的同名曲）就会被认成目标，
  // 于是「报的是 A、响的是同名的 B」。现在给了歌手就一起校验：歌手栏可能写「陈奕迅/王菲」，
  // 所以按分隔符拆开，只要有一段对上就算这首歌。
  // 0.17.41：`rowMatches` 已提到文件上方（① 分支也要用，原来这里有 TDZ）。
  let row = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(90);
    const r = await firstRowUsable();
    if (r && rowMatches(r.txt)) { row = r; break; }
  }
  if (!row) done({ ok: false, reason: "first-row-not-target", how, id: wantId, searched, wantName, wantArtist });

  await dblRow(row);
  const playing = await waitPlaying();
  // 第 115 节：**必须确认它真响起来了**才算成功。
  // 原来这里写的是 `ok: true`（注释「点了就算成功」），实测代价很大：
  // 列表第一行换成了目标、播放条却一声没响，照样回报 ok →
  // 上层把 base 记成这首新歌 → 3 秒后采样发现播放条还是旧歌 → 判成「切歌」→ 整轮收场。
  // 用户看到的就是：播报是对的，歌没放，接力断了。
  const confirmed = !!(playing
    && ((wantId && playing.cid && String(playing.cid) === String(wantId))
      || (!wantId && playing.t && rowMatches(playing.t))));
  done({
    ok: confirmed,
    clicked: true,
    confirmed,
    // 点了、但播放条没证明它响了 → 失败，交给上层按第 93 节重试（20 秒一次、最多 3 次）
    reason: confirmed ? undefined : "clicked-not-playing",
    how,
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
