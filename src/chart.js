/**
 * 榜单池 —— 卡④ 与接力的候选来源。
 *
 * 0.16.60 起：不再是写死的「热歌榜 200 + 飙升榜 100」，
 * 改成**按设置里勾的榜取**（`chainCharts` 存逗号分隔的榜 id，目录在 `src/charts.js`）。
 * 默认仍是热歌 + 飙升，所以不勾的人行为一点没变。
 *
 * 取数时每榜先拿满（最多 300），切分放在 `chartSongs()` 里：勾 n 个榜就每榜 300/n 首、
 * 合计封顶 300；某榜不够配额时从别的榜续进来补满 —— bge-m3 实测 47ms/条，300 条约 14 秒。
 *
 * 榜单本身一天更新几次，取一次缓存 6 小时就够，别每个面板刷新都去 spawn 一个进程。
 * 取数走 `py/chart.js`（在客户端页面里同源 fetch，不用签名、不用抠 cookie）。
 */
import { cachePath } from './store.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseChartIds, FETCH_TAKE, POOL_CAP, perChartTake } from './charts.js';
import { runProc, payloadOf, parseLastJson, logParseFail, msgOf } from './proc.js';

const CHART_FILE = cachePath('chart.json');

/** 榜单 6 小时取一次 —— 热歌榜一天更新几次，取太勤只是白花一次 CDP 往返。 */
/**
 * 0.17.16（用户口径：「一个多小时了还没刷新」）：6 小时 → 1 小时。
 * 面板那句「歌单已于 X 刷新」显示的就是榜单缓存的拉取时刻，6 小时一拉的话，
 * 重算再多遍这个时间也一动不动，看着像坏了。榜单本身按小时更新，1 小时一拉正合适。
 */
const CHART_TTL_MS = 60 * 60 * 1000;
/** 取失败退避 20 分钟，别每 30 秒去撞一次。 */
const FAIL_TTL_MS = 20 * 60 * 1000;


function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

let inflight = null;

/**
 * 「这份缓存是不是我刚要的那几个榜」。
 * 用户勾了别的榜之后，6 小时里还拿旧榜的缓存算歌 —— 那种「设了没反应」最难查，
 * 所以换榜当过期处理，当场重取。缓存没记 ids（0.16.59 及以前的老文件）也当过期。
 */
function matchesIds(c, ids) {
  const got = Array.isArray(c && c.ids) ? c.ids.map(String) : [];
  if (!got.length) return false;
  return got.length === ids.length && ids.every((id) => got.includes(id));
}

/** 同步读缓存的榜单（面板、世界都用这个，不能等）。 */
export function peekChart(ids) {
  const c = readJson(CHART_FILE);
  if (!c) return null;
  if (Date.now() - (c.at || 0) > CHART_TTL_MS) return null;
  if (!c.ok) return null;
  if (ids && !matchesIds(c, ids)) return null;
  return c;
}

/**
 * 不管多旧，只要取到过就拿出来。
 * 客户端没开、榜单拉不到的时候，宁可拿几小时前那批榜单算，也别把候选池清空。
 * 但**必须**是同一批榜 —— 换了榜就不能拿旧榜顶。
 */
export function peekChartAny(ids) {
  const c = readJson(CHART_FILE);
  if (!c || !c.ok) return null;
  if (!Array.isArray(c.charts) || !c.charts.length) return null;
  if (ids && !matchesIds(c, ids)) return null;
  return c;
}

/**
 * 起一次 py/chart.js 取榜。
 * 外壳（spawn / 40 秒 / 末行 JSON / 失败留现场）都在 proc.js 的 `netease.chart` 里；
 * 这里只管「参数怎么拼、失败怎么回话」。
 */
async function runChart(cdpPort, ids) {
  const payload = payloadOf({
    cdpPort: Number(cdpPort) || 9229,
    ids,
    take: FETCH_TAKE,
  });
  const msg = msgOf('chart');
  const r = await runProc('chart', { payload, cdpPort });
  if (r.spawnError) return { ok: false, error: `${msg.spawn}：${r.spawnError}` };
  if (r.timedOut) return { ok: false, error: msg.timeout };
  const j = parseLastJson(r.out);
  if (!j) logParseFail('netease.chart', r);
  return j || { ok: false, error: msg.parse };
}

/** 从 cfg 里读「要哪几个榜」，永远给一组非空的 id。 */
export function chartIdsOf(cfg) {
  return parseChartIds(cfg && cfg.chainCharts);
}

/** 取一次榜单（有缓存就用缓存；失败也落盘，下一轮别急着再撞）。 */
export async function ensureChart(cfg, { force = false } = {}) {
  const ids = chartIdsOf(cfg);
  if (!force) {
    const hit = peekChart(ids);
    if (hit) return hit;
    const bad = readJson(CHART_FILE);
    if (bad && !bad.ok && matchesIds(bad, ids) && Date.now() - (bad.at || 0) < FAIL_TTL_MS) return bad;
  }
  if (inflight) return inflight;
  inflight = runChart(cfg && cfg.cdpPort, ids)
    .then((r) => {
      // 这一轮没取到，但手里有同一批榜的旧缓存 → 用旧的，别把候选池清空
      if (!r.ok) {
        const old = peekChartAny(ids);
        if (old) return { ...old, stale: true, staleMs: Date.now() - (old.at || 0), error: String(r.error || '') };
      }
      const rec = {
        at: Date.now(),
        ok: !!r.ok,
        ids,
        take: FETCH_TAKE,
        charts: Array.isArray(r.charts) ? r.charts : [],
        updateTime: Number(r.updateTime) || 0,
        error: String(r.error || ''),
        errors: Array.isArray(r.errors) ? r.errors : [],
      };
      try { writeFileSync(CHART_FILE, JSON.stringify(rec), 'utf8'); } catch { /* 写不了不影响本次 */ }
      return rec;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * 榜单池的曲目合并（0.16.62 改成两轮切法）。
 *
 * 用户口径：「总共凑满 300 首做推荐」——
 *   - 只勾 1 个榜 → 整榜全取（有 300 取 300，只有 180 就给 180）；
 *   - 勾多个 → 先按均分（2 个各 150、3 个各 100…）切第一轮，
 *     某个榜本身不够配额就由第二轮从别的榜续进来，补到 300 为止；
 *   - 所有榜加起来都不够 300 → 全取，就用它们的实际合计，不硬凑。
 *
 * 为什么必须有第二轮：几个榜常年大面积重合（同一首既在热歌又在新歌），
 * 去重会吃掉很多 —— 勾两个同质榜时第一轮切完可能只剩 180 首，不补就永远凑不满。
 * 补的顺序按勾选顺序，勾的第一个榜优先，不想被摊薄就把它放第一个。
 */
export function chartSongs(chart) {
  if (!chart || !chart.ok) return [];
  const charts = (chart.charts || []).filter(Boolean);
  const per = perChartTake(charts.length || 1);
  const seen = new Set();
  const out = [];

  const take = (c, start, end) => {
    const from = String((c && c.name) || '') || String((c && c.id) || '');
    const songs = (c && c.songs) || [];
    for (const s of songs.slice(start, end)) {
      if (!s || !s.name) continue;
      const k = `${String(s.name).trim()}|${String(s.artist || '').trim()}`.toLowerCase();
      const idk = s.id ? `id:${s.id}` : '';
      if (seen.has(k) || (idk && seen.has(idk))) continue;
      seen.add(k);
      if (idk) seen.add(idk);
      // 第 111 节：durMs 是歌单原始 dt，取榜时就带回来的，白拿
      out.push({
        name: s.name,
        artist: s.artist || '',
        album: s.album || '',
        id: s.id || '',
        durMs: Number(s.durMs || 0) || 0,
        // 榜内名次与榜长：跨榜只能用 rank/rankOf 的百分位比较
        rank: Number(s.rank) || 0,
        rankOf: Number(s.rankOf) || 0,
        from,
      });
      if (out.length >= POOL_CAP) return true;
    }
    return false;
  };

  // 第一轮：每榜按配额 cut 前 per 首（单榜时 per 是 Infinity，等于整榜全取）
  for (const c of charts) if (take(c, 0, per)) return out;
  // 第二轮：还没到 300 就把各榜配额之后剩下的续进来（不足配额的榜在这里被取光）
  const cut = Number.isFinite(per) ? per : 0;
  for (const c of charts) {
    const left = ((c && c.songs) || []).slice(cut);
    if (!left.length) continue;
    if (take(c, cut)) return out;
  }
  return out;
}

export const PATHS = { CHART_FILE };
