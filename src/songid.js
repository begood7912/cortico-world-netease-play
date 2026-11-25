/**
 * 歌曲 ID 解析（0.17.4）—— 让「听歌流水 / 排名页」也能落到具体一首歌身上。
 *
 * 为什么需要：点歌账本本来就是按 id 记的（`notes\点歌次数.json` 的键就是 id），
 * 但听歌流水（`data\listening.jsonl`）只有歌名和歌手 —— 同名不同版本（原版 / Live / 翻唱）
 * 在排名页会并成一行，也没法按 id 去做后续动作。
 *
 * 三个来源，按可信度从高到低：
 *   1. 点歌/播放时已知 id → `remember()` 直接写进缓存；
 *   2. 本地缓存 `data\songids.json`；
 *   3. 都没有才查网易云搜索接口，用「歌名 + 歌手 + 时长（可选）」三条件挑。
 *      —— 时长来自播放进度（py/progress.js 的 d），有它就能把同名不同版本区分开。
 *
 * 约定：任何一步失败都只是「这次没 id」，绝不抛、绝不阻塞播放；查失败写一条 external 留现场。
 */
import { cachePath, readJson, writeJson, songKey } from './store.js';
import { external } from './log.js';

const FILE = cachePath('songids.json');
const API = 'https://music.163.com/api/search/get';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/** 时长允许的偏差：进度条的 d 是整秒，接口给毫秒，2.5 秒足够容忍取整与片头。 */
const DUR_TOL_MS = 2500;

let map = null;
let saveTimer = null;

function load() {
  if (map) return map;
  const j = readJson(FILE, null);
  map = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  return map;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJson(FILE, load());
  }, 1500);
  if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s·・．.()（）\-_/]/g, '');

/** 记下「这首就是 id」—— 点歌/播放链路已经知道 id 时调它，省掉后面一次搜索。 */
export function remember(title, artist, id) {
  const k = songKey(title, artist);
  const v = String(id == null ? '' : id).trim();
  if (!v || !/^\d+$/.test(v)) return false;
  const m = load();
  if (m[k] === v) return false;
  m[k] = v;
  saveSoon();
  return true;
}

/** 只查本地缓存；没有就是空串。给排名页这种不想等网络的地方用。 */
export function cachedId(title, artist) {
  if (!title) return '';
  return String(load()[songKey(title, artist)] || '');
}

/** 批量查本地缓存。 */
export function cachedIds(pairs = []) {
  const m = load();
  const out = new Map();
  for (const p of pairs) {
    const hit = p && p.title ? String(m[songKey(p.title, p.artist)] || '') : '';
    if (hit) out.set(songKey(p.title, p.artist), hit);
  }
  return out;
}

async function searchOnce(query, { timeoutMs, fetcher }) {
  const url = `${API}?s=${encodeURIComponent(query)}&type=1&limit=10&offset=0`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const r = await fetcher(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
      signal: ctrl.signal,
    });
    const j = await r.json();
    return (j && j.result && j.result.songs) || [];
  } finally {
    clearTimeout(timer);
  }
}

/** 从候选里挑：歌名必须完全一致，歌手要能对上，给了时长就按时长卡。 */
function pickOne(songs, { title, artist, durationMs }) {
  const wantName = norm(title);
  const wantArtist = norm(artist);
  const dur = Number(durationMs) > 0 ? Number(durationMs) : 0;
  const fallback = [];
  for (const s of songs) {
    if (!s || s.id == null) continue;
    if (norm(s.name) !== wantName) continue;
    const artists = (s.artists || s.ar || []).map((a) => norm(a && a.name)).join('');
    if (wantArtist && !artists.includes(wantArtist)) continue;
    const d = Number(s.duration) || 0;
    if (dur && d) {
      if (Math.abs(d - dur) <= DUR_TOL_MS) return String(s.id);
      fallback.push(String(s.id));
      continue;
    }
    return String(s.id);
  }
  return fallback[0] || '';
}

/**
 * 解析一首歌的 id。
 * @param {string} title
 * @param {string} artist
 * @param {{durationMs?:number, timeoutMs?:number, remember?:boolean, fetcher?:Function}} opts
 * @returns {Promise<string>} 找不到回空串，绝不抛
 */
export async function resolveId(title, artist, opts = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return '';
  const hit = cachedId(cleanTitle, artist);
  if (hit) return hit;

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 6000;
  const fetcher = typeof opts.fetcher === 'function' ? opts.fetcher : fetch;
  const query = `${cleanTitle} ${String(artist || '').trim()}`.trim();
  try {
    let songs = await searchOnce(query, { timeoutMs, fetcher });
    let id = pickOne(songs, { title: cleanTitle, artist, durationMs: opts.durationMs });
    if (!id && artist) {
      // 带歌手搜不到时，退回只搜歌名再按歌手过滤（有些别名/组合名在接口里对不上）
      songs = await searchOnce(cleanTitle, { timeoutMs, fetcher });
      id = pickOne(songs, { title: cleanTitle, artist, durationMs: opts.durationMs });
    }
    if (id) {
      if (opts.remember !== false) remember(cleanTitle, artist, id);
      return id;
    }
    external('songid', 'resolve', { title: cleanTitle, artist: String(artist || ''), why: 'no-match' });
    return '';
  } catch (e) {
    external('songid', 'resolve', {
      title: cleanTitle,
      artist: String(artist || ''),
      why: 'error',
      err: String((e && e.message) || e).slice(0, 200),
    });
    return '';
  }
}

/**
 * 批量解析（排名页补 id 用）。并发 4，只解析缓存里没有的。
 * @param {Array<{title:string, artist?:string}>} pairs
 */
export async function resolveMany(pairs = [], opts = {}) {
  const conc = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 4;
  const out = cachedIds(pairs);
  const todo = [];
  for (const p of pairs) {
    if (!p || !p.title) continue;
    const k = songKey(p.title, p.artist);
    if (out.has(k)) continue;
    out.set(k, '');
    todo.push(p);
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const p = todo[cursor];
      cursor += 1;
      const id = await resolveId(p.title, p.artist, opts);
      if (id) out.set(songKey(p.title, p.artist), id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, todo.length) }, worker));
  return out;
}

/** 测试用：把内存里的表换掉 / 读出来。 */
export function _resetForTest(obj = {}) {
  map = { ...obj };
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}
