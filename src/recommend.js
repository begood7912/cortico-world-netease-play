/**
 * 卡④「今天听点什么」—— 用向量把她听过的东西和网易云「每日推荐」比一比，挑出最像的几首。
 *
 * 数据来自三处，权重不一样：
 *   - `data\listening.jsonl`（实际听了多久）—— 最诚实的偏好信号，听半小时的歌比听 20 秒的重得多；
 *   - `notes\点歌次数.json`（主动点过几次）—— 主动点一次，比被动听一遍更有说明力，权重给到 8；
 *   - 「每日推荐」（需要 cookie，走 py/recommend.js 子进程，跟取歌词同一套路）。
 *
 * 为什么用向量而不是按歌手/年代推荐：
 * 按歌手推会把推荐变成「同一个人再来十首」，按年代推就给不出新东西。
 * bge-m3 把「歌名 + 歌手」放进同一个语义空间，同一首歌的不同版本、
 * 相近气质的作品会靠近，这是纯字符串匹配做不到的。
 *
 * 打分：候选歌与每首历史歌算 cosine，再按历史权重加权平均。
 * 同时记下「最像的那一首」—— 卡片上就是写「像《XX》」的依据。
 */
import { state, cachePath, songKey } from './store.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readListens } from './listening.js';
import { readLedger } from './python.js';
import { embedTexts, cosine } from './embed.js';
import { ensureChart, chartSongs } from './chart.js';
import { joinChartIds } from './charts.js';
import { runProc, payloadOf, parseLastJson, logParseFail, msgOf } from './proc.js';
// 0.17.39：来源开关的唯一直译。只有「听歌历史」是当前来源时，这条链路才允许计算。
import { isHistoryActive } from './source.js';

const DAILY_FILE = cachePath('daily.json');
const REC_FILE = cachePath('recommend.json');

/** 每日推荐一天才换一次，但没必要每小时都去取一次 cookie，3 小时够新。 */
const DAILY_TTL_MS = 3 * 60 * 60 * 1000;
/** 第 148 节（用户口径 11-24）：「没有调整选择的歌单就留 1 小时再刷新，动了选择立即刷新」。
 * 30 分钟 → **60 分钟**。选择有没有动由 sourceSig() 比对，见 peekRecommend()。 */
export const REC_TTL_MS = 60 * 60 * 1000;

/** 第 148 节：把「用户选了什么歌单/榜」压成一个可比的字符串，存进 recommend.json 的 src。
 * 现在候选池唯一的可选项就是勾的榜（chainCharts）；以后加了新的来源开关，往这里加一段就行。*/
export function sourceSig(cfg) {
  return 'charts:' + joinChartIds(cfg && cfg.chainCharts);
}
/** 失败（读不到每日推荐 / 没向量模型）退避 20 分钟，别每次刷新都 spawn 一次子进程。 */
const FAIL_TTL_MS = 20 * 60 * 1000;
/** 画像用前 12 首就够，再多权重全摊平了，反而糊。 */
const HIST_TOP = 12;
/** 卡片上放 5 首：点歌卡一横排之后，正好够推一轮（接力会一首一首接下去）。 */
const OUT_TOP = 5;
/** 刚推过又被「换一批」的，往后排（最多记 15 首，免得候选被排空）。 */
const SKIP_FILE = state('reco-skip.json');
const SKIP_MAX = 100;
/** 点歌一次的权重（8）≈ 听了 8 分钟。 */
const PLAY_WEIGHT = 8;


const key = songKey;

let inflight = null;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 子进程取每日推荐。外壳（20 秒 / 末行 JSON / 失败留现场）在 proc.js 的 `netease.daily`。 */
async function runDaily(cdpPort) {
  const payload = payloadOf({ cdpPort: Number(cdpPort) || 9229 });
  const msg = msgOf('daily');
  const r = await runProc('daily', { payload, cdpPort });
  if (r.spawnError) return { ok: false, error: `${msg.spawn}：${r.spawnError}` };
  if (r.timedOut) return { ok: false, error: msg.timeout };
  const j = parseLastJson(r.out);
  if (!j) logParseFail('netease.daily', r);
  return j || { ok: false, error: msg.parse };
}

/** 同步读缓存的每日推荐（面板用，不能等）。 */
export function peekDaily() {
  const c = readJson(DAILY_FILE);
  if (!c) return null;
  if (Date.now() - (c.at || 0) > DAILY_TTL_MS) return null;
  return c;
}

async function ensureDaily(cfg) {
  const hit = peekDaily();
  if (hit && hit.ok) return hit;
  const r = await runDaily(cfg && cfg.cdpPort);
  // 0.0.1.6.35：取不到就用旧的那份（客户端没开时唯一还能算歌的办法）
  if (!r.ok) {
    const old = readJson(DAILY_FILE);
    if (old && old.ok && Array.isArray(old.songs) && old.songs.length) {
      return { ...old, stale: true, staleMs: Date.now() - (old.at || 0), error: String(r.error || '') };
    }
  }
  const rec = {
    at: Date.now(),
    ok: !!r.ok,
    songs: Array.isArray(r.songs) ? r.songs : [],
    error: String(r.error || ''),
  };
  try {
    writeFileSync(DAILY_FILE, JSON.stringify(rec), 'utf8');
  } catch { /* 写不了不影响本次 */ }
  return rec;
}

/**
 * 把两份记录合成一张画像表。
 * 同一首歌可能只在听歌记录里、只在点歌账本里，也可能两边都有 —— 按「歌名|歌手」合并。
 */
function buildHistory(listens, ledger) {
  const rows = new Map();
  const cell = (title, artist) => {
    const k = key(title, artist);
    let c = rows.get(k);
    if (!c) {
      c = { title: String(title || ''), artist: String(artist || ''), minutes: 0, listens: 0, count: 0 };
      rows.set(k, c);
    }
    return c;
  };
  for (const it of (listens && listens.items) || []) {
    const c = cell(it.title, it.artist);
    c.minutes += (Number(it.sec) || 0) / 60;
    c.listens += Number(it.listens) || 0;
  }
  for (const v of Object.values((ledger && ledger.songs) || {})) {
    if (!v || !v.name) continue;
    cell(v.name, v.artist).count += Number(v.count) || 0;
  }
  const out = [...rows.values()].map((c) => ({
    ...c,
    weight: c.minutes + c.listens * 2 + c.count * PLAY_WEIGHT,
  }));
  out.sort((a, b) => b.weight - a.weight);
  return out.filter((c) => c.weight > 0 && c.title);
}

/** 同步读上一次的推荐结果（面板用）。 */
export function peekRecommend(cfg) {
  const c = readJson(REC_FILE);
  if (!c || !Array.isArray(c.items) || !c.items.length) return null;
  if (Date.now() - (c.at || 0) > REC_TTL_MS) return null;
  const want = String((cfg && cfg.embedModel) || '').trim();
  if (want && c.model && c.model !== want) return null;
  // 第 148 节：选择动过 → 这一批立刻作废（不等那 1 小时）。
  // 盘上老文件没有 src（升级前的），也当场重算一次，之后就一直对得上。
  if (!c.src || c.src !== sourceSig(cfg)) return null;
  return c;
}

/**
 * 0.16.42：面板要拿「上一批推荐」当预览对象，哪怕它已经过了 30 分钟新鲜期 ——
 * 重启后第一次打开面板时，盘上那份必然是旧的，用旧的比空着三张卡好，后台会自己重算。
 */
export function peekRecommendStale() {
  const c = readJson(REC_FILE);
  if (!c || !Array.isArray(c.items) || !c.items.length) return null;
  return c;
}

/** 同步读上一次的失败记录（面板显示原因用）。 */export function peekRecommendFail(cfg) {
  const c = readJson(REC_FILE);
  if (!c || c.ok || c.items) return null;
  if (Date.now() - (c.at || 0) > FAIL_TTL_MS) return null;
  const want = String((cfg && cfg.embedModel) || '').trim();
  if (want && c.model && c.model !== want) return null;
  return { reason: String(c.reason || 'fail'), error: String(c.error || '') };
}

export function isRecommendPending() {
  return !!inflight;
}

/**
 * 0.16.60：换榜 / 换向量模型之后，把上一批推荐直接作废。
 * 不这么做用户勾了新榜还要等 30 分钟（REC_TTL_MS）才看到变化，
 * 那时候他会以为「设了没反应」—— 这种最难查。
 */
export function invalidateRecommend() {
  // 第 148 节：不再删文件 —— 删了面板上的「刷新时间」也跟着没了，用户要看那行判断新旧。
  // 把 src 抹成空串即可：peekRecommend() 一定认它不匹配，下一轮就重算，旧内容还能先垫着显示。
  const c = readJson(REC_FILE);
  if (!c) return;
  try { writeFileSync(REC_FILE, JSON.stringify({ ...c, src: '' }), 'utf8'); } catch { /* 写不了就等它自然过期 */ }
}

/**
 * 「换一批」用的小台账：上一批刚推出去的歌先让开。
 * 不这么做，同一批候选连点五次「换一批」都是一模一样的结果（打分是确定性的）。
 */
function readSkips() {
  try {
    const j = JSON.parse(readFileSync(SKIP_FILE, 'utf8'));
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * 记下「这批已经推过」的歌，下一批让开。
 *
 * 0.17.7：窗口 15 → 100，并且**去重**。
 * 15 条只够 3 批（每批 5 首），点第 4 次「换一批」时第一批就又回来了 —— 这就是
 * 「点四五次还是那几首」的原因。100 条够 20 批；去重是防止同一首被重复塞进窗口
 * 占掉名额（以前只 slice，不去重）。
 */
function pushSkips(keys) {
  const old = readSkips();
  const seen = new Set();
  const all = [];
  for (const k of [...old, ...keys]) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
    all.push(k);
  }
  try { writeFileSync(SKIP_FILE, JSON.stringify(all.slice(-SKIP_MAX)), 'utf8'); } catch { /* 写不了只影响换不换得动 */ }
}

/** 每日推荐取前多少首进候选池（用户口径：加 30 首）。 */
const DAILY_TAKE = 30;

/**
 * 0.17.9：换满 5 批之后，把候选池（后台选的那几个榜 + 每日推荐，约 300 首）打乱，
 * 重新抽 100 首出来算这一批。
 *
 * 口径（用户原话）：不要额外去歌单里抓歌，就直接从已有的那 300 首里打乱取 100 首。
 * 为什么有用：候选池固定时，分数最高的那几首每次都会浮到最前，翻几轮就只剩偏门货；
 * 打乱抽样让「池子里的第二三梯队」也有机会进场。
 *
 * 计数口径：**每一次算推荐都算一批** —— 点「换一批」算，自动重算（页面打开时缓存过期、
 * 改了设置、接力递歌后刷新）也算，因为它们在池子里消耗的都是同一份候选。
 */
const BATCH_FILE = state('reco-batch.json');
const BATCH_REFRESH = 5;
/** 满 5 批后重新抽多少首（不足就全给）。 */
const SAMPLE_TAKE = 100;

function readBatch() {
  try {
    const j = JSON.parse(readFileSync(BATCH_FILE, 'utf8'));
    return Number(j && j.n) > 0 ? Number(j.n) : 0;
  } catch {
    return 0;
  }
}

function writeBatch(n) {
  try { writeFileSync(BATCH_FILE, JSON.stringify({ n, at: Date.now() }), 'utf8'); } catch { /* 写不了只影响重抽时机 */ }
}

/** Fisher–Yates 打乱后取前 take 首（不动原数组）。 */
function shuffleTake(list, take) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, take);
}

/**
 * 当前这一轮的「100 首抽样」存盘：满 5 批时换一份，接下来的 4 批都从这份里挑，
 * 直到下一次满 5 批再重新打乱重抽 —— 这样「换一批」是在同一份 100 首里往前推，
 * 不会第 5 批抽完、第 6 批又跳回全池最高分。
 */
const POOL_FILE = state('reco-pool.json');

function readPool100() {
  try {
    const j = JSON.parse(readFileSync(POOL_FILE, 'utf8'));
    const songs = Array.isArray(j && j.songs) ? j.songs : [];
    return songs.filter((s) => s && s.name);
  } catch {
    return [];
  }
}

function writePool100(songs) {
  try {
    writeFileSync(POOL_FILE, JSON.stringify({ at: Date.now(), songs }), 'utf8');
  } catch { /* 写不了就每次退回全池 */ }
}

async function compute(cfg) {
  // 0.0.1.6.30：候选不再只有每日推荐那 50 首 —— 那个池子筛掉听过的常常只剩十来首，
  // 打分再准也没得挑。现在三处合并：热歌榜 200 + 飙升榜 100 + 每日推荐 30。
  const chart = await ensureChart(cfg).catch(() => ({ ok: false, error: '读榜单异常' }));
  const pool = chartSongs(chart);
  const daily = await ensureDaily(cfg);
  const dailySongs = (daily && daily.ok && Array.isArray(daily.songs))
    ? daily.songs.slice(0, DAILY_TAKE)
    : [];

  // 这一批是第几批（满 5 批时对候选池重新打乱抽样，见下面 base 之后那段）
  const batchNo = readBatch() + 1;
  writeBatch(batchNo);

  if (!pool.length && !dailySongs.length) {
    return {
      ok: false,
      reason: pool.length ? 'no-daily' : 'no-chart',
      error: (chart && chart.error) || (daily && daily.error) || '',
    };
  }

  const listens = await readListens();
  const ledger = await readLedger();
  const hist = buildHistory(listens, ledger);
  if (hist.length < 3) return { ok: false, reason: 'no-history' };

  const top = hist.slice(0, HIST_TOP);
  // 已经听过的版本不再推 —— 推荐要给的是没听过的
  const known = new Set(hist.map((h) => key(h.title, h.artist)));

  // 三处合并后按「歌名|歌手」+ id 去重（热歌榜和每日推荐常常撞同一首）
  const seen = new Set();
  const base = [];
  for (const s of [
    ...dailySongs.map((x) => ({ ...x, from: 'daily' })),
    ...pool,
  ]) {
    if (!s || !s.name) continue;
    const k = key(s.name, s.artist);
    const idk = s.id ? `id:${s.id}` : '';
    if (seen.has(k) || (idk && seen.has(idk)) || known.has(k)) continue;
    seen.add(k);
    if (idk) seen.add(idk);
    base.push(s);
  }
  let cands = base;
  if (!cands.length) return { ok: false, reason: 'no-candidate' };
  // 0.17.9：满 5 批 → 从这 ~300 首里打乱重抽 100 首，接下来 4 批都用这份
  let sampleInfo = null;
  const sampled = readPool100();
  if (batchNo >= BATCH_REFRESH) {
    cands = shuffleTake(base, SAMPLE_TAKE);
    writePool100(cands);
    writeBatch(0);
    sampleInfo = { batch: batchNo, pool: base.length, take: cands.length, fresh: true };
    console.log(`[推荐] 第 ${batchNo} 批：候选池 ${base.length} 首打乱后重抽 ${cands.length} 首`);
  } else if (sampled.length >= OUT_TOP) {
    // 用上一轮抽出来的那 100 首；期间新听过的版本剔掉
    cands = sampled.filter((s) => !known.has(key(s.name, s.artist)));
    sampleInfo = { batch: batchNo, pool: base.length, take: cands.length, fresh: false };
    if (cands.length < OUT_TOP) { cands = shuffleTake(base, SAMPLE_TAKE); writePool100(cands); }
  }
  // 刚推过的那批让开；候选不够 5 首就别硬排，宁可重复也不能推不出来
  const skips = new Set(readSkips());
  const unused = cands.filter((s) => !skips.has(key(s.name, s.artist)));
  if (unused.length >= OUT_TOP) cands = unused;

  const texts = [
    ...top.map((h) => `${h.title} ${h.artist}`.trim()),
    ...cands.map((s) => `${s.name} ${s.artist}`.trim()),
  ];
  let vecs;
  try {
    vecs = await embedTexts(cfg, texts);
  } catch (e) {
    return { ok: false, reason: 'no-embed', error: String((e && e.message) || e) };
  }

  const wsum = top.reduce((a, h) => a + h.weight, 0) || 1;
  const scored = cands.map((s, ci) => {
    let score = 0;
    let basis = null;
    top.forEach((h, i) => {
      const sim = cosine(vecs[i], vecs[top.length + ci]);
      score += (h.weight / wsum) * sim;
      if (!basis || sim > basis.sim) basis = { title: h.title, artist: h.artist, sim };
    });
    // 第 111 节：durMs 一路透给面板（推荐卡每首后面要显示时长）
    return {
      name: s.name,
      artist: s.artist,
      album: s.album || '',
      id: s.id || '',
      durMs: Number(s.durMs || 0) || 0,
      score,
      basis,
      from: s.from || '',
    };
  });
  scored.sort((a, b) => b.score - a.score);

  const rec = {
    at: Date.now(),
    // 0.17.6：这批候选是从哪个时刻的数据里挑的（榜单缓存 / 每日推荐缓存各自的拉取时间）。
    // 面板那句「歌单已于 X 刷新」显示的是它，不是 at —— at 会在打开页面、改勾、递歌后重算而变化。
    poolAt: Number(chart && chart.at) || 0,
    dailyAt: Number(daily && daily.at) || 0,
  // 第 148 节：这批是照哪套选择算的 —— 下次 peekRecommend() 拿它比对，选择一动就重算
  src: sourceSig(cfg),
    ok: true,
    items: scored.slice(0, OUT_TOP),
    model: String((cfg && cfg.embedModel) || ''),
    historyCount: hist.length,
    // 0.17.16：「候选池多少首」和「这一轮真正能挑多少首」分开报，面板那句才说得清
    poolSize: base.length,
    candidateCount: cands.length,
    // 候选池的来源各出了多少（面板/排查一眼看出榜单有没有拉到、勾的是哪几个榜）
    poolCounts: {
      chart: pool.length,
      daily: dailySongs.length,
      // 0.17.9：这一批有没有做「打乱重抽」、抽了多少
      sample: sampleInfo,
      ids: (chart && Array.isArray(chart.ids)) ? chart.ids : [],
      charts: (chart && Array.isArray(chart.charts) ? chart.charts : [])
        .map((c) => ({ name: String(c.name || c.id || ''), count: (c.songs || []).length })),
    },
  };
  try {
    writeFileSync(REC_FILE, JSON.stringify(rec), 'utf8');
  } catch { /* 写不了不影响本次 */ }
  // 0.16.61：「下一首播放《X》」不再在这里挂。这里是后台算推荐，拿不到「现在实际在放什么」，
  // 以前死取 items[0]，用户点了推荐第一首就永远挂着同一首。改由面板快照挂 —— 它知道在放哪首、
  // 也知道他刚点的是哪首（chain.json 的 base），能挑一首不撞名的。
  // 记下这一批，下一轮「换一批」才真的换得动
  pushSkips(rec.items.map((x) => key(x.name, x.artist)));
  return rec;
}

/** 算一次推荐。并发调用合并成一次。 */
export function generateRecommend(cfg) {
  /**
   * 0.17.39（用户口径）：设置里的来源开关选了「按天气」时，这条路**彻底停刷** ——
   * 不拉榜单、不算向量、不写 recommend.json。面板上那张卡显示「已停用」。
   * 直接返回而不是抛错：调用点全是 `.catch(()=>{})` 的后台调用，不需要异常。
   */
  if (!isHistoryActive(cfg)) return Promise.resolve({ ok: false, reason: 'inactive' });
  if (inflight) return inflight;
  inflight = compute(cfg)
    .catch((e) => ({ ok: false, reason: 'error', error: String((e && e.message) || e) }))
    .then((r) => {
      // 失败也落盘：面板下一轮就知道别急着再算一遍
      if (!r.ok) {
        try {
          writeFileSync(REC_FILE, JSON.stringify({
            at: Date.now(),
            ok: false,
            reason: r.reason || 'fail',
            error: r.error || '',
            model: String((cfg && cfg.embedModel) || ''),
          }), 'utf8');
        } catch { /* 写不了不影响 */ }
      }
      return r;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
