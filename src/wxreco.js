/**
 * 0.17.30：此刻页「按天气听点什么」（用户口中的卡片5）。
 *
 * 做法（用户已认可的口径）：
 *   1. 实时实况（/weather/v1/current，坐标查询）
 *   2. 压成一句纯口语「多云，气温12度，体感9度，东北风3级，湿度62%」
 *   3. 用本机向量模型（embedModel，通常是 bge-m3）把这句和候选池里的歌名+歌手编码
 *   4. 余弦排序，只取第一名那首（用户口径：只选第一首，不随机）
 *
 * 与卡①的区别：卡① 靠「听过的歌 + 每日推荐」算；这张靠天气。
 * 歌名/歌手/时长/来源、点一下就能播，这些跟卡①完全一样。
 *
 * 缓存：10 分钟。面板每 3~5 秒刷一次快照，不能每次都去查天气和算向量。
 * 「换一批」按钮走 refreshWxReco(force)，强制重算一次（天气是新的，排序通常也会变）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cachePath } from './store.js';
import { embedTexts, cosine } from './embed.js';
import { weatherNow, peekWeather, wxProbe } from './qweather.js';
import { chatAny } from './ollama.js';
import { sameKey } from './chain.js';
import { ensureChart, chartSongs } from './chart.js';
import { peekRecommend, peekDaily } from './recommend.js';
// 0.17.39：来源开关的唯一直译。只有「按天气」是当前来源时，这条链路才允许计算。
import { isWeatherActive } from './source.js';

// 0.17.46（用户口径）：天气卡也显示 5 首，和历史卡一致；接力仍只取第一首。
const TAKE = 5;
/** 接力要往后顺位，卡片只展示 5 首，另外留前 30 给挑歌用。 */
const POOL_TAKE = 30;
/** 0.17.55：天气池 100 → 200 首，候选多了每次排出来的歌才会变。 */
const WX_POOL_TAKE = 200;
const WX_POOL_TTL_MS = 3 * 60 * 60 * 1000;
const WX_POOL_VER = 2;

/**
 * 0.17.36：天气只有一份 —— qweather.js 里那个 15 分钟自动查询 + 落盘快照。
 * 这里只负责读它；qwInterval 也拿同一个值，用来判「这份名单该不该重算」。
 */
function weatherIntervalMs(cfg) {
  const n = Number(cfg && cfg.qwInterval);
  return (Number.isFinite(n) && n > 0 ? n : 15) * 60 * 1000;
}

/**
 * 0.17.32（用户口径）：底部状态栏那句不是原始天气串，是用本机模型按
 * 我们实测过的三种写法（方法2「懒懒的」/ 方法3「好奇」/ 方法4「心软提醒」）
 * 每次随机抽一种现写一句，二十字内。
 * 模型不可用 / 超时 → 退回原始探针句，卡片照样能用。
 */
const PERSONA = '你是小菱，住在屏幕底边的鲸鱼姑娘：好奇，什么都想凑过去看一眼；有点懒，没事就发呆打盹；心软，见人累了会提醒他歇一歇。说话短，一次一两句，口气像朋友不像客服。不懂就说不懂，不编。';

/* 0.17.55（用户口径：句子要不一样、能匹配更多歌）：
   一次让模型写 3 句不同角度的话（画面 / 心情 / 听歌感觉），三句各做一次向量，
   每首歌取「最大相似度 ×0.6 + 平均相似度 ×0.4」—— 比只拿一句去比，可匹配的歌多一倍左右。
   三句里挑「它的第一名就是最终第一名」的那句显示，保证句和歌对得上。 */
const LINES_SYSTEM = `${PERSONA} 根据天气写 3 句不同角度的话：第 1 句写你看到的画面，第 2 句写心里的感觉，第 3 句写这种天气适合听什么样的歌（只写感觉，不点歌名）。每句不超过 26 字，口语，不要天气报告，不要“多穿点/注意保暖”这类套话。只输出 JSON：{"lines":["...","...","..."]}`;

/** 把模型输出洗成能念、能上屏的一句：去掉波浪线/表情/引号/换行，超长截到最后一个标点。 */
function cleanLine(raw) {
  let s = String(raw || '').replace(/[\r\n]+/g, ' ').replace(/[～~]/g, '').trim();
  s = s.replace(/^[「『"“]|[」』"”]$/g, '').trim();
  s = s.replace(/^\(?（?(她|小菱)[^，。]{0,6}?(说|开口)?[：:]/, '').trim();
  if (s.length > 26) {
    const cut = Math.max(s.lastIndexOf('。'), s.lastIndexOf('，'), s.lastIndexOf('！'), s.lastIndexOf('？'));
    s = cut > 8 ? s.slice(0, cut + 1) : s.slice(0, 24);
  }
  return s;
}

function parseLines(raw) {
  const s = String(raw || '').trim();
  let j = null;
  try { j = JSON.parse(s); } catch {
    try { j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { j = null; }
  }
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.lines) ? j.lines : []);
  return arr.map((x) => cleanLine(String(x || ''))).filter(Boolean).slice(0, 3);
}

function timeOfDay() {
  const h = new Date().getHours();
  if (h < 6) return '凌晨';
  if (h < 9) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

function placeText(place) {
  if (!place) return '';
  return `${place.adm1 || ''}${place.adm2 || ''}`.trim() || String(place.name || '');
}

/** 让模型一次写 3 句；失败返回 []（调用方退回探针句，不会空白）。 */
async function makeLines(cfg, probe, place) {
  const user = `${probe}。现在是${timeOfDay()}，你在${placeText(place) || '屏幕底边'}。`;
  const r = await chatAny(cfg, [
    { role: 'system', content: LINES_SYSTEM },
    { role: 'user', content: user },
  ], { temperature: 0.9, numPredict: 200, timeoutMs: 25000 });
  return parseLines(r);
}

let state = {
  at: 0,
  ok: false,
  busy: false,
  reason: 'pending',
  error: '',
  weather: '',
  line: '',
  place: null,
  items: [],
  pool: [],
  // 0.17.43（A4）：这份名单是照哪一次天气快照算的；和 weather-cache.json 的 at 比对
  weatherAt: 0,
  // 天气数据多久没更新（分钟）—— 面板据此提示"这是旧数据"
  staleMin: 0,
};

/**
 * 0.17.38（用户口径「分开最稳妥」）：天气不再借用推荐那份 reco-pool.json。
 * 自己的池落在 data\weather-pool.json，从「榜单全池（热歌榜+飙升榜）+ 每日推荐 30」里
 * 独立打乱抽 100 首；抽池时就把「卡① 现在挂着的那 5 首」「最近听过的 12 首」剔掉，
 * 排序前再剔一次（卡① 可能刚换过）。这样两路不再共用同一份候选，也不会互相串。
 */
const WX_POOL_FILE = cachePath('weather-pool.json');

function readWxPool() {
  try {
    const j = JSON.parse(readFileSync(WX_POOL_FILE, 'utf8'));
    return {
      at: Number(j && j.at) || 0,
      v: Number(j && j.v) || 0,
      songs: Array.isArray(j && j.songs) ? j.songs.filter((s) => s && s.name) : [],
    };
  } catch {
    return { at: 0, v: 0, songs: [] };
  }
}

function writeWxPool(songs) {
  try {
    writeFileSync(WX_POOL_FILE, JSON.stringify({ at: Date.now(), v: WX_POOL_VER, songs }), 'utf8');
  } catch { /* 写不了下次重建 */ }
}

/** 最近听过的歌名（从 listening.jsonl 尾巴倒着取，最多 n 个不同的）。 */
function recentTitles(n = 12) {
  try {
    const raw = readFileSync(cachePath('listening.jsonl'), 'utf8');
    const lines = raw.trim().split(/\r?\n/).slice(-400);
    const out = [];
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
      let r = null;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      const t = String((r && r.t) || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}

/** 天气这一路要避开的歌名：卡① 当前那几首 + 最近听过的。 */
function avoidNames(cfg) {
  const out = [];
  try {
    const rec = peekRecommend(cfg);
    for (const it of ((rec && rec.items) || [])) {
      if (it && it.name) out.push(String(it.name));
    }
  } catch { /* 推荐不在就算了 */ }
  out.push(...recentTitles(12));
  return out;
}

function keyOfSong(s) {
  return `${String(s.name || '').trim().toLowerCase()}|${String(s.artist || '').trim().toLowerCase()}`;
}

function shuffle(arr, seed) {
  const a = arr.slice();
  let s = seed || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 0.17.55：卡片前 5 首尽量不同歌手（同名不同版本别挤在一起），不够再按顺序补。 */
function pickDiverse(list, n) {
  const out = [];
  const used = new Set();
  for (const it of list) {
    if (out.length >= n) break;
    const a = String(it.artist || '');
    if (a && used.has(a)) continue;
    used.add(a);
    out.push(it);
  }
  if (out.length < n) {
    for (const it of list) {
      if (out.length >= n) break;
      if (!out.includes(it)) out.push(it);
    }
  }
  return out;
}

async function ensureWxPool(cfg) {
  const cur = readWxPool();
  // 0.17.55：池子版本/规模变了就重建（从 100 首升到 200 首）
  if (cur.v === WX_POOL_VER && cur.songs.length >= 60 && Date.now() - cur.at < WX_POOL_TTL_MS) return cur.songs;
  const chart = await ensureChart(cfg).catch(() => ({ ok: false }));
  const base = chartSongs(chart) || [];
  let dailySongs = [];
  try {
    const d = peekDaily();
    dailySongs = d && d.ok && Array.isArray(d.songs) ? d.songs.slice(0, 30) : [];
  } catch { dailySongs = []; }
  const avoid = avoidNames(cfg);
  const isAvoid = (name) => avoid.some((a) => sameKey(a, name));
  const seen = new Set();
  const merged = [];
  for (const s of [...dailySongs.map((x) => ({ ...x, from: 'daily' })), ...base]) {
    if (!s || !s.name) continue;
    const k = keyOfSong(s);
    const idk = s.id ? `id:${s.id}` : '';
    if (seen.has(k) || (idk && seen.has(idk))) continue;
    if (isAvoid(s.name)) continue;
    seen.add(k);
    if (idk) seen.add(idk);
    merged.push({ name: String(s.name), artist: String(s.artist || ''), album: String(s.album || ''), id: String(s.id || ''), durMs: Number(s.durMs) || 0, from: String(s.from || '') });
  }
  if (!merged.length) return cur.songs;
  const songs = shuffle(merged, Date.now() % 100000).slice(0, WX_POOL_TAKE);
  writeWxPool(songs);
  return songs;
}

function shot() {
  return {
    at: state.at,
    ok: state.ok,
    busy: state.busy,
    reason: state.reason,
    error: state.error,
    weather: state.weather,
    line: state.line,
    place: state.place,
    items: state.items,
    pool: state.pool,
    weatherAt: state.weatherAt,
    staleMin: state.staleMin,
  };
}

/** 快照用：新鲜就返回，过期就顺手在后台算一次（不阻塞这一帧）。 */
export function peekWxReco(cfg, { kick = true } = {}) {
  // 0.17.39：不是当前来源就只回状态，**一次都不算**（连 kick 都不给）。
  if (!isWeatherActive(cfg)) {
    return { ...shot(), ok: false, reason: 'inactive', items: [], pool: [] };
  }
  /* 0.17.43（A4，用户口径）：不再拿 `qwInterval` 当推荐名单的重算周期。
     只看**天气数据版本变没变** —— `weather-cache.json` 的 `at` 和这份名单记的 `weatherAt`
     一样就一直用（天气没变算它干嘛）；不一样才重算。
     `qwInterval` 从此只负责"多久去抓一次远端"，与这里无关。 */
  const w = peekWeather();
  const weatherAt = w && w.ok ? Number(w.at || 0) : 0;
  const fresh = !!(state.ok && state.items.length && weatherAt && state.weatherAt === weatherAt);
  if (kick && !state.busy && !fresh) {
    state.reason = state.reason === 'pending' ? 'pending' : 'stale';
    void refreshWxReco(cfg).catch(() => { /* 失败落在 state.error */ });
  }
  return shot();
}

/**
 * 0.17.35：后台排队重算 —— 点了歌 / 点了换一批以后，不立刻起算，
 * 先留一段等待时间（默认 2.5 秒）再出结果：连续点几下只算最后一次。
 * 期间面板照旧显示上一批，算完由下一次 tick 换上（那句话和歌是一起换的）。
 */
let queueTimer = null;
export function scheduleWxReco(cfg, { delayMs = 2500 } = {}) {
  // 0.17.39：不是当前来源 → 不排队、不算（切回天气时由切换清理负责立刻重算一次）。
  if (!isWeatherActive(cfg)) return { ...shot(), ok: false, reason: 'inactive' };
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    queueTimer = null;
    void refreshWxReco(cfg).catch(() => { /* 失败落在 state.error */ });
  }, Math.max(500, Number(delayMs) || 2500));
  if (queueTimer.unref) queueTimer.unref();
  return shot();
}

/** 「换一批」：清掉时间戳，强制重算。 */
export function invalidateWxReco() {
  state.at = 0;
}

/**
 * 0.17.33：接力挑下一首用。天气名单里从第一名顺位取，跳过 exclude（正在放的 / 刚递的 /
 * 上一轮的）—— 用户口径是「只选第一首」，被排除时才顺位，不随机跳。
 * 返回 null = 天气这路当前没有可用名单（调用方自己决定退回推荐）。
 */
export function pickWxSong(cfg, { exclude = [], snapshot = null } = {}) {
  const st = snapshot || peekWxReco(cfg, { kick: false });
  if (!st || !st.ok) return null;
  const list = Array.isArray(st.pool) && st.pool.length ? st.pool : st.items;
  if (!Array.isArray(list) || !list.length) return null;
  const skip = exclude.map((x) => String(x || '').trim()).filter(Boolean);
  const hit = list.find((it) => it && it.name && !skip.some((s) => sameKey(s, it.name)));
  if (!hit) return null;
  // 0.17.38：接力已经拿走这首 → 从当前名单里划掉，
  // 面板下次刷新就不会再挂着「正在放的那一首」，也不会顺手再递第二遍。
  const drop = (arr) => (Array.isArray(arr) ? arr.filter((it) => !(it && sameKey(hit.name, it.name))) : arr);
  if (!snapshot) {
    state.items = drop(state.items);
    state.pool = drop(state.pool);
    // 卡片要保持 2 行：被划掉后用后面的顺位补上（补不上就等下一轮重算）
    if (state.items.length < TAKE) {
      const rest = state.pool.filter((it) => it && it.name && !state.items.some((x) => sameKey(x.name, it.name)));
      state.items = [...state.items, ...rest.slice(0, TAKE - state.items.length)];
    }
  }
  return {
    name: String(hit.name),
    artist: String(hit.artist || ''),
    id: String(hit.id || hit.songId || ''),
    src: 'wx',
    line: String(st.line || st.weather || ''),
  };
}

export function isWxRecoBusy() {
  return state.busy;
}

// 自测用（纯函数）
export const _parseLines = parseLines;
export const _pickDiverse = pickDiverse;

/**
 * 0.17.39：点/放掉天气卡里的一首 → 从当前名单里划掉并顺位补上，**不重算**。
 * 以前点一下就走 `scheduleWxReco` 整批重算（模型写一句 + 100 条向量），
 * 点歌本身只要几百毫秒，重算却要几秒 —— 观感就是「点了以后卡片乱跳、机器还在转」。
 */
export function dropWxSong(name) {
  const n = String(name || '').trim();
  if (!n) return shot();
  const drop = (arr) => (Array.isArray(arr) ? arr.filter((it) => !(it && sameKey(n, it.name))) : arr);
  state.items = drop(state.items);
  state.pool = drop(state.pool);
  if (state.items.length < TAKE) {
    const rest = state.pool.filter((it) => it && it.name && !state.items.some((x) => sameKey(x.name, it.name)));
    state.items = [...state.items, ...rest.slice(0, TAKE - state.items.length)];
  }
  return shot();
}

export async function refreshWxReco(cfg, { forceWeather = false, explicit = false } = {}) {
  /**
   * 0.17.39：不是当前来源就不算 —— 除非调用方显式 `explicit:true`
   * （只有「切到天气」那一刻的预热和用户手动测试会这么传）。
   */
  if (!explicit && !isWeatherActive(cfg)) return { ...shot(), ok: false, reason: 'inactive' };
  if (state.busy) return shot();
  state.busy = true;
  state.reason = 'picking';
  try {
    // 0.17.36：天气只读 qweather.js 那一份缓存；0.17.40 起 `force:false` 永不抓远端
    const w = await weatherNow(cfg, { force: forceWeather });
    const weatherAt = w && w.ok ? Number(w.at || 0) : 0;
    const ageMs = weatherAt ? Date.now() - weatherAt : Infinity;
    const staleMin = Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 60000)) : 0;
    if (!w || !w.ok) {
      state = {
        at: Date.now(),
        ok: false,
        busy: false,
        reason: 'weather-fail',
        error: String((w && w.error) || '天气没查到'),
        weather: '',
        place: null,
        items: [],
        pool: [],
        weatherAt,
        staleMin,
      };
      return shot();
    }
    /* 0.17.43（C1，用户口径）：天气旧数据不拦 —— 它只用来给模型写那句话，
       "是不是此刻"并不重要。只把 `staleMin` 带出去，面板写一行「上次更新 X」让人自己判断。
       （3 个抓取间隔就停用那一版已按你的口径去掉。） */
    const probe = wxProbe(w);
    const place = w.place ? { name: w.place.name, adm1: w.place.adm1, adm2: w.place.adm2, country: w.place.country } : null;
    // 0.17.55：一次让模型写 3 句（画面/心情/听歌感觉）；失败就用原始探针句顶上。
    let lines = [];
    try {
      lines = await makeLines(cfg, probe, place);
    } catch { /* 模型不在/超时 —— 用探针句 */ }
    const queries = lines.length ? lines : [probe];
    // 0.17.38：用自己的天气池；池子空了才退回推荐那份（保证卡片不至于空白）
    let songs = await ensureWxPool(cfg);
    const avoid = avoidNames(cfg);
    songs = songs.filter((s) => s && s.name && !avoid.some((a) => sameKey(a, s.name)));
    if (!songs.length) {
      try {
        const j = JSON.parse(readFileSync(cachePath('reco-pool.json'), 'utf8'));
        songs = (j && Array.isArray(j.songs) ? j.songs : []).filter((s) => s && s.name);
      } catch { songs = []; }
    }
    if (!songs.length) {
      state = { at: Date.now(), ok: false, busy: false, reason: 'no-pool', error: '', weather: probe, line: queries[0], place, items: [], pool: [], weatherAt, staleMin };
      return shot();
    }
    const model = String((cfg && cfg.embedModel) || '').trim();
    if (!model) {
      state = { at: Date.now(), ok: false, busy: false, reason: 'no-embed', error: '', weather: probe, line: queries[0], place, items: [], pool: [], weatherAt, staleMin };
      return shot();
    }
    const [lineVecs, songVecs] = await Promise.all([
      embedTexts(cfg, queries),
      embedTexts(cfg, songs.map((s) => `${s.name} ${s.artist}`.trim())),
    ]);
    /* 每首歌：3 句里取 max（召回）×0.6 + mean（精度）×0.4；只有一句时就是普通余弦。 */
    const scored = songs.map((s, i) => {
      const sims = queries.map((_, qi) => cosine(lineVecs[qi], songVecs[i]));
      const max = Math.max(...sims);
      const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
      return { s, score: sims.length > 1 ? 0.6 * max + 0.4 * mean : max };
    }).sort((a, b) => b.score - a.score);
    const rankedAll = scored.slice(0, POOL_TAKE).map(({ s, score }) => ({
      name: s.name,
      artist: s.artist || '',
      album: s.album || '',
      id: s.id || '',
      songId: s.id || '',
      durMs: Number(s.durMs) || 0,
      from: s.from || '',
      sim: Math.round(score * 1000) / 1000,
    }));
    /* 显示哪一句：优先「它的第一名就是最终第一名」的那句，否则用第一名分最高的那句。 */
    let line = queries[0];
    if (lines.length > 1) {
      const top1 = rankedAll[0];
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let qi = 0; qi < lines.length; qi += 1) {
        let qiBest = { i: -1, score: -Infinity };
        for (let i = 0; i < songs.length; i += 1) {
          const v = cosine(lineVecs[qi], songVecs[i]);
          if (v > qiBest.score) qiBest = { i, score: v };
        }
        if (qiBest.i >= 0 && top1 && songs[qiBest.i].name === top1.name) { bestIdx = qi; break; }
        if (qiBest.score > bestScore) { bestScore = qiBest.score; bestIdx = qi; }
      }
      line = lines[bestIdx] || line;
    }
    // 卡片上只展示前 5；接力一首接一首要往后顺位，所以另留前 30 给 pickWxSong() 用
    const ranked = pickDiverse(rankedAll, TAKE);
    state = {
      at: Date.now(), ok: true, busy: false, reason: 'ready', error: '',
      weather: probe, line: line || probe, place, items: ranked, pool: rankedAll,
      // 0.17.43（A4）：记下这份名单是照哪一次天气算的；下次 peek 只比对它
      weatherAt, staleMin,
    };
  } catch (e) {
    state = {
      at: Date.now(),
      ok: false,
      busy: false,
      reason: 'fail',
      error: e instanceof Error ? e.message : String(e),
      weather: '',
      place: null,
      items: [],
    };
  }
  return shot();
}
