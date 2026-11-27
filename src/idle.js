/**
 * 「今天听点什么」的安静提议 —— 没放歌时主动开口的那一句。
 *
 * 场景（用户 0.0.1.6.8 提的）：网易云没在放、屋里安静了一阵，她自己开口问一句
 *   「现在太安静了。我想听《X》，因为……。要我帮你放吗？」
 * 先测 30 秒，后面他要改成 5 分钟 —— 所以阈值是配置项（`idleSec`），代码里不写死。
 *
 * 为什么句子是「模板 + 模型只写半句」：
 *   - 主句（想听哪首）必须由程序定。让 4B 自己挑歌，它十次有八次挑还没听过的热门歌，
 *     或者干脆编一个不存在的名字，念出来我没法点播。
 *   - 模型只负责「为什么此刻想听」那半句，20~35 字。这段即使写得平庸，整句也还立得住；
 *     写崩了（空、复读、超长）就直接不要，主句照样能说。
 *   - 结尾「要我帮你放吗？」固定 —— 用户要的就是这句邀请，不能被模型改写成别的问法。
 *
 * 提议要落盘（`data/idle.json`）：
 *   播报是我们自己出声的，宿主的 AI 听不见。用户回一句「放吧」时，AI 得知道
 *   「她刚才说的是哪首」—— 靠 `netease_quiet` 工具读这个文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { state, readJson, writeJson } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatAny, hasModel, modelLabel } from './ollama.js';
import { peekRecommend } from './recommend.js';
// 0.17.40（用户口径「随现在选择的卡片执行」）：安静时想听哪首，也跟来源开关走。
import { peekWxReco, peekNextWx } from './wxreco.js';
import { isWeatherActive } from './source.js';
import { readListens } from './listening.js';
// 0.16.86（第 132 节 A4）：歌名比对统一走接力那套 sameKey（归一化 + 允许包含），
// 不再自己用 toLowerCase 精确比 —— 播放条会把歌手拼进标题，精确比一定漏。
import { sameKey } from './chain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = state('idle.json');

/** 提议的有效期。两小时后还挂着「她刚才想听这首」，用户会以为坏了。 */
const HOLD_MS = 2 * 60 * 60 * 1000;
/** 确认条能挂多久：他离开电脑去吃饭、隔几个小时回来点也算数（一晚上不回来就算了）。 */
const ASK_HOLD_MS = 8 * 60 * 60 * 1000;
/** 补句的字数上下界（出口硬收）。 */
const MIN_FLAVOR = 12;
const MAX_FLAVOR = 34;
/**
 * 挑歌看推荐**前几首**里随机一首：老是同一首会显得像固定播报。
 * 第 125 节（用户口径：「从这 5 首里面随机选一个」）：3 → 5。
 * 原来只在前三晃，推荐池的第 4、5 首永远轮不到，他听到的就老是那几首。
 */
const PICK_TOP = 5;

/**
 * 0.17.61（用户口径）：开机后的「加载期」不发安静提示。
 *
 * 理由（用户原话）：开机要加载模型、算向量，1 分钟根本做不完 —— 这个点弹出来，
 * 歌是旧的、句子模型也还没热，问也白问。默认给 5 分钟，可配（0 = 不拦）。
 *
 * 按**整机开机时长**算（os.uptime），不是插件进程 —— 用户说的是「刚启动电脑」。
 */
export function bootedRecently(minutes) {
  const m = Number(minutes);
  if (!(m > 0)) return false;
  try {
    return uptime() < m * 60;
  } catch {
    return false; // 拿不到开机时长就不拦，别因为读不到系统信息把功能整个哑掉
  }
}

/** 0.16.86（第 132 节 A4）：退回「最近听过的」时，最近这么多首整体排除（刚放完的就在最前）。 */
const RECENT_SKIP = 10;

let cache = null;

function readCache() {
  // 0.16.99：读写都走 store；内存里那份仍在，命中就不碰盘
  if (!cache) cache = readJson(FILE, {});
  return cache;
}

function writeCache(obj) {
  cache = obj;
  writeJson(FILE, obj);
}

/**
 * 丢掉内存里那份，下一读重新从盘上取。
 * 生产里用不到（读写都经过 saveIdle/markIdle*）；自测脚本要先改盘再读，才需要它。
 */
export function reloadIdle() {
  cache = null;
}

/** 最近一次提议（两小时内）。没有返回 null。 */
export function peekIdle() {
  const c = readCache();
  if (!c || !c.at || !c.spoken) return null;
  if (Date.now() - Number(c.at) > HOLD_MS) return null;
  return c;
}

/** 存一条提议。`pick` 里带 id 的话，AI 拿它点歌能精确到那一版。 */
export function saveIdle(rec) {
  writeCache({
    at: Date.now(),
    spoken: String(rec.spoken || ''),
    flavor: String(rec.flavor || ''),
    pick: rec.pick || null,
    idleSec: Number(rec.idleSec) || 0,
    model: String(rec.model || ''),
    // 用户 0.0.1.6.13：确认条不超时。他没点，说明人不在电脑前 —— 就一直挂着等，
    // 不能替他默认「否」。所以「问过没有」只由这个字段说了算，跟时间无关。
    answeredAt: 0,
  });
}

/**
 * 他按了「是」或「不用了」—— 这一次开口的确认条就收起来。
 * 记 `answeredAt` 而不是删掉提议：AI 之后还得能查到「她当时说的是哪首」。
 */
export function markIdleAnswered() {
  const c = readCache();
  if (!c || !c.at) return null;
  c.answeredAt = Date.now();
  writeCache(c);
  return c;
}

/**
 * 0.17.65（用户口径）：记下他**点「放《X》」这个动作**的时刻。
 *
 * 为什么要单独记（0.17.64 之前的毛病）：接受判定原来是「她开口 → 现在 ≤ 30 秒」，
 * 可他常常过十来分钟才回头点那一项 —— 一超 30 秒就判成 user-ask，接力被掐。
 * 用户口径：「等待很久之后才点的放」也要算，锚点改成**点放那一刻**。
 *
 * `at` 用宿主事件的时间戳（比我们扫到它的时刻准 1~2 秒）。`name` 是选项里那首歌。
 */
export function markIdlePlayClick({ at = 0, name = '' } = {}) {
  const c = readCache();
  if (!c || !c.at) return null;
  const when = Number(at) || Date.now();
  // 只认「这一次」的点击：早于她开口的、或者比上次记的更早的，都不覆盖
  if (when < Number(c.at)) return c;
  c.clickAt = when;
  c.clickName = String(name || '').slice(0, 80);
  writeCache(c);
  return c;
}

/**
 * 0.17.60/0.17.65：这一次「安静提示」刚推过去的歌是什么 —— 只认「还没作答」的那条。
 *
 * 用途：宿主 AI 收到气泡回答后用 `netease_play` 放歌时，靠它判断
 * 「这是不是她刚才提议的那首」。是 → 按 her-offer 处理（接力接得上、歌单走推荐歌单）；
 * 不是 → 仍按用户点歌（user-ask，不接）。
 *
 * 两个窗口，满足一个就算「刚问的」：
 *   - `now - clickAt ≤ withinMs`：他点了「放《X》」，从**点击**起算（0.17.65 主路径，晚点也算）
 *   - `now - at ≤ withinMs`：没拿到点击（AI 自主调工具）时退回原口径
 * `answeredAt` 非 0 说明这次提议已经被回应过（面板确认条/「等一会」），不再认领。
 */
export function recentIdleOffer(withinMs = 30_000, now = Date.now()) {
  const c = readCache();
  if (!c || !c.at || !c.spoken) return null;
  if (!c.pick || !String(c.pick.name || '').trim()) return null;
  if (Number(c.answeredAt || 0)) return null;
  // 提议本身也不能放到天荒地老（点击只是锚点，不是免死金牌）
  const age = now - Number(c.at);
  if (!(age >= 0 && age <= ASK_HOLD_MS)) return null;
  const clickAt = Number(c.clickAt || 0);
  const sinceClick = clickAt ? now - clickAt : Infinity;
  const byClick = clickAt > 0 && clickAt >= Number(c.at) && sinceClick >= 0 && sinceClick <= Number(withinMs);
  const byAsk = age >= 0 && age <= Number(withinMs);
  if (!byClick && !byAsk) return null;
  return {
    pick: { name: String(c.pick.name), artist: String(c.pick.artist || ''), id: String(c.pick.id || '') },
    at: Number(c.at),
    ageMs: age,
    clickAt,
    clickName: String(c.clickName || ''),
    via: byClick ? 'click' : 'ask',
    sinceMs: byClick ? sinceClick : age,
    spoken: String(c.spoken || ''),
  };
}

/**
 * 上一次「跟她有过一次互动」的时刻 —— 开口时刻和作答时刻里更晚的那个。
 *
 * 为什么要落盘（0.0.1.6.29）：
 * 采样器里的 `idleAskedAt` 是进程内变量，重启就清零。用户每按一次重启键，
 * 安静满 1 分钟就立刻又开口一次 —— 宿主那边的 AI 于是看到「一两分钟一条」，
 * 认定这个事件很吵，从此习惯性跳过（它连笔记都写了）。
 * 冷却是配置项，就得跟着配置活过重启。
 */
export function lastAskAnchor() {
  const c = readCache();
  if (!c) return 0;
  return Math.max(Number(c.at || 0), Number(c.answeredAt || 0));
}

/** 这一次开口还在等他回应（没答过、且在有效期内）。 */
export function isIdleAsking() {
  const c = readCache();
  if (!c || !c.at || !c.spoken) return null;
  if (Number(c.answeredAt || 0)) return null;
  if (Date.now() - Number(c.at) > ASK_HOLD_MS) return null;
  return c;
}

/**
 * 挑一首「她此刻想听」的。
 * 优先推荐卡（向量算过、跟她的听歌史最近），挑不到就退回「最近实际听过的那几首」。
 * 都挑不到返回 null —— 那就只说「我想听点什么」，不硬编一个歌名。
 *
 * `exclude`：接力点歌时要把「正在放的」和「刚递过去的」排除掉，免得递回来同一首。
 */
export async function pickIdleSong(cfg, { exclude = [] } = {}) {
  // 0.16.86（第 132 节 A4）：以前拿 toLowerCase 精确比，播放条常把歌手拼进标题
  //（「好想好想古巨基」）→ 精确比漏掉，同一首又挑回来。统一走 sameKey（允许包含）。
  const skip = exclude.map((x) => String(x || '').trim()).filter(Boolean);
  const isSkip = (name) => skip.some((s) => sameKey(s, name));
  const take = (pool) => {
    const rest = pool.filter((x) => x && x.name && !isSkip(x.name));
    if (!rest.length) return null;
    const sub = rest.slice(0, Math.min(PICK_TOP, rest.length));
    const it = sub[Math.floor(Math.random() * sub.length)];
    return { name: String(it.name), artist: String(it.artist || ''), id: String(it.id || '') };
  };

  /* 0.17.40：来源是「按天气」时，先挑**下一句会配的那首**（0.1.19 起列表里是"已投过的"，
     再用它就是又推一遍刚放的那首）。算不出来才退回本轮已投名单，再退回听歌历史 ——
     不能让安静提议因为天气没算完就哑掉。 */
  if (isWeatherActive(cfg)) {
    let nx = null;
    try { nx = await peekNextWx(cfg, { exclude: skip }); } catch { nx = null; }
    if (nx && nx.name && !isSkip(nx.name)) return { name: nx.name, artist: nx.artist || '', id: nx.id || '' };
    const w = peekWxReco(cfg, { kick: false });
    const wxItems = (w && w.ok && Array.isArray(w.items)) ? w.items.filter((x) => x && x.name) : [];
    const fromWx = take(wxItems);
    if (fromWx) return fromWx;
  }

  const rec = peekRecommend(cfg);
  const items = (rec && Array.isArray(rec.items)) ? rec.items.filter((x) => x && x.name) : [];
  const fromRec = take(items);
  if (fromRec) return fromRec;

  let listens = null;
  try {
    listens = await readListens();
  } catch {
    listens = null;
  }
  const rows = ((listens && listens.items) || [])
    .filter((x) => x && x.title && x.lastAt)
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    .map((x) => ({ name: x.title, artist: x.artist, id: '' }));
  // 回退路按时间倒序，刚放完的那首永远排第一 —— 直接挑就是「重复放同一首」。
  // 这里把最近 RECENT_SKIP 首整体排除；真被排空就返回 null（只说「我想听点什么」，不硬凑）。
  for (const r of rows.slice(0, RECENT_SKIP)) skip.push(r.name);
  return take(rows);
}

/** 把模型输出收成一句能念的话：去引号、单行、收字数、去尾部停顿。 */
function cleanFlavor(raw, pickName) {
  let t = String(raw || '').trim();
  t = t.replace(/^[\s"'“”「」『』]+/, '').replace(/[\s"'“”「」『』]+$/, '');
  t = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
  // 模型会把「我想听」又写一遍（主句里已经有了），剥掉，免得一句里说两遍
  t = t.replace(/^我?想听[^，。！？]{0,10}[，,。]?\s*/, '');
  // 又点了一次歌名 —— 换成「它」，主句已经说过是哪首了
  if (pickName) {
    t = t.replace(new RegExp(`《${pickName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}》`, 'g'), '它');
    t = t.replace(new RegExp(pickName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '它');
  }
  t = t.replace(/\s*\n+\s*/g, ' ');
  // 中间的引号也去掉：TTS 不念引号，但面板上显示「她说“别怕”」会多一层括号感
  t = t.replace(/["“”「」『』]/g, '');
  if (t.length > MAX_FLAVOR) {
    const cut = t.match(/^.{8,34}?[，。！？、；,.!?;]/);
    t = cut ? cut[0] : t.slice(0, MAX_FLAVOR);
  }
  t = t.replace(/[，、；：,。.!！？?]+$/g, '');
  return t;
}

/**
 * 让模型写「为什么此刻想听」那半句。没有模型、失败、太短 → 返回空串（不阻塞播报）。
 * 刻意不给例句：给过一次，本机 4B 就原样复读（这事已经踩过两回）。
 */
async function writeFlavor({ cfg, pick, persona }) {
  if (!hasModel(cfg)) return '';
  const who = persona ? `${persona}\n\n` : '';
  const target = pick
    ? `《${pick.name}》${pick.artist ? `（${pick.artist}）` : ''}`
    : '随便什么歌';
  const sys = `${who}你现在没在放歌，屋里安静了一阵，你打算一会儿听${target}。`
    + '用一句话说说此刻为什么想听这个：你想起什么、现在是什么状态、想听到什么。'
    + `只输出这一句，${MIN_FLAVOR}到${MAX_FLAVOR}个字，不加引号，不要问句，`
    + '不要说「推荐」这类字眼，不要提歌名，用「它」或「这个」指代。'
    // 4B 一松就写「抚平疲惫」「治愈」「温柔的回声」这一类空词，三句里有两句同一个模子。
    // 不用例句去纠正（给例句它会原样复读），只把这些词点出来让它绕开。
    + '不要用「治愈」「抚平」「温柔」「拥抱」这几个词，具体一点，说人话。'
    // 开头也别一律「它像……」—— 实测连跑三句全是一个句型，念出来像复读。
    + '不要用「它像」开头。';
  const user = pick
    ? `歌：${target}\n（就这一首，不要换成别的歌）`
    : '（没有具体目标，就说你此刻想听什么样的歌）';
  try {
    const raw = await chatAny(cfg, [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.8, numPredict: 60, timeoutMs: 20000 });
    const t = cleanFlavor(raw, pick && pick.name);
    if (!t) return '';
    if (t.length < MIN_FLAVOR) return '';
    return t;
  } catch {
    return '';
  }
}

/**
 * 组一句完整的话。
 *
 * 句式（三段，缺一段也能活）：
 *   <开场>。<我想听《X》| 想放《X》听听>[, 为什么]。要我帮你放吗？
 *
 * 0.16.86（第 132 节 A3）：以前整句一字不差地重复（首次 5 分钟、之后每 60 分钟一次），
 * 听着像卡带。现在开场和主句各给几种说法、避开上一句用过的词；
 * **结尾那句问法仍然固定** —— 宿主 AI 靠它对接「放吧 / 好啊」，换了问法它就对不上了。
 */
const OPENERS = [
  '现在太安静了。',
  '安静了一阵。',
  '屋里没什么声音。',
  '这会儿静下来了。',
  '好一会儿没动静了。',
];

const mainsFor = (name) => [
  `我想听《${name}》`,
  `有点想听《${name}》`,
  `想放《${name}》听听`,
  `这会儿想听《${name}》`,
];

/** 从几种说法里挑一句，尽量避开上一句已经用过的（`prev` 里含这句就不选它）。 */
function pickOne(list, prev) {
  const rest = list.filter((x) => !String(prev || '').includes(x));
  const pool = rest.length ? rest : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 0.17.62（用户口径）：第一次开口的等待秒数。
 *
 * 选了「按天气听点什么」以后，最少 5 分钟 —— 天气名单、向量都还没算完，早问就是拿旧名单凑；
 * 填了 1~4 一律按 5 算（设置页也会把它顶到 5）。其他来源仍按用户填的分钟数走。
 * 关掉「她自己开口」时返回 0（采样器据此当停用）。
 */
export function firstAskSec(cfg) {
  const c = cfg || {};
  if (c.selfPick === false || c.idleSay === false) return 0;
  const raw = Number(c.idleFirstMin);
  let min = Number.isFinite(raw) && raw > 0 ? raw : 5;
  if (isWeatherActive(c) && min < 5) min = 5;
  return min * 60;
}

/* 0.17.64（用户口径）：安静时间到的这一刻，**直接拿当前天气数据现写句子**，不读旧缓存 ——
   一次调用出两样东西：
     line  —— 她开口前半句（≤26 字，念出来的那句）
     brief —— 给宿主 AI 的事实（20~60 字，不然它会只看到「雾，4.3 度…」这种数据串）
   以前按天气串缓存、只写 brief；现在每次开口都按眼前的实况重写。 */
const BRIEF_MIN = 20;
const BRIEF_MAX = 60;

function trimLine(s, max = 26) {
  let t = String(s || '').replace(/[\r\n]+/g, ' ').replace(/[～~]/g, '').trim();
  t = t.replace(/^["“「『]+|["”」』]+$/g, '').replace(/\s+/g, ' ').trim();
  if ([...t].length > max) {
    const cut = Math.max(t.lastIndexOf('。'), t.lastIndexOf('，'), t.lastIndexOf('！'), t.lastIndexOf('？'));
    t = cut > 8 ? t.slice(0, cut + 1) : [...t].slice(0, max - 2).join('');
  }
  return t;
}

async function writeWxWords({ cfg, persona, probe }) {
  const out = { line: '', brief: '' };
  if (!probe || !hasModel(cfg)) return out;
  const who = persona ? `${persona}\n\n` : '';
  const sys = `${who}下面给你一条此刻的天气实况。按眼前的实况写两样东西，只输出 JSON：`
    + `{"line":"…","brief":"…"}。`
    + 'line 是你开口说的前半句：不超过 26 字，写你看到的画面或感觉，口语，不提歌、不追问句。'
    + `brief 是给旁边助手的事实：${BRIEF_MIN}~${BRIEF_MAX} 字，你自己的一句话，说明此刻外面到底什么样。`
    + '两个都不抄数字、不要「多穿点/注意保暖」这类套话、不要「据观测」这种播报腔。';
  try {
    const raw = await chatAny(cfg, [
      { role: 'system', content: sys },
      { role: 'user', content: probe },
    ], { temperature: 0.8, numPredict: 160, timeoutMs: 20000 });
    const s = String(raw || '').trim();
    let j = null;
    try { j = JSON.parse(s); } catch {
      try { j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { j = null; }
    }
    if (j && typeof j === 'object') {
      out.line = trimLine(j.line || '');
      let b = trimLine(j.brief || '', 120);
      /* 实测 4B 会偷懒把「气温低至 4.3 度」抄进来 —— 按分句剔掉带数字的那一小句，
         剩下的还够 20 字就用；不够就宁可不要（调用方退回天气串）。 */
      if (/[0-9]/.test(b)) {
        b = b.split(/(?<=[，。；、])/).filter((x) => !/[0-9]/.test(x)).join('').replace(/[，、；]\s*$/, '。').trim();
      }
      const bl = [...b].length;
      if (bl >= BRIEF_MIN && bl <= BRIEF_MAX) out.brief = b;
    }
    return out;
  } catch {
    return out;
  }
}

export async function buildIdle({ cfg, persona, idleSec } = {}) {
  const c = cfg || {};
  const pick = await pickIdleSong(c);

  /* 0.17.61（用户口径）：来源是天气时，这句改成
       「<此刻天气那句>。突然想到一首歌《X》。要我帮你放吗？」
     天气在前、歌在后；不要「我想听《X》」那套开场，也不用模型再写「为什么想听」
     —— 少一次模型调用，开机/刚热起来的机器也能立刻说出口。 */
  if (isWeatherActive(c)) {
    let snap = null;
    try { snap = peekWxReco(c, { kick: false }); } catch { snap = null; }
    const snapLine = String((snap && snap.ok && snap.line) || '').trim();
    const probe = String((snap && snap.weather) || '').trim();
    /* 0.17.64（用户口径）：这一刻直接拿当前天气数据现写句子，不读旧缓存。
       模型写不出（没模型/超时/JSON 崩）才退回天气卡那句 —— 但那样就没有 AI 版事实了。 */
    const words = await writeWxWords({ cfg: c, persona, probe });
    const wxLine = words.line || snapLine;
    if (wxLine) {
      const head = /[。！？!?]$/.test(wxLine) ? wxLine : `${wxLine}。`;
      const spoken = pick
        ? `${head}突然想到一首歌《${pick.name}》。要我帮你放吗？`
        : `${head}突然想到一首歌，一下想不起名字了。要我帮你放一首吗？`;
      return {
        ok: true,
        pick,
        flavor: wxLine,
        flavorFrom: 'wx',
        weather: probe,
        brief: words.brief || probe,
        spoken,
        model: modelLabel(c),
        idleSec: Number(idleSec) || 0,
      };
    }
  }

  const flavorText = await writeFlavor({ cfg: c, pick, persona });
  const prevSpoken = String((peekIdle() || {}).spoken || '');
  const opener = pickOne(OPENERS, prevSpoken);
  const main = pick ? pickOne(mainsFor(pick.name), prevSpoken) : '我想听点什么';
  const spoken = `${opener}${main}${flavorText ? `，${flavorText}` : ''}。要我帮你放吗？`;
  return {
    ok: true,
    pick,
    flavor: flavorText,
    flavorFrom: flavorText ? 'model' : '',
    spoken,
    model: modelLabel(c),
    idleSec: Number(idleSec) || 0,
  };
}

/** 给 `netease_quiet` 工具用的纯文本说明。 */
export function describeIdle() {
  const c = peekIdle();
  if (!c) return '';
  const mins = Math.max(0, Math.round((Date.now() - Number(c.at)) / 60000));
  const when = mins <= 0 ? '刚刚' : `${mins} 分钟前`;
  const pick = c.pick && c.pick.name
    ? `《${c.pick.name}》${c.pick.artist ? `（${c.pick.artist}）` : ''}`
    : '（她当时没点名具体哪首）';
  return `她${when}在没放歌的时候主动开过口，说想听${pick}。原话：「${c.spoken}」`;
}

export const PATHS = { FILE };
