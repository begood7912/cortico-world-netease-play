/**
 * 0.17.44 自测：记账口径（A3 + 此刻页不算用户点歌）。
 *
 * 跑：node _t_play.mjs
 */
import { isAutoPick } from './src/play.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(`${m}（${JSON.stringify(a)}）`) : fail(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

eq(isAutoPick('user'), false, '排名页/用户点歌 → 记账');
eq(isAutoPick('auto'), true, '接力/换一批/此刻页点卡 → 不记账');
eq(isAutoPick(undefined), false, '没传 by → 按用户点歌（保留旧行为）');
eq(isAutoPick(''), false, '空串 → 按用户点歌');
eq(isAutoPick('USER'), true, '只认小写 user 这个值');

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
