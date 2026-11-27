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
import { weatherNow, peekWeather, wxProbe, fetchWeather } from './qweather.js';
import { chatAny } from './ollama.js';
import { sameKey } from './chain.js';
import { ensureChart, chartSongs } from './chart.js';
import { peekRecommend, peekDaily } from './recommend.js';
// 0.17.39：来源开关的唯一直译。只有「按天气」是当前来源时，这条链路才允许计算。
import { isWeatherActive } from './source.js';

/* 0.1.19（007，用户口径）：一张卡最多显示 5 条 —— 现在是「本轮已投递的那几首」。 */
const TAKE = 5;
/** 一轮 = 5 句 = 5 首歌；第 4 首投完就开始给下一轮备料。 */
const WX_ROUND_SONGS = 5;
/** 每轮从榜单池里现抽多少首当本轮候选（用户口径：300 里抽 100）。 */
const WX_ROUND_TAKE = 100;
/** 单句选歌：余弦 TOP15 → 按榜内名次丢掉后 10 → 剩 5 → 随机五选一。 */
const WX_TOP = 15;
const WX_KEEP = 5;
/** 0.1.19：池子保留榜单全量 300 首，每轮再从里面抽 100。 */
const WX_POOL_TAKE = 300;
const WX_POOL_TTL_MS = 3 * 60 * 60 * 1000;
/** 0.1.19（007）：v4 起池子保留 300、选歌改成「一句一首」；旧池直接重建。 */
const WX_POOL_VER = 4;
/** 列表里点一首 → 停手 10 秒后才真划掉（用户口径：点一首或另一首都重新计时）。 */
const DROP_DELAY_MS = 10000;

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

/* 0.17.73（用户口径：初版先用话题分工 + 5 句）：
   五句各讲一个对象（外面 / 对方 / 我自己 / 接下来 / 收尾），不串台。
   实测同样是三句时，这种"话题分工"的批内余弦 0.473，比"三句都写画面心情"（0.530）
   和"把天气字段分给三句"（0.579）都散 —— 字段怎么分都没用，句子讲不同事才管用。
   上屏仍然只挑一句（state.line），另外几句只做向量召回。 */
const LINES_MAX = 5;
/* 0.17.74（用户口径：快递小哥出现太多了）：第 1 句的"看见谁"改成每批随机指定一个人，
   既躲掉「快递小哥」这个高频道具，也顺带换掉每批的开头。池子里不放送快递/外卖的。
   实测 6 批：快递/外卖 0 次（加禁止词那种写法 4 批里还漏 1 批，4B 不听否定句）。 */
const LINES_WHO = ['遛狗的大爷', '隔壁邻居', '卖早点的摊子', '扫地的阿姨', '路过的学生', '阳台上的鸟', '楼下便利店老板', '小区保安'];
const LINES_SYSTEM = `${PERSONA} 根据天气写 5 句话，五句各讲一个对象，不要互相串：第 1 句讲【外面】，就写「{WHO}」正在做的一件有点好笑的细节（哪儿不太对劲、谁在偷懒）；第 2 句讲【对方】，写你对他的一个小猜测或小抱怨，不要解释天气；第 3 句讲【我自己】，写这种天气你自己想做点什么小动作（你自己的动作，不是给别人的建议；可以调皮、粘人、耍赖）；第 4 句讲【接下来】，写你觉得等会儿会发生什么（用你自己的说法，别念温度数字）；第 5 句写一句自言自语或反问收尾，别重复前四句的意思。第 2 句只能对「你」说，不许用他/她/他们指别人，第 4 句也一样。每句不超过 26 字，口语，不要天气报告，不要“多穿点/注意保暖”这类套话，不要用“别”开头。开头别老是「冷得……」「雾蒙蒙的天门……」「雾气……」「想赖在……」，五句的开头各不一样，换着说法写。只输出 JSON：{"lines":["...","...","...","...","..."]}`;

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

/* 0.17.75（用户口径：五句一句都不许丢）：解析改成三层保底。
   ① 正常 JSON（原样 / 截出最外层花括号）；
   ② JSON 崩了（全角引号、句子里套引号、少个逗号）就按引号把句子抓出来 —— 4B 的输出崩，
      但句子本身九成还在，直接扔整批等于白花 4 秒；
   ③ 连引号都对不上，就按行/编号切，把「1. xxx」这种剥干净。
   三层都空才返回 []（上层才退回探针句）。 */
/* 兜底抓出来的串要"像一句话"：含汉字、长度合理、不带 JSON 语法残渣。
   不然「少个逗号」那种坏输出会把 `lines":["一句" "二句` 整段当成一句塞进去。 */
function looksLikeLine(v, minLen = 6) {
  const t = String(v || '');
  if ([...t].length < minLen) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;
  if (/[{}[\]<>]/.test(t)) return false;
  if (/":|","|\{"|lines/i.test(t)) return false;
  return true;
}

const QUOTE_RE = /[“"「『]([^“”"「」『』]{6,60})[”"」』]/g;
const NUM_RE = /^\s*(?:第?\s*[0-9一二三四五]\s*[.、．:：)）]|[-*·•]|\{|\}|\[|\]|"|\s)+/;

function byQuotes(s) {
  const out = [];
  for (const m of s.matchAll(QUOTE_RE)) {
    const v = cleanLine(m[1]);
    if (looksLikeLine(v)) out.push(v);
  }
  return out;
}

function byRows(s) {
  return s.split(/[\r\n]+/)
    .map((x) => x.replace(NUM_RE, '').replace(/[",{}\[\]]+$/g, '').trim())
    .map((x) => cleanLine(x.replace(/^["“]|["”]$/g, '')))
    .filter((x) => looksLikeLine(x, 4)); // 行切出来的是整行，短句「我想赖床」也算
}

function parseLines(raw) {
  const s = String(raw || '').trim();
  let j = null;
  try { j = JSON.parse(s); } catch {
    try { j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { j = null; }
  }
  const arr = Array.isArray(j) ? j : (j && Array.isArray(j.lines) ? j.lines : []);
  let lines = arr.map((x) => cleanLine(String(x || ''))).filter(Boolean);
  if (!lines.length) lines = byQuotes(s);
  if (!lines.length) lines = byRows(s);
  return lines.slice(0, LINES_MAX);
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

/** 让模型一次写 5 句；失败返回 []（调用方退回探针句，不会空白）。 */
async function makeLines(cfg, probe, place) {
  const user = `${probe}。现在是${timeOfDay()}，你在${placeText(place) || '屏幕底边'}。`;
  // 第 1 句"看见谁"每批随机指定：换掉高频道具，也让每批开头不一样
  const who = LINES_WHO[Math.floor(Math.random() * LINES_WHO.length)] || LINES_WHO[0];
  const r = await chatAny(cfg, [
    { role: 'system', content: LINES_SYSTEM.replace('{WHO}', who) },
    { role: 'user', content: user },
  ], { temperature: 0.9, numPredict: 320, timeoutMs: 25000 });
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
  /** 0.1.19（007）：本轮已经投递出去的那几首（1～5），不是"候选前五"。 */
  items: [],
  /** 本轮 100 首里还没用掉的那些（排查/工具用）。 */
  pool: [],
  // 这份名单是照哪一次天气快照算的
  weatherAt: 0,
  // 天气数据多久没更新（分钟）—— 面板据此提示"这是旧数据"
  staleMin: 0,
};

/**
 * 0.1.19（007，用户口径）：一轮 = 5 句 = 5 首。句子一句一句地消耗，每投一首就少一句。
 *   - `lines`：这一轮的 5 句
 *   - `used`：已经投出去的句子下标（等于"下一句是第几句"）
 *   - `usedSongs`：已经投出去的歌（key），确保同一轮不重复
 *   - `songs / vecs`：本轮从 300 里抽的 100 首 + 它们的向量（只在开轮时算一次）
 *   - `picks`：每句已经算好的那首（面板预告和真投递共用一份，避免"预告 A 实际放 B"）
 */
let round = null;
/** 第 4 首投完就开始备的料：下一轮的 5 句 + 100 首 + 向量。只备料，不动本轮。 */
let roundNext = null;
/** 备料那次还在飞（点歌时先等它，避免并发再开一轮）。 */
let roundNextPromise = null;
let roundSeq = 0;

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
    merged.push({ name: String(s.name), artist: String(s.artist || ''), album: String(s.album || ''), id: String(s.id || ''), durMs: Number(s.durMs) || 0, rank: Number(s.rank) || 0, rankOf: Number(s.rankOf) || 0, from: String(s.from || '') });
  }
  if (!merged.length) return cur.songs;
  const songs = shuffle(merged, Date.now() % 100000).slice(0, WX_POOL_TAKE);
  writeWxPool(songs);
  return songs;
}

function staleOf(weatherAt) {
  return weatherAt ? Math.max(0, Math.round((Date.now() - weatherAt) / 60000)) : 0;
}

function shot() {
  const r = round;
  const total = r && Array.isArray(r.lines) ? r.lines.length : 0;
  const used = r && Array.isArray(r.used) ? r.used.length : 0;
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
    // 0.1.19（007）：这一轮还剩几首没投 / 下一首是第几句
    left: Math.max(0, total - used),
    lineIdx: used,
  };
}

/** 快照用：新鲜就返回，过期就顺手在后台算一次（不阻塞这一帧）。 */
/* 0.17.76（用户口径「开机别抢资源」）：启动后 4 分钟内一律不自动算句子。
   那 4 分钟里面板只回 `boot-wait`，显示"还没算好"；天气定时器这会儿已经把新数据抓回来了
   （缓存旧的话启动约 1 秒后就抓一次），所以 4 分钟一到，预热那次用的必然是新鲜天气。
   想立刻看 → 只有「换一批」会绕开这个窗口（scheduleWxReco 不判它）。
   慢就让它慢，用户明确不管这个。 */
export const WX_BOOT_WAIT_MS = 4 * 60 * 1000;
let bootAt = 0;
let warmTimer = null;

/** 世界启动时调用一次：4 分钟后预热第一批句子（顺手补一次天气，避免拿旧数据写）。 */
export function startWxWarmup(cfg) {
  if (warmTimer) return;
  bootAt = Date.now();
  warmTimer = setTimeout(async () => {
    warmTimer = null;
    try {
      const w = peekWeather();
      if (!w || !w.ok || Date.now() - Number(w.at || 0) > 20 * 60 * 1000) {
        try { await fetchWeather(cfg); } catch { /* 抓不到就照旧用缓存里的 */ }
      }
      await refreshWxReco(cfg);
    } catch { /* 预热失败不影响后面任何一次读 */ }
  }, WX_BOOT_WAIT_MS);
  if (warmTimer.unref) warmTimer.unref();
}

export function peekWxReco(cfg, { kick = true } = {}) {
  if (!isWeatherActive(cfg)) {
    return { ...shot(), ok: false, reason: 'inactive', items: [], pool: [] };
  }
  /* 0.1.19（007，用户口径）：天气数字不变也照样重新生成句子 —— 所以"该不该重算"
     不再看天气版本，只看**这一轮的 5 句是不是投完了**。
     天气只用来写句子；它的 TTL（qwInterval 15 分钟）只管远端多久抓一次。 */
  const w = peekWeather();
  if (w && w.ok) {
    state.weatherAt = Number(w.at || 0);
    state.staleMin = staleOf(state.weatherAt);
  }
  const total = round && Array.isArray(round.lines) ? round.lines.length : 0;
  const used = round && Array.isArray(round.used) ? round.used.length : 0;
  const fresh = !!(state.ok && total > 0 && used < total);
  const bootWait = bootAt > 0 && Date.now() - bootAt < WX_BOOT_WAIT_MS;
  if (kick && !state.busy && !fresh && !bootWait) {
    if (total === 0) {
      // 还一轮都没有 → 现开一轮
      state.reason = state.reason === 'pending' ? 'pending' : 'stale';
      void refreshWxReco(cfg).catch(() => { /* 失败落在 state.error */ });
    } else {
      // 本轮 5 句投完了：**不在这里换轮**。换轮发生在下一次递歌那一刻（nextWxSong），
      // 不然最后那首还在放，列表就先被清空了。
      state.reason = 'round-end';
    }
  } else if (kick && bootWait && !fresh && !state.busy) {
    // 启动窗口里：不改状态、不起算，只把原因说清楚（面板据此显示"还没算好"）
    state.reason = 'boot-wait';
  }
  return shot();
}

/**
 * 0.1.19（用户口径）：旧名保留给老调用点，语义已改成「换一首」——见 rerollWxPick。
 * 不再排队 2.5 秒（排队会把连点合并成一次，就跟「点一下丢一句」对不上了）；
 * 现在一次只丢一句，热态 100 毫秒内算完，慢也是慢在冷态模型加载。
 */
export function scheduleWxReco(cfg, opts = {}) {
  return rerollWxPick(cfg, opts);
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
function songKey(s) {
  return keyOfSong(s);
}

/* 0.1.19：被丢掉/投出去过的歌记一小时 —— 换一批丢掉的那首不该在下一轮又被抽中。
   同一轮里靠 usedSongs 就够，这一层管的是「跨轮」（每轮会从 300 里重抽 100）。 */
const WASTE_TTL_MS = 60 * 60 * 1000;
const wasteAt = new Map();

function markWaste(k) {
  const key = String(k || '');
  if (!key) return;
  const now = Date.now();
  if (wasteAt.size > 300) {
    for (const [x, t] of wasteAt) if (now - t > WASTE_TTL_MS) wasteAt.delete(x);
  }
  wasteAt.set(key, now);
}

function isWaste(k) {
  const key = String(k || '');
  if (!key) return false;
  const t = wasteAt.get(key);
  if (!t) return false;
  if (Date.now() - t > WASTE_TTL_MS) {
    wasteAt.delete(key);
    return false;
  }
  return true;
}

function publishRound(r) {
  state.at = r.at;
  state.ok = true;
  state.busy = false;
  state.reason = 'ready';
  state.error = '';
  state.weather = r.probe;
  state.place = r.place;
  state.line = String(r.lines[0] || '').trim();
  state.items = [];
  state.pool = r.songs.slice();
  state.weatherAt = r.weatherAt;
  state.staleMin = Number.isFinite(r.staleMin) ? r.staleMin : staleOf(r.weatherAt);
}

/** 本轮从榜单池（300 首）里现抽 100 首；先剔「卡① 挂着的那几首 + 最近听过的」。 */
async function sampleRound(cfg) {
  let songs = await ensureWxPool(cfg);
  const avoid = avoidNames(cfg);
  let use = (songs || []).filter((s) => s && s.name && !avoid.some((a) => sameKey(a, s.name)));
  // 0.1.19：刚丢掉/刚投出去的那几首别再抽进来
  use = use.filter((s) => !isWaste(keyOfSong(s)));
  if (!use.length) {
    // 池子空了才退回推荐那份，别让卡片空白
    try {
      const j = JSON.parse(readFileSync(cachePath('reco-pool.json'), 'utf8'));
      use = (j && Array.isArray(j.songs) ? j.songs : []).filter((s) => s && s.name);
    } catch { use = []; }
  }
  return shuffle(use, Date.now() % 99991).slice(0, WX_ROUND_TAKE);
}

/**
 * 开一轮：读天气缓存（**不强抓**）+ 写 5 句 + 抽 100 首 + 算 100 首向量。
 * 第 4 首投完时后台跑的就是它（只备料，不动当前这一轮）。
 */
async function buildRound(cfg) {
  const w = await weatherNow(cfg, { force: false });
  const weatherAt = w && w.ok ? Number(w.at || 0) : 0;
  if (!w || !w.ok) return { error: 'weather-fail', message: String((w && w.error) || '天气没查到') };
  const probe = wxProbe(w);
  const place = w.place ? { name: w.place.name, adm1: w.place.adm1, adm2: w.place.adm2, country: w.place.country } : null;
  let lines = [];
  try { lines = await makeLines(cfg, probe, place); } catch { lines = []; }
  lines = lines.map((x) => String(x || '').trim()).filter(Boolean);
  if (!lines.length) lines = [probe];
  const songs = await sampleRound(cfg);
  if (!songs.length) return { error: 'no-pool', message: '' };
  const model = String((cfg && cfg.embedModel) || '').trim();
  if (!model) return { error: 'no-embed', message: '' };
  const vecs = await embedTexts(cfg, songs.map((s) => `${s.name} ${s.artist}`.trim()));
  return {
    seq: (roundSeq += 1),
    at: Date.now(),
    weatherAt,
    staleMin: staleOf(weatherAt),
    probe,
    place,
    lines,
    used: [],
    usedSongs: [],
    songs,
    vecs,
    picks: new Map(),
    prewarm: false,
  };
}

/**
 * 一句 → 一首：余弦 TOP15 → 按榜内名次丢掉后 10（并列一起留）→ 剩 5 随机五选一。
 * 结果按「第几句 + 排除了谁」缓存，面板预告和真投递共用同一份，不会预告 A 放 B。
 */
async function computePick(cfg, r, idx, exclude) {
  const line = String((r.lines && r.lines[idx]) || '').trim();
  if (!line) return null;
  const model = String((cfg && cfg.embedModel) || '').trim();
  if (!model) return null;
  const [qv] = await embedTexts(cfg, [line]);
  if (!qv) return null;
  const skip = new Set(r.usedSongs || []);
  const cands = r.songs
    .map((s, i) => ({ s, cos: cosine(qv, r.vecs[i]) }))
    .filter((c) => c.s && c.s.name && !skip.has(songKey(c.s)))
    .filter((c) => !isWaste(songKey(c.s)))
    .filter((c) => !exclude.some((e) => sameKey(e, c.s.name)));
  if (!cands.length) return null;
  cands.sort((a, b) => b.cos - a.cos);
  const top = cands.slice(0, WX_TOP);
  const rankNum = (s) => (Number(s.rank) > 0 ? Number(s.rank) : 9999);
  top.sort((a, b) => (rankNum(a.s) - rankNum(b.s)) || (b.cos - a.cos));
  /* 0.1.19（用户口径 11-27「怎么显示 7 首」）：**固定 5 首**，并列名次不再扩张。
     之前第 5 名和第 6/7 名名次并列时会一起留下，面板就冒出 7 条；用户要的是「剩 5 首、五选一」。 */
  const keep = top.slice(0, WX_KEEP);
  const pick = keep[Math.floor(Math.random() * keep.length)];
  const out = { pick, line, keep };
  if (r.picks) r.picks.set(idx, out);
  return out;
}

/** 面板预告：下一句会配的那首（不消耗句子，算过就复用）。 */
export async function peekNextWx(cfg, { exclude = [] } = {}) {
  if (!isWeatherActive(cfg)) return null;
  const r = round;
  if (!r || !Array.isArray(r.lines) || r.used.length >= r.lines.length) return null;
  const idx = r.used.length;
  const ex = (exclude || []).map((x) => String(x || '').trim()).filter(Boolean);
  let cand = r.picks && r.picks.has(idx) ? r.picks.get(idx) : null;
  if (!cand || ex.some((e) => sameKey(e, cand.pick.s.name))) {
    try { cand = await computePick(cfg, r, idx, ex); } catch { return null; }
  }
  if (!cand || !cand.pick) return null;
  const s = cand.pick.s;
  /* 0.1.19（用户口径 11-27「以前不是还有五首候选吗」）：把这句算出来的那 5 首一并带出去，
     面板照着列表显示，点哪首就用这一句放哪首（不点就等自动接力按随机那首投）。 */
  const cands = (cand.keep || []).map((it) => ({
    name: String(it.s.name || ''),
    artist: String(it.s.artist || ''),
    id: String(it.s.id || ''),
    rank: Number(it.s.rank) || 0,
    rankOf: Number(it.s.rankOf) || 0,
    sim: Math.round((Number(it.cos) || 0) * 1000) / 1000,
  })).filter((x) => x.name);
  return { name: s.name, artist: s.artist || '', id: s.id || '', line: cand.line, cands };
}

/**
 * 0.1.19（用户口径 11-27）：面板候选列表里点了一首 → 就用**当前这一句**把它投出去。
 * 找不到（比如刚好被换一批拿掉了）就退回这一句随机选中的那首，不让点击白点。
 */
export async function takeWxCand(cfg, { id = '', name = '', exclude = [] } = {}) {
  if (!isWeatherActive(cfg)) return null;
  if (state.busy) return null;
  const r = round;
  if (!r || !Array.isArray(r.lines) || r.used.length >= r.lines.length) return null;
  const idx = r.used.length;
  const ex = (exclude || []).map((x) => String(x || '').trim()).filter(Boolean);
  let cand = r.picks && r.picks.has(idx) ? r.picks.get(idx) : null;
  if (!cand) {
    try { cand = await computePick(cfg, r, idx, ex); } catch { return null; }
  }
  if (!cand) return null;
  const wantId = String(id || '').trim();
  const wantName = String(name || '').trim();
  let hit = null;
  for (const it of (cand.keep || [])) {
    if ((wantId && String(it.s.id || '') === wantId) || (wantName && sameKey(wantName, it.s.name))) {
      hit = it;
      break;
    }
  }
  const s = (hit && hit.s) || (cand.pick && cand.pick.s) || null;
  if (!s) return null;
  return commitPick(cfg, r, s, hit ? hit.cos : (cand.pick ? cand.pick.cos : 0), cand.line);
}

/* 第 4 首投完 → 后台给下一轮备料（下一轮的 5 句 + 100 首 + 向量）。
   只备料，本轮池子一首都不动，第 5 首照旧在旧池里选。
   0.1.19：换一批划掉一句也算「消耗了一句」，同一个判定，所以抽成 maybePrep。 */
function maybePrep(cfg, r) {
  if (!r || !Array.isArray(r.lines) || r.lines.length < 4) return;
  if (r.used.length < r.lines.length - 1) return;
  if (roundNext || roundNextPromise || r.prewarm) return;
  r.prewarm = true;
  roundNextPromise = buildRound(cfg)
    .then((n) => {
      if (n && !n.error) roundNext = n;
      return n;
    })
    .catch(() => null)
    .finally(() => { roundNextPromise = null; });
}

/**
 * 0.1.19（007 同规则）：接力取下一首 = 消耗下一句。
 *   取这一轮没用过的第 N 句 → 算出它那首 → 这首歌和这句都从候选里划掉 →
 *   写进列表（同时它就是面板下面那句）。
 * 第 4 首投完后就后台给下一轮备料；投完第 5 首时直接把备好的那轮换上。
 * 返回 null = 天气这路当前没料（调用方退回推荐）。
 */
export async function nextWxSong(cfg, { exclude = [] } = {}) {
  if (!isWeatherActive(cfg)) return null;
  const ex = (exclude || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (state.busy) return null;
  let r = round;
  const done = !r || !Array.isArray(r.lines) || r.used.length >= r.lines.length;
  if (done) {
    // 换轮那一刻：先等备料的那次（真点歌时它早就跑完了，等 0 秒），没有备好才现算
    if (!roundNext && roundNextPromise) {
      try { await roundNextPromise; } catch { /* 备料失败就现算 */ }
      if (roundNext && roundNext.error) roundNext = null;
    }
    if (roundNext) {
      r = roundNext;
      roundNext = null;
    } else {
      const built = await buildRound(cfg);
      if (built.error) {
        state.at = Date.now();
        state.ok = false;
        state.busy = false;
        state.reason = built.error;
        state.error = String(built.message || '');
        return null;
      }
      r = built;
    }
    round = r;
    publishRound(r);
  }
  const idx = r.used.length;
  let cand = r.picks && r.picks.has(idx) ? r.picks.get(idx) : null;
  if (!cand || ex.some((e) => sameKey(e, cand.pick.s.name))) {
    cand = await computePick(cfg, r, idx, ex);
  }
  if (!cand || !cand.pick) return null;
  return commitPick(cfg, r, cand.pick.s, cand.pick.cos, cand.line);
}

/**
 * 0.1.19：把某一首真正投出去（消耗这一句、进列表、可能触发备料）。
 * 自动递歌和「用户点了候选里的一首」共用这一段，保证两条路写进去的东西一模一样。
 */
function commitPick(cfg, r, s, cos, line) {
  const idx = r.used.length;
  r.used.push(idx);
  r.usedSongs.push(songKey(s));
  markWaste(songKey(s));
  const item = {
    name: s.name,
    artist: s.artist || '',
    album: s.album || '',
    id: s.id || '',
    songId: s.id || '',
    durMs: Number(s.durMs) || 0,
    from: s.from || '',
    rank: Number(s.rank) || 0,
    rankOf: Number(s.rankOf) || 0,
    sim: Math.round((Number(cos) || 0) * 1000) / 1000,
    line,
  };
  state.items = [...state.items, item].slice(-TAKE);
  state.pool = r.songs.filter((x) => !r.usedSongs.includes(songKey(x)));
  state.line = line;
  state.at = Date.now();
  state.ok = true;
  state.reason = 'ready';
  state.error = '';
  state.weatherAt = r.weatherAt;
  state.staleMin = Number.isFinite(r.staleMin) ? r.staleMin : staleOf(r.weatherAt);
  /* 0.1.19：第 4 首投完（或换一批划掉到第 4 句）→ 后台给下一轮备料，判定都在 maybePrep 里。 */
  maybePrep(cfg, r);
  return {
    name: String(s.name),
    artist: String(s.artist || ''),
    id: String(s.id || ''),
    src: 'wx',
    line: String(line || ''),
  };
}

/**
 * 0.1.20（用户口径「点的时候经常失败」）：点的那一首**真没放出来** → 把这次投递撤回去。
 * 撤回条件很严：撤的必须是「最后一条、而且就是这个歌名+歌手」，中间又有歌投出去就撤不了。
 * 撤完 `used / usedSongs / items / picks` 全部回到点击前，这一句和这首还在候选里，可以再点别的。
 */
export function undoWxPick(cfg, { name = '', artist = '' } = {}) {
  const r = round;
  if (!r) return false;
  const key = `${String(name || '').trim().toLowerCase()}|${String(artist || '').trim().toLowerCase()}`;
  const last = state.items[state.items.length - 1];
  if (!last || songKey(last) !== key) return false;
  if (!r.used.length) return false;
  const idxOld = r.used.length - 1;
  state.items = state.items.slice(0, -1);
  const i = r.usedSongs.lastIndexOf(key);
  if (i >= 0) r.usedSongs.splice(i, 1);
  r.used.pop();
  wasteAt.delete(key);                   // 撤回的这首不算「用掉了」，还得能再点
  if (r.picks) r.picks.delete(idxOld);   // 缓存也清掉，免得下次又端出同一首
  state.pool = r.songs.filter((x) => !r.usedSongs.includes(songKey(x)));
  state.line = String(r.lines[r.used.length] || '');
  state.at = Date.now();
  state.reason = 'ready';
  return true;
}

/* 0.1.19（用户口径）：换一批这一串点击**串行**执行 —— 前一下没算完，后一下排队等着，
   绝不两次并发去算（两次同时 embed 100 首会互相抢 Ollama，之前第 6 首 22 秒就是这么来的）。 */
let rerollChain = Promise.resolve();

export function rerollWxPick(cfg, { exclude = [] } = {}) {
  if (!isWeatherActive(cfg)) return Promise.resolve({ ...shot(), ok: false, reason: 'inactive' });
  const job = rerollChain.then(() => rerollOnce(cfg, { exclude })).catch(() => shot());
  rerollChain = job.then(() => null, () => null);
  return job;
}

/**
 * 0.1.19（用户口径）：换一批 = 丢掉**当前这一句** + 丢掉**它已经配好的那首**（面板上《》里那首），
 * 然后用下一句重新算一首（只算预告，不进列表）。
 *   - 句子和歌同时跟着换（`state.line` 与 `computePick` 的缓存一起换）
 *   - 丢掉的那首进 `usedSongs`，本轮不会再被选中
 *   - 丢到第 4 句 → 后台备料（和投递同一套规则）
 *   - 5 句全丢完、下一轮还没出来 → **原地等**（等备好的那轮 / 等它算完），算完直接换上
 */
async function rerollOnce(cfg, { exclude = [] } = {}) {
  const ex = (exclude || []).map((x) => String(x || '').trim()).filter(Boolean);
  let r = round;
  if (!r || !Array.isArray(r.lines) || r.used.length >= r.lines.length) {
    // 这一轮的句子已经全丢完（或还没开轮）：等下一轮，不等就直接算
    return startNextRoundWait(cfg);
  }
  state.busy = true;
  state.reason = 'picking';
  try {
    const idx = r.used.length;
    // ① 丢掉这一句已经配好的那首：算过就直接拿，没算过现算一次（也就 20 毫秒）
    let old = r.picks && r.picks.has(idx) ? r.picks.get(idx) : null;
    if (!old) old = await computePick(cfg, r, idx, ex);
    if (old && old.pick && old.pick.s && old.pick.s.name) {
      const k = songKey(old.pick.s);
      if (!r.usedSongs.includes(k)) r.usedSongs.push(k);
      markWaste(k);   // 丢掉的那首跨轮也别再抽回来
    }
    // ② 丢掉这一句（作废，不再参与本轮）
    r.used.push(idx);
    if (r.picks) r.picks.delete(idx);
    // ③ 用下一句算新的一首（只是预告，还没真投）
    const nidx = r.used.length;
    let nxt = null;
    if (nidx < r.lines.length) {
      try { nxt = await computePick(cfg, r, nidx, ex); } catch { nxt = null; }
    }
    state.pool = r.songs.filter((x) => !r.usedSongs.includes(songKey(x)));
    state.line = nxt && nxt.line ? String(nxt.line) : String(r.lines[nidx] || '');
    state.at = Date.now();
    state.ok = true;
    state.reason = nidx >= r.lines.length ? 'round-end' : 'ready';
    state.error = '';
    state.weatherAt = r.weatherAt;
    state.staleMin = Number.isFinite(r.staleMin) ? r.staleMin : staleOf(r.weatherAt);
    maybePrep(cfg, r);
  } catch (e) {
    state.at = Date.now();
    state.ok = false;
    state.reason = 'fail';
    state.error = String((e && e.message) || e);
  } finally {
    state.busy = false;
  }
  return shot();
}

/**
 * 0.1.19（用户口径「全抛弃完了就等」）：这一轮 5 句都用完了 → 换新一轮。
 * 备料已经在跑就等它（面板停在「正在挑…」），备好了直接用；只有真没有才现算。
 */
async function startNextRoundWait(cfg) {
  state.busy = true;
  state.reason = 'picking';
  try {
    if (!roundNext && roundNextPromise) {
      try { await roundNextPromise; } catch { /* 备料失败就现算 */ }
    }
    if (roundNext && roundNext.error) roundNext = null;
    let r = roundNext;
    if (r) {
      roundNext = null;
    } else {
      const built = await buildRound(cfg);
      if (built.error) {
        state.at = Date.now();
        state.ok = false;
        state.reason = built.error;
        state.error = String(built.message || '');
        return shot();
      }
      r = built;
    }
    round = r;
    roundNextPromise = null;
    publishRound(r);
    return shot();
  } finally {
    state.busy = false;
  }
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
/**
 * 0.1.19（007，用户口径）：列表里点一首，**不立刻划掉** —— 停手 10 秒后才真删。
 * 点同一首或另一首都重新计时（全局一个 debounce）：
 * 连着点几首试听，列表一行都不少；停手 10 秒后待删的那几首一起删。
 * 现在列表是「本轮已投递」，删了就删了，不从池里补位。
 */
let pendingDrop = new Set();
let dropTimer = null;

export function dropWxSong(name) {
  const n = String(name || '').trim();
  if (!n) return shot();
  const hit = state.items.find((it) => it && sameKey(n, it.name));
  const key = hit ? songKey(hit) : `${n.toLowerCase()}|`;
  pendingDrop.add(key);
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = setTimeout(() => {
    dropTimer = null;
    const keys = pendingDrop;
    pendingDrop = new Set();
    state.items = state.items.filter((it) => !keys.has(songKey(it)));
  }, DROP_DELAY_MS);
  if (dropTimer.unref) dropTimer.unref();
  return shot();
}


/**
 * 0.1.19（007）：立即开新一轮 —— 写 5 句 + 从 300 抽 100 + 算 100 首向量。
 * 「换一批」、启动预热、切回天气都走这里；第 4 首投完后自动备料走 buildRound（只备料不动本轮）。
 * 天气**不强抓**：只读 qweather.js 那份缓存，数字没变也照样让模型重新写 5 句。
 */
export async function refreshWxReco(cfg, { explicit = false } = {}) {
  if (!explicit && !isWeatherActive(cfg)) return { ...shot(), ok: false, reason: 'inactive' };
  if (state.busy) return shot();
  state.busy = true;
  state.reason = 'picking';
  try {
    const r = await buildRound(cfg);
    if (r.error) {
      state.at = Date.now();
      state.ok = false;
      state.busy = false;
      state.reason = r.error;
      state.error = String(r.message || '');
      state.items = [];
      state.pool = [];
      return shot();
    }
    round = r;
    roundNext = null;
    publishRound(r);
  } catch (e) {
    state.at = Date.now();
    state.ok = false;
    state.busy = false;
    state.reason = 'fail';
    state.error = e instanceof Error ? e.message : String(e);
    state.items = [];
    state.pool = [];
  }
  return shot();
}
