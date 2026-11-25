/**
 * 0.17.46 自测：切歌判断优先按 id。
 * 跑：node _t_sametrack.mjs
 */
import { sameTrack, gateVerdict } from './src/chain.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(`${m}（${JSON.stringify(a)}）`) : fail(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

// —— 同一首判定 ——
eq(sameTrack('歌A', '111', '歌B', '111'), true, 'id 相同、名字不同 → 同一首');
eq(sameTrack('歌A', '111', '歌A', '222'), false, 'id 不同（同名翻唱）→ 不同首');
eq(sameTrack('歌A（Live）', '', '歌A', ''), true, '两边没 id → 退回名字（去括号）');
eq(sameTrack('歌A', '111', '歌A', ''), true, '一边没 id → 退回名字');
eq(sameTrack('歌A', '', '歌B', ''), false, '两边没 id、名字不同 → 不同首');

// —— 闸门 ——
const base = { origin: 'her-offer', base: { name: '旧名字', id: '111' }, baseAt: Date.now() - 60_000 };
eq(gateVerdict(base, '新名字', Date.now(), '111'), '', 'id 相同 → 允许接（名字变了也不误判）');
eq(gateVerdict(base, '旧名字', Date.now(), '222'), 'not-hers', 'id 不同 → 判不是她那首');

const noId = { origin: 'her-offer', base: { name: '晴天', id: '' }, baseAt: Date.now() - 60_000 };
eq(gateVerdict(noId, '晴天', Date.now(), ''), '', '都没有 id → 按名字，仍然是同一首');

const pending = { origin: 'her-offer', base: { name: 'A', id: '1' }, baseAt: Date.now(), pending: { name: 'B', id: '2', at: Date.now() } };
eq(gateVerdict(pending, 'C', Date.now(), '9'), 'arming', '装填中：播放条还是别的歌 → 继续等落地，不判切歌');

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
