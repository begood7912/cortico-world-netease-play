/**
 * 拿一首歌的歌词正文。给「此刻」页的第一张卡用。
 *
 * 流程：CDP 取 cookie（MUSIC_U 是 HttpOnly，页面里读不到，只能走 Network.getCookies）
 *      → 用「歌名」搜到 songId（第一条就是原唱，实测如此）
 *      → 取歌词 → 剥时间戳、去元信息行、去重 → 输出单行 JSON
 *
 * 用法：node py/lyric.js <base64 的 {title,artist,cdpPort}>
 * 输出：{"ok":true,"songId":"...","name":"...","artist":"...","text":"...","lines":48}
 */
const P = (() => {
  try {
    return JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
  } catch {
    return {};
  }
})();

const PORT = String(P.cdpPort || process.env.NCM_CDP_PORT || '9229');
const TITLE = String(P.title || '').trim();
const ARTIST = String(P.artist || '').trim();

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 元信息行：不是歌词正文，剔掉 */
const META = /^(作词|作曲|编曲|制作人|和声|吉他|贝斯|鼓|键盘|弦乐|混音|母带|录音|监制|出品|统筹|企划|发行|词|曲|演唱|原唱|OP|SP|Rap|rap)\s*[:：]/;
/** 英文制作名单，例如 "Arragement : 朴树"、"Mixing Engineer : 李军" */
const META_EN = /^[A-Za-z][A-Za-z0-9 .&/()\-]{0,40}\s*[:：]/;
/** 没有冒号的英文制作行，例如 "Mixed by Simon Li at nOiz"；只在整行没有中文时才当元信息 */
const CJK = /[\u4e00-\u9fa5]/;
const META_KW = /(mixed|arrang|produc|record|written|compos|engineer|program|master|supervis|photograph|artwork|stylist|makeup|manager|guitar|bass|drum|keyboard|harmon|chorus|string|vocal|lyricist|director)/i;

/** 一行是不是制作名单。只在头尾用 —— 正文里万一有带冒号的歌词句，不能被误伤。 */
function isMeta(t) {
  return META.test(t) || META_EN.test(t) || /ISRC/i.test(t)
    || /(recorded|mixed|mastered|produced|arranged)[^\n]{0,50}\b(at|by)\b/i.test(t)
    || (!CJK.test(t) && META_KW.test(t))
    || (/^[^:：]{1,14}[:：]/.test(t) && t.length < 70);
}

function clean(raw) {
  const seen = new Set();
  const lines = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!t) continue;
    if (/^[\d:.\-\s]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    lines.push(t);
  }
  // 头尾各剥一遍：制作名单既可能排在歌词前（「潮尔 : 潮洛蒙」），也可能压到最后。
  while (lines.length > 0 && isMeta(lines[0])) lines.shift();
  while (lines.length > 0 && isMeta(lines[lines.length - 1])) lines.pop();

  let text = lines.join('\n');
  if (text.length > 1600) text = `${text.slice(0, 1600)}…`;
  return { text, lines: lines.length };
}

/**
 * 带时间轴的歌词：卡② 要引用「播放到 60 秒时正在唱的那一句」，
 * 光有正文没用，必须知道每一句在几分几秒。
 *
 * 一行可能挂多个时间戳（副歌重复），每个都算一条 —— 取句时按时间从小到大找最后一条。
 * 这里不过滤重复：同一个句子在不同时间出现是正常的。
 */
function parseTimed(raw) {
  const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const rows = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(STAMP)];
    if (!stamps.length) continue;
    const t = line.replace(STAMP, '').trim();
    if (!t) continue;
    if (/^[\d:.\-\s]+$/.test(t)) continue;
    if (isMeta(t)) continue;
    if (t.length > 40) continue;
    for (const m of stamps) {
      const ms = m[3] ? Number(`0.${String(m[3]).padEnd(3, '0')}`) : 0;
      const sec = Number(m[1]) * 60 + Number(m[2]) + ms;
      rows.push({ t: Math.round(sec * 10) / 10, text: t });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.slice(0, 200);
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

async function search(cj, keyword) {
  const H = { ...headers(cj), 'Content-Type': 'application/x-www-form-urlencoded' };
  const q = encodeURIComponent(keyword);
  const csrf = cj.__csrf || '';
  // 三个接口轮着试：`POST /api/search/get` 会突然回 405（限流），只靠它一首歌都搜不到。
  const routes = [
    { url: 'https://music.163.com/api/cloudsearch/pc', method: 'POST', body: `s=${q}&type=1&offset=0&limit=8&csrf_token=${csrf}` },
    { url: `https://music.163.com/api/search/get/web?s=${q}&type=1&offset=0&limit=8`, method: 'GET' },
    { url: 'https://music.163.com/api/search/get', method: 'POST', body: `s=${q}&type=1&offset=0&limit=8&csrf_token=${csrf}` },
  ];
  for (const r of routes) {
    try {
      const res = await fetch(r.url, { method: r.method, headers: H, body: r.body });
      if (!res.ok) continue;
      const j = await res.json();
      const songs = (j && j.result && (j.result.songs || j.result.list)) || [];
      if (songs.length) return songs;
    } catch { /* 换下一个接口 */ }
  }
  return [];
}

async function lyric(cj, songId) {
  const r = await fetch(`https://music.163.com/api/song/lyric?id=${songId}&lv=-1&kv=-1&tv=-1`, { headers: headers(cj) });
  const j = await r.json();
  return (j && j.lrc && j.lrc.lyric) || '';
}

async function main() {
  if (!TITLE) return out({ ok: false, error: '没给歌名' });

  let cj;
  try {
    cj = await cdpCookies();
  } catch (e) {
    return out({ ok: false, error: `取 cookie 失败：${e.message}` });
  }
  if (!cj.MUSIC_U) return out({ ok: false, error: '没拿到 MUSIC_U，客户端没登录？' });

  let songs = [];
  // 先「歌名 + 歌手」精确一点，搜不到再只搜歌名
  try {
    songs = await search(cj, `${TITLE} ${ARTIST}`.trim());
    if (!songs.length) songs = await search(cj, TITLE);
  } catch (e) {
    return out({ ok: false, error: `搜歌失败：${e.message}` });
  }
  if (!songs.length) return out({ ok: false, error: '搜不到这首歌' });

  // 歌手对得上就优先，否则第一条
  const norm = (s) => String(s || '').replace(/\s/g, '').toLowerCase();
  const hit = songs.find((s) => {
    const names = (s.artists || []).map((a) => a.name).join('/');
    return norm(names).includes(norm(ARTIST)) && norm(s.name).includes(norm(TITLE));
  }) || songs[0];

  let raw = '';
  try {
    raw = await lyric(cj, hit.id);
  } catch (e) {
    return out({ ok: false, songId: String(hit.id), error: `取歌词失败：${e.message}` });
  }

  const { text, lines } = clean(raw);
  if (!lines) {
    return out({ ok: false, songId: String(hit.id), name: hit.name, error: '这首歌没有歌词（纯音乐或版权受限）' });
  }

  return out({
    ok: true,
    songId: String(hit.id),
    name: String(hit.name || ''),
    artist: (hit.artists || []).map((a) => a.name).join('/'),
    lines,
    text,
    timed: parseTimed(raw),
  });
}

main().catch((e) => out({ ok: false, error: String((e && e.message) || e) }));
