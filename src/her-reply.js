/**
 * 卡④ 的后半截：她看完那条热评，自己说几句。
 *
 * 口径（用户定的）：
 *   - **引用原文，不转述** —— 面板上先把评论一大段原文摆出来（comment.js 负责），
 *     她的话只跟在后面，所以这里不让她概括、也不让她复述。
 *   - 就着这条评论说，**不许跑题到别的歌**、不许评价文笔好不好。
 *   - 不少于 30 个字、不多于 60 个字。
 *   - **开口就是「我觉得」或「我认为」**（0.0.1.6.6）。评价前面不再挂「她听完说」这种引子：
 *     播报是「<昵称>说：<原文><我觉得……>」，面板上也只摆原文和这句话。
 *
 * 为什么不做「我看到有人说……然后就……」这种拼句：
 * 试过让模型自己写「我看到有人说」开头，4B 会变成分析评论的写法
 * （「这评论是在用红白玫瑰比喻爱情中的不平等」），读起来像语文老师。
 * 现在改成原文单独一块、她的话单独一块，各说各的，反而像人。
 *
 * 还有一条是踩出来的：不写这句约束时，4 次里有 1 次会把评论者的经历当成自己的
 * （「听着歌就想起自己搭车时的傻劲」——她没搭过车）。但也不能直接写「只能说『他』」，
 * 那样 4 次全以「他真敢走」开头，模板味很重。最后用的是抽象版：
 * 「评论里那个人的经历是那个人的，不要写成你自己的经历。」
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cachePath, songKey, readJson, writeJson } from './store.js';
import { commentSys, commentTailCustomized } from './prompts.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatAny, hasModel, modelLabel } from './ollama.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = cachePath('her-reply.json');
const TTL_MS = 12 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;
/** 用户要求不少于 30 字；上限 60，再长一条评论念不完。 */
const MIN_CHARS = 30;
const MAX_CHARS = 60;
/** 判断「评论换了没」只看开头这么多字 —— 够区分，又不怕尾部被截断改动。 */
const STAMP_CHARS = 40;
/** 缓存格式版本。2 = 评价必须以「我觉得 / 我认为」开头（0.0.1.6.6）。 */
const VER = 2;

const OPENERS = ['我觉得', '我认为'];

const SYS = '你在听歌，看到评论区一条热评。就着这条评论说两三句你自己的看法：\n'
  + '开口第一句话用「我觉得」或「我认为」开头，然后再讲下去。\n'
  + '同意就讲同意在哪，不同意就讲为什么。说大白话，像跟朋友聊天。\n'
  + '不要复述评论原文，不要评价文笔好不好，不要扯到别的歌。\n'
  + '评论里那个人的经历是那个人的，不要写成你自己的经历。\n'
  + '不少于30个字，不多于60个字。只输出这几句话，不加引号，不写名字。';

let cache = null;
const inflight = new Map();

const key = songKey;
const stamp = (comment) => String(comment || '').replace(/\s+/g, '').slice(0, STAMP_CHARS);

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
 * 同步读结果。传了 cfg 就核对模型、传了 comment 就核对评论原文 ——
 * 换模型或者这首歌的热评换了一条，旧句子都不能拿来充数。
 */
export function peekReply(title, artist, cfg, comment) {
  const c = readCache()[key(title, artist)];
  if (!c || !c.text) return null;
  // 旧格式（没有「我觉得 / 我认为」开头）不认，让它按新规矩重算一次
  if (Number(c.ver) !== VER) return null;
  if (Date.now() - (c.at || 0) > TTL_MS) return null;
  if (cfg) {
    const want = modelLabel(cfg);
    const got = String(c.model || '');
    if (want && got && got !== want) return null;
  }
  if (comment && c.cm && String(c.cm) !== stamp(comment)) return null;
  if (String(c.text).trim().length < MIN_CHARS && !c.short) return null;
  return c;
}

export function peekReplyFailError(title, artist) {
  const c = readCache()[key(title, artist)];
  if (!c || c.text) return '';
  if (Date.now() - (c.at || 0) > FAIL_TTL_MS) return '';
  return String(c.error || '');
}

export function isReplyPending(title, artist) {
  return inflight.has(key(title, artist));
}

/**
 * 收成一段话：去 markdown、去引号、并成一行、封顶 60 字。
 * 超长按句号断，别砍成半句；实在没有句号才硬切加省略号。
 */
function clean(raw) {
  let t = String(raw || '').trim();
  // 重试提示被抄进正文的先例（qwen2.5:3b），一并剥掉
  t = t.replace(/[,，。、；;]?\s*上一[句段]\s*(只[有剩])?\s*\d+\s*个字.*$/s, '');
  t = t.replace(/\*\*/g, '').replace(/(^|\n)\s*#+\s*/g, '$1');
  t = t.replace(/^[\s"'“”「」『』]+/, '').replace(/[\s"'“”「」『』]+$/, '');
  t = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('');
  t = t.replace(/\s+/g, '');
  if (t.length > MAX_CHARS) {
    const cut = t.match(/^.{10,60}?[。！？]/);
    t = cut ? cut[0] : `${t.slice(0, MAX_CHARS - 1)}…`;
  }
  return t;
}

/** 是不是已经自己用「我觉得 / 我认为」开头了。 */
function hasOpener(t) {
  return /^(我觉得|我认为)/.test(String(t || ''));
}

/**
 * 兜底补开头词。
 *
 * 4B 说了不一定做：prompt 里写了「用『我觉得』或『我认为』开头」，实测有几次还是直接
 * 「这评论说得对……」。补的时候两个词随机挑一个，不然一整晚听下来全是「我觉得」。
 * 补进去会顶掉几个字，所以先把正文截到（60 - 前缀 - 1）以内，别把最后一句砍掉。
 */
function ensureOpener(t) {
  const s = String(t || '').trim();
  if (!s || hasOpener(s)) return s;
  const op = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  const room = MAX_CHARS - op.length - 1; // 前缀 + 逗号
  const body = s.length > room ? `${s.slice(0, Math.max(1, room - 1))}…` : s;
  return `${op}，${body}`;
}

async function run({ title, artist, comment, persona, cfg }) {
  const user = [
    persona ? `性格：${persona}` : '',
    `在听《${title}》— ${artist}。`,
    '热评原文：',
    `「${String(comment)}」`,
  ].filter(Boolean).join('\n');

  let text = '';
  // 0.16.52：开头引导 / 结尾要求可以在「设置 → 提示词」里改，留空用默认（原来的那段）。
  const base = commentSys(cfg);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sys = attempt === 0 ? base : `${base}\n上一段只有${text.length}个字，太短了，多说两句。`;
    let raw;
    try {
      raw = await chatAny(cfg, [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], { temperature: attempt > 0 ? 0.6 : 0.8, numPredict: 120, timeoutMs: 25000 });
    } catch (e) {
      if (attempt === 0) return { ok: false, reason: 'model-error', error: String((e && e.message) || e) };
      continue;
    }
    text = clean(raw);
    if (text.length >= MIN_CHARS) break;
  }
  if (!text) return { ok: false, reason: 'empty' };
  // 开口词放最后补：先保证模型把内容说够 30 字，再补前缀（补了只会更长）
  // 0.16.52：用户在设置里自己写过结尾要求，就别再硬塞「我觉得」——可能和他的风格冲突。
  if (!commentTailCustomized(cfg)) text = ensureOpener(text);
  return {
    ok: true,
    text,
    short: text.length < MIN_CHARS,
    model: modelLabel(cfg),
    cm: stamp(comment),
  };
}

/** 生成她看完评论的几句话。没有模型、没评论、模型没说话都如实返回 {ok:false}。 */
export function generateReply({ title, artist, comment, persona, cfg }) {
  const k = key(title, artist);
  if (!hasModel(cfg)) return Promise.resolve({ ok: false, reason: 'no-model' });
  if (!String(comment || '').trim()) return Promise.resolve({ ok: false, reason: 'no-comment' });
  const running = inflight.get(k);
  if (running) return running;

  const p = (async () => {
    let r = await run({ title, artist, comment, persona, cfg });
    // 一字不差地复述了评论（4B 偶尔会）→ 再要一次。比之前先剥掉刚补的开头词，
    // 不然「我觉得，」一补，这条判断永远不成立。
    const bare = (t) => clean(String(t || '').replace(/^(我觉得|我认为)[，,]?\s*/, ''));
    if (r.ok && bare(r.text) === clean(comment)) {
      r = await run({ title, artist, comment, persona, cfg });
    }
    const c = readCache();
    c[k] = r.ok
      ? { ver: VER, at: Date.now(), text: r.text, short: !!r.short, model: r.model || '', cm: r.cm || '' }
      : { ver: VER, at: Date.now(), text: '', reason: r.reason || 'fail', error: r.error || '' };
    writeCache(c);
    return r;
  })().finally(() => inflight.delete(k));

  inflight.set(k, p);
  return p;
}
