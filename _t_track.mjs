/**
 * 0.17.52（B3）自测：id → 官方歌名/歌手 的缓存与失败回退。
 * 跑：node _t_track.mjs
 */
import { songMeta, _resetTrackCache } from './src/track.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(`${m}（${JSON.stringify(a)}）`) : fail(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

let calls = 0;
const good = async (id) => {
  calls += 1;
  return { songs: [{ id: Number(id), name: '还是分开', artists: [{ name: '张叶蕾' }], duration: 226791 }] };
};

_resetTrackCache();
const m1 = await songMeta('465921195', { fetcher: good });
eq(m1 && m1.title, '还是分开', '取到歌名');
eq(m1 && m1.artist, '张叶蕾', '取到歌手');
eq(m1 && m1.durationMs, 226791, '取到时长');

const m2 = await songMeta('465921195', { fetcher: good });
eq(calls, 1, '同一 id 第二次走缓存，不再请求');
eq(m2 && m2.title, '还是分开', '缓存内容一致');

const m3 = await songMeta('', { fetcher: good });
eq(m3, null, '空 id → null');

let tried = 0;
const badFetch = async () => {
  tried += 1;
  throw new Error('network');
};
const m4 = await songMeta('999', { fetcher: badFetch });
eq(m4, null, '接口失败 → null，不抛');
const m5 = await songMeta('999', { fetcher: badFetch });
eq(tried, 1, '失败后 60 秒内不重试');

const empty = await songMeta('888', { fetcher: async () => ({ songs: [] }) });
eq(empty, null, '接口没有这首歌 → null');

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
