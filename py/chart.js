/**
 * 取网易云榜单（0.16.60 起：不再是写死的「热歌 + 飙升」，改成按设置里勾的榜取）。
 *
 * 为什么在页面里 fetch（跟 py/recommend.js 取 cookie 再请求不一样）：
 * 实测客户端页面是 `orpheus://orpheus/pub/app.html`，它的 fetch 能直连 `music.163.com`
 * 而且带得上登录态（`credentials: include`），
 * `/api/v6/playlist/detail?id=<榜单 id>&n=<条数>` 直接回 playlist.tracks，
 * 不用签名、不用 weapi 加密，也不用从 CDP 抠 MUSIC_U。
 *
 * 榜单 id 目录在 src/charts.js（65 个，带分组），这里只负责「给什么 id 就取什么」。
 * **每个榜只取前 N 首**（默认 300 = 拿满）：每榜取多少由 src/chart.js 按「300 / 勾的榜数」算好再传进来。
 *
 * 用法：node py/chart.js <base64 的 {cdpPort, ids, take}>
 *   例：{"cdpPort":9229,"ids":["3778678","19723756"],"take":150}
 * 输出：{"ok":true,"ids":[...],"charts":[{"id","name","updateTime","songs":[...]}],"errors":[]}
 */
const P = (() => {
  try {
    return JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
  } catch {
    return {};
  }
})();

const PORT = String(P.cdpPort || process.env.NCM_CDP_PORT || '9229');

/** 兜底：没传 ids（老调用方 / 手动跑）就维持原来那两个榜。 */
const FALLBACK_IDS = ['3778678', '19723756'];

const IDS = (() => {
  let raw = P.ids;
  if (typeof raw === 'string') raw = raw.split(/[,，、\s]+/);
  if (!Array.isArray(raw)) return FALLBACK_IDS.slice();
  const out = [];
  for (const x of raw) {
    const id = String(x || '').trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 8) break;   // 和 src/charts.js 的 MAX_CHARTS 对齐
  }
  return out.length ? out : FALLBACK_IDS.slice();
})();

/**
 * 每个榜取前多少首。
 * 0.16.62：上限从 100 放到 300 —— 单榜要「整榜全取」，卡在 100 就拿不全。
 * 榜本身最多也就 200 首上下，所以 300 实际等于「拿满」。
 */
const TAKE = Math.min(300, Math.max(5, Number(P.take) || 300));
/** 请求服务端时先多要一点再切 —— 有的榜会回不足 n 条，切完不至于太少。 */
const ASK = Math.max(TAKE, 500);

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function pageWs() {
  const res = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = (res || []).filter((x) => x.type === 'page')[0];
  if (!page) throw new Error('网易云客户端没有可调试页面（没启动？）');
  return page.webSocketDebuggerUrl;
}

/** 在页面里执行一段异步表达式并取回值（跟 py/ncm.py 的 evaluate 同款）。 */
async function evaluate(expr) {
  const ws = new WebSocket(await pageWs());
  let seq = 0;
  const pend = new Map();
  const send = (m, p = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const to = setTimeout(() => { pend.delete(id); reject(new Error('CDP 超时')); }, 25000);
    pend.set(id, {
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject: (e) => { clearTimeout(to); reject(e); },
    });
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (!m.id) return;
    const p = pend.get(m.id);
    if (!p) return;
    pend.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连不上 CDP'));
  });
  try {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error(d || r.exceptionDetails.text || '页面里报错');
    }
    return r && r.result ? r.result.value : null;
  } finally {
    ws.close();
  }
}

function normalize(list) {
  return (list || [])
    .map((s) => ({
      id: String(s.id || ''),
      name: String(s.name || '').trim(),
      artist: ((s.ar || s.artists) || []).map((a) => a.name).join('/'),
      album: String((s.al && s.al.name) || (s.album && s.album.name) || ''),
      // 第 111 节：时长（毫秒）。tracks 本来就有 dt，以前白扔了
      durMs: Number(s.dt || s.duration || 0) || 0,
    }))
    .filter((s) => s.name && s.id);
}

async function main() {
  const expr = `(() => {
    const ids = ${JSON.stringify(IDS)};
    const ask = ${ASK};
    const take = ${TAKE};
    return (async () => {
      const res = [];
      for (const id of ids) {
        try {
          const r = await fetch("https://music.163.com/api/v6/playlist/detail?id=" + id + "&n=" + ask,
                                { credentials: "include", headers: { Referer: "https://music.163.com/" } });
          const j = await r.json();
          const pl = j && j.playlist;
          const tracks = ((pl && pl.tracks) || []).slice(0, take);
          res.push({ id: String(id), ok: !!(pl && pl.tracks), name: pl && pl.name,
                     updateTime: pl && pl.updateTime, tracks });
        } catch (e) {
          res.push({ id: String(id), ok: false, error: String(e).slice(0, 160) });
        }
      }
      return res;
    })();
  })()`;

  let res;
  try {
    res = await evaluate(expr);
  } catch (e) {
    return out({ ok: false, ids: IDS, error: `读榜单失败：${e.message}` });
  }
  if (!Array.isArray(res)) return out({ ok: false, ids: IDS, error: '榜单返回格式不对' });

  const out0 = { ok: true, ids: IDS, take: TAKE, charts: [], updateTime: 0, errors: [] };
  for (const r of res) {
    const songs = normalize(r.tracks);
    if (!r.ok || !songs.length) {
      out0.errors.push(`${r.id}: ${r.error || '空'}`);
      continue;
    }
    out0.charts.push({
      id: String(r.id),
      name: String(r.name || ''),
      updateTime: Number(r.updateTime) || 0,
      songs,
    });
    out0.updateTime = Math.max(out0.updateTime, Number(r.updateTime) || 0);
  }
  if (!out0.charts.length) {
    out0.ok = false;
    out0.error = out0.errors.join('；') || '勾的榜都没取到';
  }
  return out(out0);
}

main().catch((e) => out({ ok: false, error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 600) }));
