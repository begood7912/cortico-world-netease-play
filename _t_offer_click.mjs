/**
 * 0.17.65 自测：接受提议的时间锚点 = 「他点『放《X》』那一刻」。
 *
 * 场景（用户原话）：等很久之后才点放 —— 以前按「她开口 + 30 秒」判，一超窗口就判成
 * 他自己点歌（user-ask），接力被掐。现在改为从点击时刻起算 30 秒。
 *
 * 注意：`recentIdleOffer` 读的是 data\idle.json（真数据，且模块内有内存缓存）。
 * 本脚本先备份、每步写完 fixture 调 reloadIdle()、跑完 finally 还原 —— 不污染用户那条提议。
 *
 * 用法：node _t_offer_click.mjs
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isOfferAccept, OFFER_WINDOW_MS } from './src/tools.js';
import { markIdleAnswered, markIdlePlayClick, recentIdleOffer, reloadIdle } from './src/idle.js';

const FILE = 'data/idle.json';
const had = existsSync(FILE);
const bak = had ? readFileSync(FILE, 'utf8') : null;
let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`[ OK ] ${name}`); } else {
    fail += 1;
    console.log(`[FAIL] ${name}\n       期望 ${JSON.stringify(want)}\n       实际 ${JSON.stringify(got)}`);
  }
};
const offer = (at, extra = {}) => ({ at, spoken: '要放《命运》吗', pick: { name: '命运', artist: '家家', id: '' }, idleSec: 60, answeredAt: 0, ...extra });
/** 写盘 + 丢掉内存那份（测试专用）。 */
const setIdle = (obj) => { writeFileSync(FILE, JSON.stringify(obj), 'utf8'); reloadIdle(); };

try {
  const T = Date.now();

  // ① 十分钟前开口、没点过放 → 不算（旧口径在这里漏掉，正是要修的场景）
  setIdle(offer(T - 600_000));
  check('十分钟前开口、没点击 → 不算', recentIdleOffer(OFFER_WINDOW_MS), null);

  // ② 十分钟前开口 + 5 秒前点了「放《命运》」→ 算接受
  setIdle(offer(T - 600_000));
  markIdlePlayClick({ at: T - 5_000, name: '命运' });
  const o2 = recentIdleOffer(OFFER_WINDOW_MS);
  check('十分钟前开口 + 5 秒前点了放 → 算接受', !!(o2 && o2.via === 'click'), true);
  check('  接受的是她提议那一首', isOfferAccept([{ name: '命运' }], o2), true);
  check('  从他点的时间起算（约 5 秒）', !!(o2 && o2.sinceMs >= 4_900 && o2.sinceMs <= 5_300), true);

  // ③ 点了放但已经过了 31 秒 → 不算
  setIdle(offer(T - 900_000));
  markIdlePlayClick({ at: T - 31_000, name: '命运' });
  check('点了放但已过 31 秒 → 不算', recentIdleOffer(OFFER_WINDOW_MS), null);

  // ④ 已作答（点过「等一会」/确认条）→ 不再认领，哪怕刚点了放
  setIdle(offer(T - 60_000, { answeredAt: T - 3_000 }));
  markIdlePlayClick({ at: T - 2_000, name: '命运' });
  check('这条提议已作答 → 不认领', recentIdleOffer(OFFER_WINDOW_MS), null);

  // ⑤ 点放早于她开口 → 不是这次，不写、不算
  setIdle(offer(T - 60_000));
  markIdlePlayClick({ at: T - 65_000, name: '命运' });
  reloadIdle();
  check('早于开口的点击被忽略（clickAt 没写进去）', Number(JSON.parse(readFileSync(FILE, 'utf8')).clickAt || 0), 0);
  check('  且不算接受', recentIdleOffer(OFFER_WINDOW_MS), null);

  // ⑥ 点了放，但 AI 放的是另一首 → 名字不匹配，不算
  setIdle(offer(T - 120_000));
  markIdlePlayClick({ at: T - 3_000, name: '命运' });
  const o6 = recentIdleOffer(OFFER_WINDOW_MS);
  check('点了放（窗口内）但歌名不一致 → 不接', isOfferAccept([{ name: '十年' }], o6), false);

  // ⑦ 没点过放，但她刚开口 5 秒（AI 自主调工具）→ 退回旧口径仍算
  setIdle(offer(T - 5_000));
  const o7 = recentIdleOffer(OFFER_WINDOW_MS);
  check('刚开口 5 秒、没点击（AI 自主调）→ 仍算', !!(o7 && o7.via === 'ask'), true);

  // ⑧ 提议超过 ASK_HOLD（8 小时）→ 点击也不认，防「天荒地老」
  setIdle(offer(T - 8 * 3600 * 1000 - 60_000));
  markIdlePlayClick({ at: T - 3_000, name: '命运' });
  check('提议超过 8 小时 → 点击也不认', recentIdleOffer(OFFER_WINDOW_MS), null);

  // ⑨ 认领即收口（tools.js 里接受之后会调 markIdleAnswered）
  setIdle(offer(T - 300_000));
  markIdlePlayClick({ at: T - 2_000, name: '命运' });
  check('（前置）此刻可认领', !!recentIdleOffer(OFFER_WINDOW_MS), true);
  markIdleAnswered();
  check('认领后写 answeredAt → 第二次不再认领', recentIdleOffer(OFFER_WINDOW_MS), null);
} finally {
  if (had) writeFileSync(FILE, bak, 'utf8');
  else { try { unlinkSync(FILE); } catch { /* ignore */ } }
  reloadIdle();
  console.log('\n（data/idle.json 已还原）');
}

console.log(`\n${fail ? '有失败' : '全部通过'}：${pass} 通过，${fail} 失败。`);
process.exit(fail ? 1 : 0);
