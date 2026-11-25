/**
 * 读回弹：桌宠那边点了气泡之后，回弹事件进的是宿主事件库，不是我们这边。
 *
 * 宿主给的 `WorldHost.store` 是 `EventStoreReader`（`get(cursor)` / `latestCursor()`），
 * 所以世界进程可以按游标增量扫 —— 这就是 0.0.1.6.23 加它的原因：
 *   1）点叉（`dismissed`）以前对我这边是零信号，只能靠冷却兜着；
 *   2）他真选了某一项时那条事件的正文到底怎么写，也需要一份原始样本才敢写匹配。
 *
 * 只做两件事，都不改播放：
 *   - 把所有 `desktop-pet.answer` 的原始正文追加进 `data/answer-log.jsonl`（排错用）
 *   - 认出是「关掉了提问」且属于我们那次（正文里有「要放歌」）时，回调 `onAnswer`
 *
 * 别的世界也在弹气泡，所以「是不是我们那次」靠标题文本判 —— 我们那版标题写的是「要放歌吗？」。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { state } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = state('answer-log.jsonl');

/** 我们弹的那版气泡标题里一定有这三个字。 */
const ASK_HINT = '要放歌';
/** 点叉/关掉的说法；真选了某一项时不会有这些字。 */
const DISMISS_RE = /关掉|没有作答|没作答|没有选择|没选|取消/;
/** 选中的写法：`老大回答「要放歌吗？」:选了第 3 项「不播放」` */
const CHOICE_RE = /选了第\s*(\d+)\s*项(?:「([^」]*)」)?/;

/** 扫一轮的间隔：采样器本来就是 3 秒一轮，这里 2 秒够用又不费。 */
const TICK_MS = 2000;
/** 补扫到旧回答只记不动作的时间窗（0.0.1.6.28）：超过这个年纪就不许改变播放。 */
const ACTION_TTL_MS = 120 * 1000;
/** 扫到哪儿了 —— 落盘，重启接着扫，别把重启缝隙里的回答丢掉。 */
const CUR_FILE = state('answer-cursor.json');

/** 这次弹的是两项还是三项 —— 解析选项序号时靠它换算语义。 */
const MODE_FILE = state('ask-mode.json');
let askMode = null;

/**
 * 问之前先记一笔「这次弹了几项」。
 * 两项版：① 播放此刻 ② 不播放； 三项版：① 听《X》 ② 换另外一首 ③ 不播放。
 */
export function setAskMode({ twoOnly, pick } = {}) {
  askMode = {
    at: Date.now(),
    twoOnly: !!twoOnly,
    pick: pick ? { name: String(pick.name || ''), artist: String(pick.artist || '') } : null,
  };
  try {
    appendFileSync(MODE_FILE, '', 'utf8');
  } catch { /* ignore */ }
  try {
    writeFileSync(MODE_FILE, JSON.stringify(askMode), 'utf8');
  } catch { /* 写不了就只靠内存 */ }
}

function readAskMode() {
  if (askMode) return askMode;
  try {
    askMode = JSON.parse(readFileSync(MODE_FILE, 'utf8')) || null;
  } catch {
    askMode = null;
  }
  return askMode;
}

/** 选项序号 → 语义（play / quiet / later）。 */
function intentOf(index, twoOnly) {
  if (!index) return '';
  if (index === 1) return 'play';
  // 0.0.1.6.36 用户口径：① 放 ② 一直保持安静 ③ 等一会再说；点叉 = 第二个。
  if (twoOnly) return index === 2 ? 'quiet' : '';
  if (index === 2) return 'quiet';
  if (index === 3) return 'later';
  return '';
}

let timer = null;
let cursor = null;

function log(rec) {
  try {
    appendFileSync(LOG, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch { /* 写不了就不写，不能影响采样 */ }
}

function readCursorFile() {
  try {
    const j = JSON.parse(readFileSync(CUR_FILE, 'utf8')) || {};
    return Number(j.cursor) || 0;
  } catch {
    return 0;
  }
}

function writeCursorFile(cur) {
  try {
    writeFileSync(CUR_FILE, JSON.stringify({ cursor: Number(cur) || 0, at: Date.now() }), 'utf8');
  } catch { /* ignore */ }
}

function scan(store, onAnswer) {
  const latest = Number(store.latestCursor()) || 0;
  if (cursor === null) {
    cursor = latest;
    return;
  }
  if (latest <= cursor) return;
  for (let cur = cursor + 1; cur <= latest; cur++) {
    let e = null;
    try {
      e = store.get(cur);
    } catch {
      e = null;
    }
    if (!e || e.type !== 'desktop-pet.answer') continue;
    const text = String(e.text || '');
    const ours = text.includes(ASK_HINT);
    const dismissed = DISMISS_RE.test(text);
    const m = text.match(CHOICE_RE);
    const index = m ? Number(m[1]) : 0;
    const option = m && m[2] ? String(m[2]) : '';
    const mode = readAskMode();
    const intent = ours ? intentOf(index, !!(mode && mode.twoOnly)) : '';
    const tsMs = Date.parse(String(e.ts || ''));
    const ageMs = Number.isFinite(tsMs) ? Date.now() - tsMs : -1;
    // 只有「刚刚点的」才允许触发动作（0.0.1.6.28）。
    // 重启后补扫旧事件是必要的（别漏回答），但补扫到一条十分钟前的「换另外一首」再去重算+自动播放
    // 就成了「一启动自己开始放歌」——用户实测踩到的就是这个。
    const fresh = ageMs >= 0 && ageMs <= ACTION_TTL_MS;
    log({
      at: Date.now(),
      cursor: cur,
      ts: String(e.ts || ''),
      source: String(e.source || ''),
      ours,
      dismissed,
      index,
      option,
      intent,
      twoOnly: mode ? !!mode.twoOnly : null,
      ageSec: ageMs >= 0 ? Math.round(ageMs / 1000) : -1,
      fresh,
      text: text.slice(0, 300),
    });
    if (ours && typeof onAnswer === 'function') {
      try {
        onAnswer({ cursor: cur, text, dismissed, index, option, intent, ageMs, fresh });
      } catch { /* 回调炸了也不影响扫描 */ }
    }
  }
  cursor = latest;
  writeCursorFile(cursor);
}

/**
 * 开始扫。返回 true 表示拿到了事件库；false 说明这个宿主没给 `store`（会写一行进日志，方便排查）。
 *
 * 0.0.1.6.25：游标落盘。以前每次启动都从「当前最新」起算，重启那几十秒里发生的事件全被跳过
 * （实测：10:42:06 弹的气泡 cursor 77364，10:42:38 重启，新进程从 77367 起扫，回答就丢了）。
 * 现在从 `data\answer-cursor.json` 接着上次的位置扫；文件不存在（或比最新还大）时回退
 * 第一次运行没有落盘游标时从「最新」起 —— 不回头补扫（补扫到的旧回答会一启动就自己放歌）。
 */
export function startAnswerWatch(host, { onAnswer } = {}) {
  stopAnswerWatch();
  const store = host && host.store;
  if (!store || typeof store.latestCursor !== 'function' || typeof store.get !== 'function') {
    log({ at: Date.now(), kind: 'no-store', note: '宿主没给 WorldHost.store' });
    return false;
  }
  let latest = 0;
  try {
    latest = Number(store.latestCursor()) || 0;
  } catch {
    latest = 0;
  }
  const saved = readCursorFile();
  const fromSaved = saved > 0 && saved <= latest;
  // 0.0.1.6.28：没有落盘游标（第一次跑）就从「最新」起，不回头补扫。
  // 补扫能捞回重启前那条回答，但那条是个**已经执行过的旧决定** —— 捞回来就一启动自己放歌。
  cursor = fromSaved ? saved : latest;
  timer = setInterval(() => {
    try {
      scan(store, onAnswer);
    } catch (e) {
      log({ at: Date.now(), kind: 'scan-fail', error: String((e && e.message) || e) });
    }
  }, TICK_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  log({
    at: Date.now(),
    kind: 'watch-start',
    cursor,
    latest,
    fromSaved,
  });
  return true;
}

export function stopAnswerWatch() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const PATHS = { LOG, TICK_MS };
