/**
 * 取网易云的「每日推荐」歌单。给卡④ 用。
 *
 * 流程：CDP 取 cookie（MUSIC_U 是 HttpOnly，只能走 Network.getCookies）
 *      → GET /api/v1/discovery/recommend/songs?limit=50
 *      → 只输出 id / 歌名 / 歌手 / 专辑，别的字段卡④ 用不上。
 *
 * 用法：node py/recommend.js <base64 的 {cdpPort}>
 * 输出：{"ok":true,"songs":[{"id":"...","name":"...","artist":"...","album":"..."}]}
 */
const P = (() => {
  try {
    return JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
  } catch {
    return {};
  }
})();

const PORT = String(P.cdpPort || process.env.NCM_CDP_PORT || '9229');

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function cdpCookies() {
  const res = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = res.filter((x) => x.type === 'page')[0];
  if (!page) throw new Error('没有可用页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pend = new Map();
  const send = (m, p = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const to = setTimeout(() => { pend.delete(id); reject(new Error('CDP 超时')); }, 6000);
    pend.set(id, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } });
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
  const r = await send('Network.getCookies', { urls: ['https://music.163.com'] });
  ws.close();
  const map = {};
  for (const c of (r && r.cookies) || []) map[c.name] = c.value;
  return map;
}

function headers(cj) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Referer: 'https://music.163.com/',
    Cookie: Object.entries(cj).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

function pick(list) {
  return (list || [])
    .map((s) => ({
      id: String(s.id || ''),
      name: String(s.name || '').trim(),
      artist: (s.artists || s.ar || []).map((a) => a.name).join('/'),
      album: String((s.album && s.album.name) || (s.al && s.al.name) || ''),
      // 第 111 节：时长（毫秒）。每日推荐接口本来就是毫秒，白拿的，别扔
      durMs: Number(s.duration || s.dt || 0) || 0,
    }))
    .filter((s) => s.name);
}

async function main() {
  let cj;
  try {
    cj = await cdpCookies();
  } catch (e) {
    return out({ ok: false, error: `取 cookie 失败：${e.message}` });
  }
  if (!cj.MUSIC_U) return out({ ok: false, error: '没拿到 MUSIC_U，客户端没登录？' });

  const routes = [
    'https://music.163.com/api/v1/discovery/recommend/songs?limit=50',
    'https://music.163.com/api/v2/discovery/recommend/songs?limit=50',
  ];
  let lastErr = '';
  for (const url of routes) {
    try {
      const res = await fetch(url, { headers: headers(cj) });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const j = await res.json();
      const list = pick(j && (j.recommend || (j.data && j.data.dailySongs)));
      if (list.length) return out({ ok: true, count: list.length, songs: list });
      lastErr = `code ${j && j.code}`;
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  return out({ ok: false, error: lastErr || '拿不到每日推荐' });
}

main().catch((e) => out({ ok: false, error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 600) }));
