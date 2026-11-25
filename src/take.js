/**
 * 「她怎么听这首」—— 卡①的正文。
 *
 * 做法：拿歌词 → 让本机 Ollama 的生成模型读一遍 → 用一句话说听感 → 缓存。
 * 为什么要 10 秒级：小模型读 700 字歌词再落笔，3~10 秒是正常水平；
 * 面板 3 秒轮询一次，生成完下一轮自然就上来了，不需要前端干等。
 *
 * 缓存 12 小时；失败也缓存（1 小时）—— 纯音乐没有歌词，不缓存的话
 * 面板每 3 秒都会重新跑一次取歌词脚本，白烧 CPU。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cachePath, songKey, readJson, writeJson } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatAny, hasModel, modelLabel } from './ollama.js';
import { readLyric } from './lyric.js';
import { hearSys } from './prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = cachePath('her-take.json');
const TTL_MS = 12 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;
/** 那句话的字数区间：太少听不出在说什么，太多一口气念不完。 */
const MIN_CHARS = 15;
const MAX_CHARS = 30;

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

/**
 * 同步读成功结果。没有（或过期、或短到不能念）返回 null。
 * 传了 cfg 就顺带核对模型：缓存是别的模型写的就当成没有 —— 换模型时不能拿旧句子充数。
 */
export function peekTake(title, artist, cfg, gen = null) {
  const c = readCache()[key(title, artist)];
  if (!c || !c.text) return null;
  if (Date.now() - (c.at || 0) > TTL_MS) return null;
  // 0.17.54：换歌/重播 = 新的一遍 → 上一遍的句子作废，重新生成
  if (gen != null && Number(c.gen) !== Number(gen)) return null;
  if (cfg) {
    const want = modelLabel(cfg);
    const got = String(c.model || '');
    if (want && got && got !== want) return null;
  }
  // 0.2.4 之前存下的短句（6~12 字）念出来等于没说，当成没有，让它重新生成。
  // 但重试两次还是短的就认了（打 short 标记），不然每次刷新都白跑一遍模型。
  if (!c.short && String(c.text).trim().length < MIN_CHARS) return null;
  return c;
}

/** 同步读原始正文（不校验长度/过期），只用来「别和上一次说的一样」。 */
export function peekRawText(title, artist) {
  const c = readCache()[key(title, artist)];
  return c && c.text ? String(c.text) : '';
}

/** 同步读失败记录（例如「这首歌没歌词」）。返回 reason 字符串或 null。 */
export function peekFail(title, artist) {
  const c = readCache()[key(title, artist)];
  if (!c || c.text) return null;
  if (Date.now() - (c.at || 0) > FAIL_TTL_MS) return null;
  return String(c.reason || 'fail');
}

/**
 * 失败时的原始错误文本（云端报错就靠它）。
 * 面板在 model-error 时把它显示成一行小字 —— 否则只知道「没回话」，不知道是 key 错了还是余额空了。
 */
export function peekFailError(title, artist) {
  const c = readCache()[key(title, artist)];
  if (!c || c.text) return '';
  if (Date.now() - (c.at || 0) > FAIL_TTL_MS) return '';
  return String(c.error || '');
}

/** 是否正在生成这首歌的听感（给前端显示「她在听…」）。 */
export function isPending(title, artist) {
  return inflight.has(key(title, artist));
}

/**
 * 把模型输出收成一句话：去引号、去前缀、只留第一行、收到 30 字以内。
 * 小模型不听字数指令（实测照样会给到 27 字以上），所以在出口硬收。
 * 优先在标点处断，别把一句话砍成半句。下界不在这里砍 —— 太短靠重试补。
 */
function clean(raw) {
  let t = String(raw || '').trim();
  // 重试提示会被小模型抄进正文（qwen2.5:3b 实测输出过
  // 「月光洒在空荡酒馆，回忆如潮水涌动。,上一幕只有8个字太短。」）——
  // 先把这截污染剥掉，再走后面的清洗。
  t = t.replace(/[,，。、；;]?\s*上一[句幕]只[有剩]\s*\d+\s*个字.*$/s, '');
  t = t.replace(/^[\s"'“”「」『』]+/, '').replace(/[\s"'“”「」『』]+$/, '');
  t = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
  t = t.replace(/^(她|我)?(怎么听|觉得|感受)[^：:]{0,6}[：:]/g, '').trim();
  if (t.length > MAX_CHARS) {
    const cut = t.match(/^.{5,30}?[，。！？、；,.!?;]/);
    t = cut ? cut[0] : t.slice(0, MAX_CHARS);
  }
  // 结尾的逗号顿号分号去掉 —— 那是句中停顿，念出来会拖一个尾音。
  // 句号问号感叹号留着，那是一个说完的句子。
  t = t.replace(/[，、；：,\s]+$/, '');
  return t;
}

async function run({ title, artist, cdpPort, cfg }) {
  const ly = await readLyric({ title, artist, cdpPort });
  if (!ly || !ly.ok || !ly.text) {
    return { ok: false, reason: 'no-lyric', error: (ly && ly.error) || '' };
  }
  // 字数要求说两遍：实测只说一遍时 qwen 会给到 27 字，说两遍才稳。
  // 上下界都写进 prompt：太少（6~7 字）听不出在说什么，太多一口气念不完。
  // 也不要给例句 —— 给了它就直接抄例句（试过，有一首原样复读）。
  // 0.16.52：开头引导与结尾要求可以在「设置 → 提示词」里改，留空用默认。
  // 原来是这里写死的一句，用户听多了嫌开头结尾一个样。
  const base = hearSys(cfg);
  const user = `《${title}》— ${artist}\n歌词：\n${String(ly.text).slice(0, 700)}`;
  let text = '';
  let lastRaw = '';
  // 太短就再要一次：模型偶尔给六七个字，那样的句子念出来等于没说。
  // 0.8b 这个模型对「不少于15字」不太服管，最有效的是让它写成两个分句 —— 结构约束比数字好使。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let sys = base;
    if (attempt > 0) {
      // 「每个分句至少7个字」这种数字约束对这个 0.8b 没用（实测平均反而只有 10 字）。
      // 管用的是把它引到两个内容上：先说画面、再说联想 —— 内容一多字数自然够。
      sys = `${base}先写你看到的一个画面，再写它让你想到的，两句合起来不少于15个字，中间用逗号。`
        + `上一句只有${text.length || 0}个字，太短了。`;
    }
    try {
      lastRaw = await chatAny(cfg, [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], { temperature: attempt > 1 ? 0.4 : 0.7, numPredict: 70, timeoutMs: 25000 });
    } catch (e) {
      if (attempt === 0) return { ok: false, reason: 'model-error', error: String((e && e.message) || e) };
      continue;
    }
    text = clean(lastRaw);
    if (text && text.length >= MIN_CHARS) break;
  }
  if (!text) return { ok: false, reason: 'empty' };
  return {
    ok: true,
    text,
    short: text.length < MIN_CHARS,
    songId: String(ly.songId || ''),
    model: modelLabel(cfg),
    lyricLines: Number(ly.lines) || 0,
  };
}

/**
 * 生成一首歌的听感。没有模型、没有歌词、模型没说话，都如实返回 {ok:false, reason}。
 * 同一首歌并发调用会合并成一次。
 *
 * `avoid`：上一次说过的那句。换歌重算时传进来 —— 模型有时会原样给出同一句，
 * 那就再要一次。用户要「每次答案都不一样」，这件事只能在这里兜。
 */
export function generateTake({ title, artist, cdpPort, cfg, avoid, gen = null }) {
  const k = key(title, artist);
  if (!hasModel(cfg)) return Promise.resolve({ ok: false, reason: 'no-model' });
  const running = inflight.get(k);
  if (running) return running;

  const p = (async () => {
    const prev = String(avoid || '').trim() || peekRawText(title, artist);
    let r = await run({ title, artist, cdpPort, cfg });
    // 和上一句一字不差 → 再要一次（temperature 0.7，第二次基本不会撞）
    if (r.ok && prev && String(r.text).trim() === prev) {
      r = await run({ title, artist, cdpPort, cfg });
    }
    const c = readCache();
    c[k] = r.ok
      ? { at: Date.now(), text: r.text, short: !!r.short, songId: r.songId || '', model: r.model || '', lyricLines: r.lyricLines || 0, gen: Number(gen) || 0 }
      : { at: Date.now(), text: '', reason: r.reason || 'fail', error: r.error || '', gen: Number(gen) || 0 };
    writeCache(c);
    return r;
  })().finally(() => inflight.delete(k));

  inflight.set(k, p);
  return p;
}
