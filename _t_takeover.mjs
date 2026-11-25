/**
 * 0.17.18（方案 A+B）自测：他开口点歌的那一刻，能不能判到「这个动作」。
 *
 * 判据不是「歌名变了」——那要等客户端切过去（慢路径 5~10 秒，承诺早抢跑了）。
 * 判的是 `beginUserTakeover()` 这一下：文件里立刻出现 `userAskAt` + `closed: user-ask`，
 * 闸在下一秒采样就短路。这里直接把这一串状态机跑一遍，并备份/还原现场 chain.json。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { state } from './src/store.js';
import {
  beginUserTakeover, markOrigin, peekChain, saveChain, gateVerdict,
  userRequestHold, USER_ASK_HOLD_MS, keyOf, chainSpeakAllowed, chainStateOf,
  setPickWait,
} from './src/chain.js';
import { stopSpeaking, isSpeaking } from './src/speak.js';

const FILE = state('chain.json');
const had = existsSync(FILE);
const old = had ? readFileSync(FILE, 'utf8') : null;

const ok = [];
const bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ` — ${extra}` : ''}`);

try {
  /* ① 先造一个「她那一轮播过、承诺还没投」的现场：正是 11-24 08:11 的样子 */
  saveChain({
    origin: 'her-offer',
    base: { name: '认真的雪', artist: '薛之谦' },
    baseAt: Date.now() - 2000,
    count: 3,
    lastSeen: '认真的雪',
    next: { name: '在你的身边', artist: '盛哲', id: '475479888', said: true },
    nextAt: Date.now() - 1000,
    userAskAt: 0,
    closed: null,
    offer: null,
    pending: null,
    verify: null,
  });
  const before = peekChain();
  check('造现场：origin=her-offer', before.origin === 'her-offer');
  check('造现场：承诺在（next.said）', !!(before.next && before.next.said));
  check('造现场：这一声可以出口', chainSpeakAllowed(before, '在你的身边') === true);
  check('名字对不上就不念', chainSpeakAllowed(before, '起风了') === false);

  /* ② 他开口点歌 —— 只调这一个函数，模拟 tools.js 在 playSongs 之前那一下 */
  const t0 = Date.now();
  beginUserTakeover();
  const st = peekChain();
  check('动作判到了：userAskAt 落盘', Number(st.userAskAt) >= t0, `at=${st.userAskAt}`);
  check('动作判到了：30 秒内算「请求在飞」', userRequestHold(st) === true);
  check('承诺当场作废：next 清空', st.next === null);
  check('这一轮已收场：closed=user-ask', !!(st.closed && st.closed.reason === 'user-ask'));
  check('来源已改成 user-ask', st.origin === 'user-ask');
  check('闸的纯函数也认：user-ask', gateVerdict(st, '被遗忘的时光') === 'user-ask');
  // 0.17.19：播报出口也复用同一份状态判断 —— 停止后那句不许再念
  check('停止后：播报被拒', chainSpeakAllowed(st, '在你的身边') === false, `state=${chainStateOf({ chain: st, offer: st.offer, waitMs: 0 }).kind}`);

  /* ③ 30 秒后戳失效（只是保险过期，来源仍是 user-ask，照样不许接） */
  check('31 秒后 hold 失效', userRequestHold(st, Date.now() + 31 * 1000) === false, `hold=${USER_ASK_HOLD_MS}ms`);
  check('戳过期也不接力：仍返回 user-ask', gateVerdict(st, '被遗忘的时光', Date.now() + 31 * 1000) === 'user-ask');

  /* ④ playSongs 成功后的老动作：markOrigin('user-ask') 补上 base，closed 放掉 */
  markOrigin('user-ask', { name: '被遗忘的时光', artist: '蔡琴' });
  const st2 = peekChain();
  check('落地后 base 是《被遗忘的时光》', !!(st2.base && st2.base.name === '被遗忘的时光'));
  check('落地后 closed 放开', st2.closed === null);
  check('落地后仍 user-ask（不接力）', gateVerdict(st2, '被遗忘的时光') === 'user-ask');

  /* ⑤ 她那条线重新开一轮 → 抢占戳必须撤掉，否则接力被挡 30 秒 */
  markOrigin('her-offer', { name: '认真的雪', artist: '薛之谦' });
  const st3 = peekChain();
  check('her-offer 新一轮：userAskAt 归零', Number(st3.userAskAt) === 0);
  check('her-offer 新一轮：闸放行', gateVerdict(st3, '认真的雪') === '');
  check('her-offer 新一轮：base 对上', keyOf(st3.base.name) === keyOf('认真的雪'));
  check('her-offer 新一轮：播报恢复', chainSpeakAllowed(st3, '认真的雪') === true);

  /* ⑥ 手动换歌收场：closed 之后那句同样不许念 */
  saveChain({ closed: { reason: 'switched', at: Date.now() } });
  const st4 = peekChain();
  check('收场后：播报被拒', chainSpeakAllowed(st4, '认真的雪') === false);
  check('收场后：面板状态是 stopped', chainStateOf({ chain: st4, offer: st4.offer, waitMs: 0 }).kind === 'stopped');

  /* ⑦ 撤声：stopSpeaking 幂等，且不会把「正在播」的标记留下来 */
  stopSpeaking();
  stopSpeaking();
  check('stopSpeaking 之后 isSpeaking=false', isSpeaking() === false);
} finally {
  if (had) writeFileSync(FILE, old, 'utf8');
  else { try { unlinkSync(FILE); } catch { /* ignore */ } }
}

console.log(`通过 ${ok.length} 项：`);
for (const s of ok) console.log('  ok  ' + s);
if (bad.length) {
  console.log(`失败 ${bad.length} 项：`);
  for (const s of bad) console.log('  BAD ' + s);
  process.exitCode = 1;
} else {
  console.log('接力抢占（A+B）自测全部通过');
}
