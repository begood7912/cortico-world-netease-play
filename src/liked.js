/**
 * 卡② 顶上那行「谁唱的 + 多少人喜欢」（0.16.53）。
 *
 * 数据只在客户端界面上：`span.redstar-count`（红心按钮里的计数，见 py\liked.js 的注释）。
 * 官方接口没有这个字段，所以只能走 CDP 读页面；读不到就**不显示**，绝不编一个数字。
 *
 * 三个保护：
 *  1. 页面上读到的是「播放条里那首」的计数 —— 必须跟我们要显示的歌对上，否则当没读到
 *     （没在放歌时页面还留着上一首的数，拿它配推荐卡里的歌就是错的）。
 *  2. 按 `歌名|歌手` 缓存并落盘（`data\liked-count.json`），面板 5 秒刷一次不会反复起进程，
 *     切页面、重启 world 之后还能显示上次读到的值。
 *  3. 读失败后 60 秒内不再重试，免得客户端没开的时候每刷一次面板都白起一个子进程。
 */
import { cachePath } from './store.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runProc, payloadOf, parseLastJson, logParseFail, msgOf, profileOf } from './proc.js';

const STORE = cachePath('liked-count.json');

const TIMEOUT_MS = profileOf('liked').timeout;
const HIT_TTL = 10 * 60 * 1000;   // 同一首的成功值复用 10 分钟（这个数不会天天变）
const MISS_TTL = 60 * 1000;       // 读失败后 60 秒内不再起进程
const MAX_ROWS = 400;

let mem = new Map();   // key -> { raw, at }
let loaded = false;
let missMap = new Map();   // key -> 上次读失败的时间（按歌冷却，换歌不受影响）

function loadStore() {
  try {
    const j = JSON.parse(readFileSync(STORE, 'utf8'));
    if (j && typeof j === 'object') {
      for (const [k, v] of Object.entries(j)) {
        if (v && typeof v.raw === 'string' && v.raw) mem.set(k, { raw: v.raw, at: Number(v.at) || 0 });
      }
    }
  } catch {
    /* 第一次跑没有这个文件，正常 */
  }
}

function saveStore() {
  const rows = [...mem.entries()]
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, MAX_ROWS);
  const obj = {};
  for (const [k, v] of rows) obj[k] = { raw: v.raw, at: v.at };
  try {
    writeFileSync(STORE, JSON.stringify(obj), 'utf8');
  } catch {
    /* 写不进去不影响这次显示，下次还会再读 */
  }
}

/**
 * 把客户端那个计数变成一句中文。
 * 客户端的两种形态：不足一万是纯数字（精确），一万以上是「12w+」（只给量级）。
 * 口径（用户定的）：1w+ → 1 万多人、10w+ → 10 万多人、100w+ → 100 多万人；结尾一律叫「同意」（0.17.1 用户改口径，原「点赞」）
 */
export function likedLabel(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  if (!s) return '';
  const wan = /^([0-9]+(?:\.[0-9]+)?)w\+$/i.exec(s);
  if (wan) {
    const n = Math.floor(Number(wan[1]));
    if (!Number.isFinite(n) || n <= 0) return '';
    return `${n} 万多人同意`;
  }
  const num = Number(s.replace(/[^0-9.]/g, ''));
  if (Number.isFinite(num) && num > 0) return `${Math.round(num)} 人同意`;
  return '';
}

/**
 * 播报开头那句：「许嵩的《幻听》，有 100 万多人同意。」（0.16.54；0.16.88 起「喜欢」改「同意」）
 * 歌手空着就省掉「…的」，label 空着返回空串（调用处退回老口径，不念半截）。
 */
export function likedSentence({ artist, title, label } = {}) {
  const who = String(artist || '').trim();
  const name = String(title || '').trim();
  const lb = String(label || '').trim();
  if (!name || !lb) return '';
  return `${who ? `${who}的` : ''}《${name}》，有 ${lb}。`;
}

/** 歌名比对：客户端可能多带空格 / 括号场次，去掉空白和标点再比，短名要求完全一致。 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function sameSong(pageName, title) {
  const a = norm(pageName);
  const b = norm(title);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  return false;
}

/** 起一次 py/liked.js 读页面上的红心计数。外壳在 proc.js 的 `netease.liked`。 */
async function readRaw({ cdpPort } = {}) {
  const port = Number(cdpPort) || 9229;
  const payload = payloadOf({ cdpPort: port });
  const msg = msgOf('liked');
  const r = await runProc('liked', { payload, cdpPort: port });

  if (r.spawnError) return { ok: false, error: `${msg.spawn}：${r.spawnError}` };
  if (r.timedOut) return { ok: false, error: msg.timeout };
  const j = parseLastJson(r.out);
  if (!j) {
    logParseFail('netease.liked', r);
    return { ok: false, error: msg.parse };
  }
  return j;
}

/** 读（或从缓存拿）这首歌的喜欢人数，附带一句可显示的中文。 */
export async function getLiked({ title, artist, cdpPort } = {}) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, label: '', error: 'no-song' };
  if (!loaded) {
    loaded = true;
    loadStore();
  }
  const key = `${t}|${String(artist || '').trim()}`.toLowerCase();
  const hit = mem.get(key);
  if (hit && hit.raw && Date.now() - (hit.at || 0) < HIT_TTL) {
    return { ok: true, raw: hit.raw, label: likedLabel(hit.raw), cached: true };
  }
  if (missMap.has(key) && Date.now() - missMap.get(key) < MISS_TTL && !hit) {
    return { ok: false, label: '', error: 'cool-down' };
  }

  const r = await readRaw({ cdpPort });
  if (r && r.ok && r.count) {
    if (sameSong(r.name, t)) {
      mem.set(key, { raw: r.count, at: Date.now() });
      missMap.delete(key);
      saveStore();
      return { ok: true, raw: r.count, label: likedLabel(r.count) };
    }
    // 页面上那首不是我们要的（没在放歌 / 切到别的页面了）→ 当没读到，别把别人的数挂上去
    missMap.set(key, Date.now());
    return { ok: false, label: '', error: 'other-song', page: r.name || '' };
  }

  missMap.set(key, Date.now());
  if (hit && hit.raw) return { ok: true, raw: hit.raw, label: likedLabel(hit.raw), stale: true };
  return { ok: false, label: '', error: (r && r.error) || 'not-found' };
}
