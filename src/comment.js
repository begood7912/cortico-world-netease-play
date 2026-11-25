/**
 * 卡③「别人怎么说」—— 网易云评论区里的一条热评。
 *
 * 关键发现：评论和搜索**都不需要 cookie、不需要 CDP**，就是普通公开 HTTP。
 * 实测：`POST /api/cloudsearch/pc` 搜歌 200；`GET /api/v1/resource/comments/R_SO_4_<id>`
 * 返回 hotComments 15 条 + comments 20 条 + total（《平凡之路》256839 条）。
 * 所以这里不走 CDP，快得多，客户端没开也能读。
 *
 * 每条评论带：content、likedCount、user.nickname、time。
 * 选法（0.0.1.6.4 起）：点赞最高的 **5 条里随机挑一条** —— 以前是「≥51 字的里面取赞最多的」，
 * 同一首歌每次听都念同一条，太死。候选池只在热评里挑，不至于抽到无人问津的那条。
 *
 * 缓存 6 小时（评论不怎么变）；失败负缓存 30 分钟。
 * 遇 429/403 → 冷却 60 秒不再请求，别把自己打进限流。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cachePath, songKey, readJson, writeJson } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = cachePath('comments.json');
const TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 30 * 60 * 1000;
/** 上限：再长就截断，一整段贴出来卡装不下。0.4.4 从 120 放到 200 —— 用户要「引一大段原文」。 */
const MAX_CHARS = 200;
const BASE = 'https://music.163.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

let cache = null;
let blockedUntil = 0;
const inflight = new Map();

const key = songKey;

function readCache() {
  // 0.16.99：读写都走 store；内存里那份仍在，命中就不碰盘
  if (!cache) cache = readJson(FILE, {});
  return cache;
}

function writeCache(obj) {
  cache = obj;
  writeJson(FILE, obj);
}

/** 同步读结果。没有（或过期）返回 null。 */
export function peekComment(title, artist, gen = null) {
  const c = readCache()[key(title, artist)];
  if (!c || !c.text) return null;
  if (Date.now() - (c.at || 0) > TTL_MS) return null;
  // 0.17.54：换歌/重播 = 新的一遍 → 上一次那条评论作废，重新抽一条
  if (gen != null && Number(c.gen) !== Number(gen)) return null;
  return c;
}

/** 同步读失败记录。返回 reason 字符串或 null。 */
export function peekCommentFail(title, artist) {
  const c = readCache()[key(title, artist)];
  if (!c || c.text) return null;
  if (Date.now() - (c.at || 0) > FAIL_TTL_MS) return null;
  return String(c.reason || 'fail');
}

export function isCommentPending(title, artist) {
  return inflight.has(key(title, artist));
}

async function api(path, init) {
  if (Date.now() < blockedUntil) throw new Error('接口冷却中');
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      Accept: 'application/json',
      ...(init && init.headers),
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 403 || res.status >= 500) blockedUntil = Date.now() + 60_000;
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 搜歌拿候选 songId。三个入口轮着试，跟取歌词那套同一个道理：search/get 会突然 405。
 * 返回前 3 个候选 —— 搜出来的第一条不一定是原唱（「稻香」就搜到过只有 6 条评论的版本）。
 */
async function findSongs(title, artist) {
  const q = encodeURIComponent(`${title} ${artist || ''}`.trim());
  const songs = [];
  const routes = [
    { path: '/api/cloudsearch/pc', method: 'POST', body: `s=${q}&type=1&offset=0&limit=10` },
    { path: `/api/search/get/web?s=${q}&type=1&offset=0&limit=10`, method: 'GET' },
  ];
  for (const r of routes) {
    try {
      const j = await api(r.path, r.method === 'POST'
        ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: r.body }
        : { method: 'GET' });
      const list = (j && j.result && (j.result.songs || j.result.list)) || [];
      if (list.length) {
        songs.push(...list);
        break;
      }
    } catch { /* 换下一个 */ }
  }
  if (!songs.length) return [];
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const byArtist = (s) => (s.artists || s.ar || []).some((a) => {
    const n = String(a.name || '');
    return n && (n.includes(artist) || String(artist).includes(n));
  });
  // 歌手对得上的排前面，其次才是歌名一致 —— 谁唱的比叫什么更要紧。
  // 以前两个权重一样、只按「歌名 + 歌手」相加排序，结果同名不同人的两首歌
  // 挤在同一档里，后面比评论数时就会挑到别人的版本去。
  const scored = songs.map((s, i) => ({
    s,
    i,
    nameHit: norm(s.name) === norm(title),
    artistHit: artist ? byArtist(s) : false,
  }));
  scored.sort((a, b) => (((Number(b.artistHit) * 2) + Number(b.nameHit)) - ((Number(a.artistHit) * 2) + Number(a.nameHit)) || a.i - b.i));
  return scored.slice(0, 5).map(({ s, nameHit, artistHit }) => ({
    id: Number(s.id),
    name: String(s.name || ''),
    artist: (s.artists || s.ar || []).map((a) => a.name).join('/'),
    nameHit,
    artistHit,
  }));
}

/** 太短的、带网址的、纯表情的都不要 —— 念出来没内容。 */
function usable(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return false;
  if (/https?:\/\/|www\.|\.com\b/i.test(t)) return false;
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) return false;
  return true;
}

function flatten(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 返回一段可用的评论正文。
 *
 * 用户定的规则（0.0.1.6.4）：**点赞最高的五条里随机挑一条**。
 * 早先是「字数 ≥ 51 的里面取赞最多的那一条」—— 问题是每次听同一首歌永远是同一条，
 * 一条评论读两遍就没意思了。现在把候选池放宽到「热评 + 最新」里点赞前 5 ，
 * 每次生成随机抽一条，缓存期内（6 小时）固定，所以面板和播报不会来回跳。
 */
function pickOne(j) {
  const hot = Array.isArray(j && j.hotComments) ? j.hotComments : [];
  const recent = Array.isArray(j && j.comments) ? j.comments : [];
  const all = [...hot, ...recent]
    .map((c) => ({
      text: flatten(c && c.content),
      likes: Number.isFinite(c && c.likedCount) ? Math.max(0, c.likedCount) : 0,
      nick: String((c && c.user && c.user.nickname) || '').trim(),
      hot: hot.includes(c),
    }))
    .filter((c) => usable(c.text));
  if (!all.length) return null;

  const top = all.slice().sort((a, b) => b.likes - a.likes).slice(0, 5);
  const p = top[Math.floor(Math.random() * top.length)];
  return { ...p, text: p.text.length > MAX_CHARS ? `${p.text.slice(0, MAX_CHARS - 2)}…` : p.text };
}

async function run({ title, artist }) {
  const cands = await findSongs(title, artist);
  if (!cands.length) return { ok: false, reason: 'not-found' };

  /*
   * 选哪一个 songId，按三级收：
   *   1. 歌名对 + 歌手对（最稳）
   *   2. 歌手对（歌名带副标题、加了括号注的那种）
   *   3. 歌名对（歌手名写法差得太多时只能将就）
   * 以前只有「歌名对得上」这一级，再在里面比评论总数 ——
   * 同名不同演唱者的两首歌就都在这一级里，谁评论多就念谁，
   * 于是《永夜》石岩版读到的是谭维维版的评论。歌手能认出来时必须按歌手来。
   */
  const strict = cands.filter((c) => c.nameHit && c.artistHit);
  const byArtistOnly = cands.filter((c) => c.artistHit);
  const named = cands.filter((c) => c.nameHit);
  const pool = strict.length ? strict : (byArtistOnly.length ? byArtistOnly : named);

  let best = null;
  let lastErr = null;
  for (const cand of pool) {
    try {
      const j = await api(`/api/v1/resource/comments/R_SO_4_${cand.id}?limit=30&offset=0`);
      if (!j || (j.code && j.code !== 200)) { lastErr = `code ${j && j.code}`; continue; }
      const total = Number(j.total) || 0;
      const one = pickOne(j);
      if (!one) { lastErr = 'no-comment'; continue; }
      const rec = { song: cand, total, one, likes: one.likes, nick: one.nick, text: one.text };
      if (!best || total > best.total) best = rec;
      if (total >= 5000) break;
    } catch (e) {
      lastErr = String((e && e.message) || e);
      if (/冷却/.test(lastErr)) break;
    }
  }
  if (!best) return { ok: false, reason: 'no-comment', error: lastErr || '' };
  return {
    ok: true,
    text: best.text,
    likes: best.likes,
    nick: best.nick,
    songId: best.song.id,
    // 把选中的那个版本带出去，面板/日志里能看出「念的是谁唱的」
    songArtist: best.song.artist,
    total: best.total,
  };
}

/** 读一首歌的一条热评。同一首歌并发调用会合并成一次。 */
export function generateComment({ title, artist, gen = null }) {
  const k = key(title, artist);
  const running = inflight.get(k);
  if (running) return running;

  const p = (async () => {
    let r;
    try {
      r = await run({ title, artist });
    } catch (e) {
      r = { ok: false, reason: 'unavailable', error: String((e && e.message) || e) };
    }
    const c = readCache();
    c[k] = r.ok
      ? { at: Date.now(), text: r.text, likes: r.likes, nick: r.nick, songId: r.songId, songArtist: r.songArtist || '', total: r.total, gen: Number(gen) || 0 }
      : { at: Date.now(), text: '', reason: r.reason || 'fail', error: r.error || '', gen: Number(gen) || 0 };
    writeCache(c);
    return r;
  })().finally(() => inflight.delete(k));

  inflight.set(k, p);
  return p;
}
