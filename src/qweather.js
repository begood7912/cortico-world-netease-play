/**
 * 0.17.30：天气查询从 panel.js 挪出来，单独一个文件。
 * 原来只给「模型」页的配置卡用；现在「此刻」页要按天气推荐歌，也需要同一份实况，
 * 两边共用一份实现，别各写一套 URL 和鉴权。
 *
 * 口径（都已实测）：
 *   · 地点走 GeoAPI v2（自定义 host 上按城市 id 查会 400 Data Not Available，坐标稳）
 *   · 实况与每日预报走 v1：/weather/v1/current|daily/{lat}/{lon}
 *   · 鉴权用请求头 X-QW-Api-Key（v1 不吃 ?key=）
 *   · 密钥只从配置读，不落日志
 */
/**
 * 0.17.36（用户口径）：天气查询不要「每用一次查一次」，直接读 15 分钟那一次的结果。
 * 宿主「实时天气」扩展确实每 15 分钟查一次（REALTIME_WEATHER_CURRENT_INTERVAL_MS），
 * 但那份数据只在它的进程内存里，没有落盘、也没有对外接口 —— 本插件读不到。
 * 所以在插件这边做同一件事：一个后台定时器按 qwInterval（默认 15 分钟）查一次，
 * 结果落盘到 data\weather-cache.json；「模型」页那张天气卡和卡片5 全都读这一份。
 * 每月 96×30 ≈ 2880 次，离 5 万额度很远。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { cachePath } from './store.js';

/**
 * 0.17.37（用户口径）：天气只认一个文件 —— data\weather-cache.json。
 * 每一次读都从文件读（文件变了就换成本地副本），写入只改这个文件；
 * 面板、卡片5、接力挑歌都走 weatherNow / weatherSnapshot，谁都不自己存一份。
 */
let snap = null;
let snapMtime = -1;
let timerCfg = null;

/* 0.17.68：原来这里硬写着我那台机器的和风专属域名（发布时会一起带出去）。
   现在必须由使用者在设置里填自己的 Host；没填就不抓。 */
const DEFAULT_HOST = '';
const DIR_ZH = { n: '北', ne: '东北', e: '东', se: '东南', s: '南', sw: '西南', w: '西', nw: '西北' };

export function dirZh(compass) {
  const k = String(compass || '').toLowerCase();
  return DIR_ZH[k] || String(compass || '');
}

function cacheFile() {
  return cachePath('weather-cache.json');
}

/** 每次读都从文件读：文件被换掉/改了就用新的那份，内存只是复本不是真源。 */
function loadSnap() {
  try {
    const m = statSync(cacheFile()).mtimeMs;
    if (snap && m === snapMtime) return;
    const j = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    if (j && j.data && Number(j.at)) { snap = { at: Number(j.at), data: j.data }; snapMtime = m; }
  } catch { /* 没有/读不了：等真查 */ }
}

function saveSnap(d) {
  snap = { at: Date.now(), data: d };
  try {
    writeFileSync(cacheFile(), JSON.stringify({ at: snap.at, data: d }), 'utf8');
    snapMtime = statSync(cacheFile()).mtimeMs;
  } catch { /* 写不了不影响本次 */ }
}

function ttlMs(cfg) {
  const n = Number(cfg && cfg.qwInterval);
  return (Number.isFinite(n) && n > 0 ? n : 15) * 60 * 1000;
}

/**
 * 后台自动查询：按 qwInterval（默认 15 分钟）准点自己查一次并落盘。
 * 世界一启动就挂上，不依赖谁打开面板 —— 这样「15 分钟一次」才是真的在跑。
 * 每次查完按当前 ttl 重新排下一次（设置里间隔改了也跟得上）。
 */
let loopTimer = null;

function scheduleNext(delayMs) {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = setTimeout(async () => {
    if (!timerCfg) return;
    try { await fetchWeather(timerCfg); } catch { /* 失败下次再试 */ }
    // 0.17.40（用户口径「固定刷新，不随任何动作停止」）：这里按设定间隔排下一次，
    // 手动查询 / 测试连接 / 切来源都不许重排或提前 —— 它们不改这个节拍。
    scheduleNext(ttlMs(timerCfg) + 5_000);
  }, Math.max(1000, delayMs));
  if (loopTimer.unref) loopTimer.unref();
}

export function startWeatherAuto(cfg) {
  timerCfg = cfg || {};
  if (loopTimer) return;
  loadSnap();
  const ttl = ttlMs(timerCfg);
  const age = snap ? Date.now() - snap.at : ttl;
  scheduleNext(ttl - age + 5_000);
}

/** 只读快照：面板自动刷新走这里，一次接口都不打。 */
export function weatherSnapshot() {
  loadSnap();
  return snap ? snap.data : { ok: false, error: '还没查过' };
}

/**
 * 0.17.40：**只读缓存**，永不抓取。
 * 面板、卡片5、接力挑歌这些"读天气"的地方一律走它 —— 远端只有一个入口 `fetchWeather()`。
 */
export function peekWeather() {
  loadSnap();
  // 带上这份数据的抓取时刻（`at`），上层用它判断"天气变了没有"，不用再去猜间隔
  return snap ? { ...snap.data, at: snap.at } : { ok: false, error: '还没查过' };
}

/**
 * 0.17.40：**唯一抓取入口** —— 后台定时器，和用户显式点的「测试连接 / 手动查询」。
 * 注意：它不改定时器节拍。以前 `weatherNow(force)` 会顺手 `scheduleNext(...)`，
 * 于是一次手动查询就把"固定 15 分钟"推后了十几分钟。
 */
export async function fetchWeather(cfg) {
  startWeatherAuto(cfg);
  const c = cfg || {};
  const host = String(c.qwApiHost || DEFAULT_HOST).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const key = String(c.qwApiKey || '').trim();
  const city = String(c.qwCity || '').trim();
  const adm = String(c.qwAdmin || '').trim();
  // 0.17.68：默认不再替你按一个城市/域名 —— 没填就说清楚，别去查一个和用户无关的地方
  if (!key) return { ok: false, error: '还没填 API Key' };
  if (!host) return { ok: false, error: '还没填 API Host' };
  if (!city) return { ok: false, error: '还没填地点' };
  const hdr = { 'X-QW-Api-Key': key };
  const get = async (path) => {
    const r = await fetch(`https://${host}${path}`, { headers: hdr, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  try {
    const geo = await get(`/geo/v2/city/lookup?location=${encodeURIComponent(city)}&number=10&lang=zh${adm ? `&adm=${encodeURIComponent(adm)}` : ''}`);
    const loc = (geo && Array.isArray(geo.location) && geo.location[0]) || null;
    if (String(geo && geo.code) !== '200' || !loc) return { ok: false, error: '地点没查到' };

    const pt = `${loc.lat}/${loc.lon}`;
    const cur = await get(`/weather/v1/current/${pt}?lang=zh`);
    const days = (await get(`/weather/v1/daily/${pt}?days=2&localTime=true&lang=zh`)).days || [];
    const data = {
      ok: true,
      place: { name: loc.name, adm1: loc.adm1, adm2: loc.adm2, country: loc.country, id: loc.id, lat: loc.lat, lon: loc.lon },
      updateTime: cur.metadata && cur.metadata.validTime ? cur.metadata.validTime : '',
      now: {
        temp: cur.temperature && cur.temperature.value,
        text: cur.condition && cur.condition.text,
        feelsLike: cur.feelsLike && cur.feelsLike.value,
        humidity: cur.humidity == null ? '' : Math.round(cur.humidity * 100),
        code: cur.condition && cur.condition.code,
        windDir: cur.wind && cur.wind.direction && cur.wind.direction.compass,
        windDirDeg: cur.wind && cur.wind.direction && cur.wind.direction.degree,
        windSpeed: cur.wind && cur.wind.speed && cur.wind.speed.value,
        windScale: cur.wind && cur.wind.scale,
        windGust: cur.windGust && cur.windGust.value,
        pressure: cur.pressure && cur.pressure.value,
        visibility: cur.visibility && cur.visibility.value,
        dewPoint: cur.dewPoint && cur.dewPoint.value,
        cloudCover: cur.cloudCover == null ? '' : Math.round(cur.cloudCover * 100),
        uvIndex: cur.uvIndex,
        precipAmount: cur.precipitation && cur.precipitation.amount && cur.precipitation.amount.value,
        precipIntensity: cur.precipitation && cur.precipitation.intensity && cur.precipitation.intensity.value,
        precipType: cur.precipitation && cur.precipitation.type,
      },
      daily: days.map((d) => ({
        date: String(d.forecastStartTime || '').slice(0, 10),
        min: d.temperatureMin && d.temperatureMin.value,
        max: d.temperatureMax && d.temperatureMax.value,
        dayText: d.daytime && d.daytime.condition && d.daytime.condition.text,
        nightText: d.nighttime && d.nighttime.condition && d.nighttime.condition.text,
        precip: d.daytime && d.daytime.precipitation && d.daytime.precipitation.probability,
      })),
    };
    saveSnap(data);
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 兼容旧调用：`force:true` 才真抓一次（面板「测试连接 / 手动查询」）；
 * `force:false`（默认）只读缓存。业务代码要读天气，请直接用 `peekWeather()`。
 */
export async function weatherNow(cfg, { force = false } = {}) {
  startWeatherAuto(cfg);
  if (force) return fetchWeather(cfg);
  return peekWeather();
}

/** 把实况压成一句「给向量模型看」的话；不带符号，纯口语。 */
export function wxProbe(r) {
  if (!r || !r.ok) return '';
  const n = r.now || {};
  const round = (v) => (v == null ? '' : String(Math.round(Number(v) * 10) / 10));
  const parts = [];
  if (n.text) parts.push(String(n.text));
  if (round(n.temp)) parts.push(`气温${round(n.temp)}度`);
  if (round(n.feelsLike)) parts.push(`体感${round(n.feelsLike)}度`);
  if (n.windDir || n.windScale) parts.push(`${dirZh(n.windDir)}风${n.windScale == null ? '' : `${n.windScale}级`}`);
  if (n.humidity !== '' && n.humidity != null) parts.push(`湿度${n.humidity}%`);
  return parts.join('，');
}
