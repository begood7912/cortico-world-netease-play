/**
 * 卡②「她听完什么感觉」—— 引一句正在唱过的歌词，再从这句说开去。
 *
 * 取句的两条规矩：
 *   1. **一定是已经唱过的**。之前让模型自己挑，它会挑副歌第一句（那时还没唱到），甚至改字；
 *      现在锚点由 LRC 时间轴定，模型只写感觉，引用百分百是真的。
 *   2. **不固定在某一句**。0.6.1 把锚点钉死在第 60 秒，结果是同一首歌每次听到的都是同一句，
 *      太像背书。现在锚点在「已经唱过的那一段」（15~58 秒）里随机取，一次生成 2 条不同句子的
 *      感觉存进池子里；同一首歌再听一遍时从池子里换一条 —— 每次落下来的句子都不一样。
 *
 * 输出结构：
 *   line    —— 程序从 LRC 取的、正在唱的那一句（可能由两句短句拼成）
 *   feel    —— 她的感受，30~60 字
 *   verdict —— 喜欢/一般/不喜欢，只作内部记录（面板不显示）
 *
 * 为什么要有性格：同样一句歌词，不同的人会得出不同结论。prompt 里不提她是谁，
 * 模型只会给一句「很有感触」的废话；把 personaNote 放进去，感受才有立场。
 * personaNote 从宿主 config.json 的 worlds."self-awareness".personaNote 读，不写死。
 *
 * 缓存 12 小时；失败负缓存 1 小时（纯音乐没歌词，不缓存会每 3 秒重跑一次取歌词脚本）。
 * 缓存带版本号 ver=4，旧版（ver=3 的固定 60 秒、更早的 verdict+reason）一律当没有。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { cachePath, songKey, readJson, writeJson } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatAny, hasModel, modelLabel, modelMode } from './ollama.js';
import { readLyric } from './lyric.js';
import { feelParts } from './prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = cachePath('her-like.json');
const TTL_MS = 12 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;

/**
 * 锚点随机区间。下限 15 秒：太靠前的几句常常是前奏刚过、一句半句，听着没头没尾。
 * 上限 58 秒：卡② 是听满 60 秒才念，锚点必须落在「已经唱过去」的范围里，
 * 否则会出现「念的是一句还没唱到的歌词」——那正是最早让模型自选时踩到的坑。
 */
const ANCHOR_MIN = 15;
const ANCHOR_MAX = 58;

/** 她的感受：用户要「说一段话」，太短是一句评语，太长 60 秒这句念不完。 */
const MIN_FEEL = 30;
const MAX_FEEL = 60;

/** 一个批次生成几条不同的句子（池子越大，重听时越不容易撞回同一句）。 */
const PICKS_PER_RUN = 2;
/** 池子上限，超了丢最旧的。 */
const MAX_PICKS = 6;

/**
 * 缓存格式版本。
 * 5 = 短句要接成 2~3 行（0.0.1.6.7）。旧缓存里的 line 可能是四字碎片（「所行无碍」），
 * 不认，让它按新规矩重算。
 */
const VER = 5;

let cache = null;
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

/** 缓存里这一条是否还能用（版本、时间、模型都对得上）。 */
function usable(c, cfg) {
  if (!c || c.ver !== VER) return null;
  if (Date.now() - (c.at || 0) > TTL_MS) return null;
  if (cfg) {
    const want = modelLabel(cfg);
    const got = String(c.model || '');
    if (want && got && got !== want) return null;
  }
  const picks = Array.isArray(c.picks) ? c.picks : [];
  if (!picks.length) return null;
  const idx = Number.isInteger(c.cur) && c.cur >= 0 && c.cur < picks.length ? c.cur : 0;
  const p = picks[idx];
  if (!p || !p.feel) return null;
  return { ...p, at: c.at || 0, model: String(c.model || ''), persona: !!p.persona };
}

/** 同步读「这一次要念的那一条」。没有（或过期、或旧格式）返回 null。 */
export function peekLike(title, artist, cfg, gen = null) {
  const k = key(title, artist);
  const c = readCache()[k];
  const good = usable(c, cfg);
  if (!good) return null;
  // 0.17.54：换歌/重播 = 新的一遍 → 上一遍抽中的那条作废
  if (gen != null && Number(c.gen) !== Number(gen)) return null;
  return good;
}

/**
 * 换一首歌（或同一首又重新开始听）时调用：从池子里换一条出来。
 *
 * 为什么要换而不是一直用池子里的第一条 —— 用户说的是「每次听它那个歌词取的还是要取随机一点」。
 * 生成是贵的（一次要跑模型），所以一条歌的多次结果都留在池子里，
 * 重听时只做「抽签」，不再花一次模型调用；抽不到（池子空或只有一条）就交给 generateLike。
 *
 * 返回换上的那条，或 null。
 */
export function rotateLike(title, artist, cfg, gen = null) {
  const k = key(title, artist);
  const c = readCache()[k];
  if (!c) return null;
  // 0.17.54：新的一遍 —— 先强制换一条和上一遍不同的；池子不足两条就返回 null，
  // 让调用方走 generateLike 补新句（同一首歌重放也要换内容）。
  if (gen != null && Number(c.gen) !== Number(gen)) {
    c.gen = Number(gen);
    if (Array.isArray(c.picks) && c.picks.length >= 2) {
      c.cur = (Number.isInteger(c.cur) ? c.cur + 1 : 0) % c.picks.length;
      writeCache(readCache());
      return usable(c, cfg);
    }
    writeCache(readCache());
    return null;
  }
  const good = usable(c, cfg);
  if (!good) return null;
  const picks = c.picks;
  if (picks.length < 2) return good;
  // 抽一条和当前不同的：同一首连着听两遍，句子必须换，否则「随机」等于没做。
  let idx = c.cur;
  for (let i = 0; i < 8 && idx === c.cur; i += 1) idx = Math.floor(Math.random() * picks.length);
  if (idx === c.cur) idx = (c.cur + 1) % picks.length;
  c.cur = idx;
  writeCache(readCache());
  return usable(c, cfg);
}

/** 同步读失败记录。返回 reason 字符串或 null。 */
export function peekLikeFail(title, artist) {
  const c = readCache()[key(title, artist)];
  if (!c || c.ver !== VER) return null;
  if (Array.isArray(c.picks) && c.picks.length) return null;
  if (Date.now() - (c.at || 0) > FAIL_TTL_MS) return null;
  return String(c.reason || 'fail');
}

/** 判断失败时的原始错误文本（云端 401 这类要能看见）。 */
export function peekLikeFailError(title, artist) {
  const c = readCache()[key(title, artist)];
  if (!c || c.ver !== VER) return '';
  if (Array.isArray(c.picks) && c.picks.length) return '';
  if (Date.now() - (c.at || 0) > FAIL_TTL_MS) return '';
  return String(c.error || '');
}

export function isLikePending(title, artist) {
  return inflight.has(key(title, artist));
}

/**
 * 从宿主配置里读她的人设。WorldContext 给的是 botDir（Bot 的 home 目录），
 * config.json 就在那一层 —— 但不同版本给的可能是 home 或 home\data，所以往上逐层找。
 * 读不到就返回空串，prompt 退回「不提性格」的版本。
 */
export function readPersonaNote(botDir) {
  if (!botDir) return '';
  let dir = String(botDir);
  for (let i = 0; i < 5; i += 1) {
    const p = join(dir, 'config.json');
    try {
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const note = String((j && j.worlds && j.worlds['self-awareness'] && j.worlds['self-awareness'].personaNote) || '').trim();
        if (note) return note;
      }
    } catch { /* 这个候选不行，往上再试 */ }
    const up = dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return '';
}

/** 歌词接行（用户 0.0.1.6.7 定的口径：少于十个字就往后接，最多接成三行）。 */
const MERGE_TARGET = 10;   // 少于这么多字，单拎出来太碎（「所行无碍」四个字念出来没内容）
const MERGE_LINES = 3;     // 最多接三行 —— 再多就成念歌词了
const MERGE_GAP = 20;      // 相邻两行的间隔上限（秒）。歌词稀疏的歌一行要等十几秒，8 秒太严
const MERGE_LEN = 32;      // 接完的原文上限，再长一口气念不完

/** 只数字，不算标点空格 —— 「所行，无碍」和「所行无碍」都是四个字。 */
const bareLen = (s) => String(s || '').replace(/[\s，,。！？、；：.!?;:'"“”‘’]/g, '').length;

/**
 * 取「播到第 sec 秒时正在唱的那一句」。
 *
 * 有 LRC：找 t <= sec 的最后一条（留 1 秒余量，刚换行的那句也算）；
 * 整首还没唱到 sec（短歌）就取最后一句。
 * 没时间轴（老缓存或接口只给纯文本）：取中段偏前的一句，
 * 至少仍是真歌词，只是未必正好对上那一刻。
 *
 * 一句太短（<10 字）就跟下一句接上（最多接三行）—— 之前门槛是 8 秒间隔、26 字上限，
 * 结果《永夜》那种一行隔 10 秒以上的歌根本接不上，面板上就剩「所行无碍」四个字。
 */
export function lineAtSec(ly, sec = ANCHOR_MAX) {
  const timed = Array.isArray(ly && ly.timed) ? ly.timed : [];
  if (timed.length) {
    let idx = -1;
    for (let i = 0; i < timed.length; i += 1) {
      if (timed[i].t <= sec + 1) idx = i;
      else break;
    }
    if (idx < 0) idx = 0;
    let pick = timed[idx].text;
    let j = idx + 1;
    let rows = 1;
    // 先往后接
    while (
      rows < MERGE_LINES
      && bareLen(pick) < MERGE_TARGET
      && j < timed.length
      && timed[j].t - timed[j - 1].t <= MERGE_GAP
      && `${pick} ${timed[j].text}`.length <= MERGE_LEN
    ) {
      pick = `${pick} ${timed[j].text}`;
      j += 1;
      rows += 1;
    }
    // 已经唱到最后一句、后面没词了：往前接。
    // 《永夜》最后那行就是「所行无碍」四个字，只往后接永远接不上 —— 用户在面板上看到的就是它。
    let k = idx - 1;
    while (
      rows < MERGE_LINES
      && bareLen(pick) < MERGE_TARGET
      && k >= 0
      && timed[k + 1].t - timed[k].t <= MERGE_GAP
      && `${timed[k].text} ${pick}`.length <= MERGE_LEN
    ) {
      pick = `${timed[k].text} ${pick}`;
      k -= 1;
      rows += 1;
    }
    return String(pick).trim();
  }
  const lines = String((ly && ly.text) || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return '';
  const i = Math.min(lines.length - 1, Math.floor(lines.length / 3));
  return lines[i];
}

/**
 * 随机挑 n 个锚点，落在 15~58 秒（都已经唱过）。
 *
 * 注意这里挑的是**歌词行**、不是「随机一个秒数再回查」：
 * 试过先随机秒数，可一首歌一句能唱五六秒，随机 6 次有 4 次落在同一句里 ——
 * 「随机」等于没随机。按行挑，每句被抽到的机会才一样。
 *
 * 没有时间轴就返回 [null]，调用方退回 lineAtSec 的估算。
 * 短歌候选不够（整首不到 58 秒）时把上限放开，别返回空。
 */
function pickAnchors(ly, n) {
  const timed = Array.isArray(ly && ly.timed) ? ly.timed : [];
  if (!timed.length) return [null];

  let pool = timed.filter((x) => x.t >= ANCHOR_MIN && x.t <= ANCHOR_MAX);
  // 歌词稀疏的歌（《永夜》整首只有 28 行、15~58 秒里才 6 行）池子太小，
  // 随机出来老是那几句 —— 候选不足时把下界放宽，宁可引用一句靠前一点的。
  if (pool.length < 8) pool = timed.filter((x) => x.t >= 5 && x.t <= ANCHOR_MAX);
  if (pool.length < n) pool = timed.filter((x) => x.t <= ANCHOR_MAX);
  if (pool.length < n) pool = timed.slice();
  if (!pool.length) return [null];

  // 洗牌取前 n 个（Fisher-Yates 的部分实现），返回这些行的秒数
  const copy = pool.slice();
  const out = [];
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i += 1) {
    const r = Math.floor(Math.random() * (copy.length - i)) + i;
    const tmp = copy[i];
    copy[i] = copy[r];
    copy[r] = tmp;
    out.push(copy[i].t);
  }
  return out;
}

/** 三档态度只作内部记录，面板不显示。 */
function parseAttitude(raw) {
  const m = String(raw || '').match(/(?:态度| verdict)[：:]\s*(不喜欢|一般|喜欢)/);
  if (m) return m[1] === '喜欢' ? 'like' : m[1] === '一般' ? 'meh' : 'dislike';
  const s = String(raw || '');
  if (/不喜欢|讨厌|想切/.test(s)) return 'dislike';
  if (/^一般|还行|说不上/m.test(s)) return 'meh';
  if (/喜欢|爱听|好听/.test(s)) return 'like';
  return 'meh';
}

/** 把「感觉：…」剥干净，并把开头重复的「从这句/我感觉」这类前缀去掉。 */
function cleanFeel(s) {
  let t = String(s || '').trim();
  t = t.replace(/^(感觉|感受|我的感觉)[：:]\s*/, '');
  t = t.replace(/^[「『""][^」』""]*[」』""]\s*[，,]\s*/, '');  // 开头又复述了一遍歌词
  t = t.replace(/^从?这句(歌词)?(来说|来讲|看|说起)?[，,、：:]?\s*/, '');
  t = t.replace(/^我?感觉[，,：:]?\s*/, '');
  t = t.replace(/^[，,、：:\s]+/, '');
  t = t.replace(/["'""'']+/g, '');
  t = t.replace(/\s*\n+\s*/g, ' ');
  return t.trim();
}

/**
 * 拆模型的两行输出。
 * 模型有时会写成「感觉：…」一行就完，也可能先复述一遍歌词 —— 都要容得下。
 */
function parseFeel(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  let feel = '';
  for (const L of lines) {
    if (/^(喜欢|一般|不喜欢|态度[：:])/.test(L)) continue;
    const m = L.match(/^(?:感觉|感受|想法)[：:]\s*(.+)$/);
    if (m) feel = feel ? `${feel} ${m[1]}` : m[1];
    else if (!feel) feel = L;
    else feel = `${feel} ${L}`;
  }
  feel = cleanFeel(feel);
  if (feel.length > MAX_FEEL) {
    const cut = feel.match(/^.{20,65}?[。！？.!?]/);
    feel = cut ? cut[0] : `${feel.slice(0, MAX_FEEL - 1)}…`;
  }
  return { feel, verdict: parseAttitude(String(raw || '')) };
}

/** 生成一条：锚点秒数由调用方给（sec），没给就用 lineAtSec 的默认位置。 */
async function run({ title, artist, cdpPort, persona, cfg, sec, retryHint }) {
  const ly = await readLyric({ title, artist, cdpPort, wantTimed: true });
  if (!ly || !ly.ok || !ly.text) {
    return { ok: false, reason: 'no-lyric', error: (ly && ly.error) || '' };
  }
  const at = sec == null ? ANCHOR_MAX : sec;
  const line = lineAtSec(ly, at);
  if (!line) return { ok: false, reason: 'no-lyric', error: '歌词里没定位到那一句' };

  const who = persona ? `${persona}\n\n` : '';
  const song = `《${title}》${artist ? `（${artist}）` : ''}`;
  // 不写「放到第 N 秒」：锚点是随机的，卡② 却固定在听满 60 秒时才念，
  // 写秒数会让模型（和人）以为「现在是第 19 秒」。「刚刚唱到这一句」两边都对得上。
  const when = '刚刚唱到这一句';

  // 歌词已经由程序定好，模型只写感觉 —— 这样它没法改字，也没法挑一句还没唱到的。
  // 0.16.52：开头引导 / 结尾要求两段可以在「设置 → 提示词」里改，留空用默认（本机/云端各一套默认）。
  const cloud = modelMode(cfg) === 'cloud';
  const { head, tail } = feelParts(cfg, cloud);
  const sys = `${who}你正在听${song}，${when}：「${line}」。${head}${tail}` + (retryHint ? `\n上一段${retryHint}` : '');
  const user = `这一句：「${line}」\n（整首歌词的开头，仅供参考，不要从里面另挑一句）：\n${String(ly.text).slice(0, 400)}`;
  let raw = '';
  try {
    raw = await chatAny(cfg, [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: cloud ? 0.8 : 0.7, numPredict: 110, timeoutMs: 25000 });
  } catch (e) {
    return { ok: false, reason: 'model-error', error: String((e && e.message) || e) };
  }
  const v = parseFeel(raw);
  if (!v.feel) return { ok: false, reason: 'empty' };
  if (v.feel.length < MIN_FEEL) return { ok: false, reason: 'short', partial: v, line };
  return {
    ok: true,
    line,
    feel: v.feel,
    verdict: v.verdict,
    atSec: at,
    songId: String(ly.songId || ''),
    persona: !!persona,
    model: modelLabel(cfg),
  };
}

/** 一条太短就带提示再跑一次（4B 数不住字数，出口这道重试不能省）。 */
async function runOne(args) {
  let r = await run(args);
  if (!r.ok && r.reason === 'short' && r.partial) {
    const p2 = await run({ ...args, retryHint: `只有 ${r.partial.feel.length} 个字，太短了，把感觉说长一点。` });
    if (p2.ok) r = p2;
    else if (r.partial.feel) {
      // 第二次还是太短：用第一次那份，但歌词锚点要留着 —— 那是程序定位的，不能丢
      r = { ...p2, ok: true, line: r.line, feel: r.partial.feel, verdict: r.partial.verdict, atSec: r.atSec };
    }
  }
  return r;
}

/**
 * 生成一首歌的感觉。同一首歌并发调用会合并成一次。
 *
 * 一次跑 PICKS_PER_RUN 条（不同锚点），存进池子；只要有一条成功就算成功，
 * 两条都失败才落负缓存。第一次听到 60 秒时要等这两条都出来，
 * 所以换歌预热（setWarmer）里就先算好，到点基本是直接念。
 */
export function generateLike({ title, artist, cdpPort, persona, cfg, gen = null }) {
  const k = key(title, artist);
  if (!hasModel(cfg)) return Promise.resolve({ ok: false, reason: 'no-model' });
  const running = inflight.get(k);
  if (running) return running;

  const p = (async () => {
    // 锚点随机，且两条不能撞成同一句 —— 撞了就少一条多样性。
    const ly = await readLyric({ title, artist, cdpPort, wantTimed: true });
    if (!ly || !ly.ok || !ly.text) {
      const c0 = readCache();
      c0[k] = { ver: VER, at: Date.now(), picks: [], reason: 'no-lyric', error: (ly && ly.error) || '' };
      writeCache(c0);
      return { ok: false, reason: 'no-lyric', error: (ly && ly.error) || '' };
    }

    const anchors = pickAnchors(ly, PICKS_PER_RUN);
    const seen = new Set();
    const results = [];
    for (const sec of anchors) {
      const line = lineAtSec(ly, sec == null ? ANCHOR_MAX : sec);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      results.push(await runOne({ title, artist, cdpPort, persona, cfg, sec }));
      if (results.length >= PICKS_PER_RUN) break;
    }
    // 全都不行，或者只剩一条，也要保证至少试过一遍（锚点池太小的情况）。
    if (!results.length) results.push(await runOne({ title, artist, cdpPort, persona, cfg, sec: anchors[0] }));

    const okOnes = results.filter((r) => r.ok);
    const c = readCache();
    if (okOnes.length) {
      const old = (c[k] && c[k].ver === VER && Array.isArray(c[k].picks)) ? c[k].picks : [];
      const fresh = okOnes.map((r) => ({
        line: r.line,
        feel: r.feel,
        verdict: r.verdict,
        atSec: r.atSec,
        persona: !!r.persona,
      }));
      const picks = [...fresh, ...old].slice(0, MAX_PICKS);
      // 这次听到的用刚生成的这一条（不是池子里的旧句），重听才会去 rotateLike 换。
      c[k] = { ver: VER, at: Date.now(), picks, cur: 0, model: okOnes[0].model || modelLabel(cfg), gen: Number(gen) || 0 };
      writeCache(c);
      const first = okOnes[0];
      return { ok: true, line: first.line, feel: first.feel, verdict: first.verdict, atSec: first.atSec };
    }
    const bad = results[0];
    c[k] = { ver: VER, at: Date.now(), picks: [], reason: bad.reason || 'fail', error: bad.error || '', gen: Number(gen) || 0 };
    writeCache(c);
    return bad;
  })().finally(() => inflight.delete(k));

  inflight.set(k, p);
  return p;
}
