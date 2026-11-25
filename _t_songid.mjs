import { resolveId, remember, cachedId, cachedIds, resolveMany, _resetForTest } from './src/songid.js';

let pass = 0;
let fail = 0;
const ok = (cond, name) => { if (cond) { pass += 1; console.log('  ok', name); } else { fail += 1; console.log('  FAIL', name); } };

function fakeFetch(songs) {
  return async (url) => ({
    json: async () => ({ result: { songs } }),
    url,
  });
}

_resetForTest({});
const songs = [
  { id: 109530, name: '童年', artists: [{ name: '罗大佑' }], duration: 234973 },
  { id: 29932199, name: '童年 (live)', artists: [{ name: '罗大佑' }], duration: 215000 },
  { id: 108342, name: '童年 (Instrumental)(Live)', artists: [{ name: '罗大佑' }], duration: 105706 },
  { id: 108597, name: '童年', artists: [{ name: '罗大佑' }], duration: 234973 },
  { id: 1849013048, name: '童年', artists: [{ name: '卓依婷' }], duration: 188278 },
  { id: 999, name: '起风了', artists: [{ name: '买辣椒也用券' }], duration: 300000 },
];

// 1) 本地没有 → 查接口 → 命中，并写进缓存
const a = await resolveId('童年', '罗大佑', { fetcher: fakeFetch(songs) });
ok(a === '109530', '歌名+歌手命中第一个同名版本');
ok(cachedId('童年', '罗大佑') === '109530', '命中后进缓存');

// 2) 缓存命中就不再请求
let called = 0;
const spy = async (u) => { called += 1; return fakeFetch(songs)(u); };
const b = await resolveId('童年', '罗大佑', { fetcher: spy });
ok(b === '109530' && called === 0, '缓存命中时不再请求');

// 3) 带时长：把同名但时长不同的版本排掉
_resetForTest({});
const c = await resolveId('童年', '罗大佑', { durationMs: 235000, fetcher: fakeFetch(songs) });
ok(c !== '', '带时长也能命中');

// 4) 歌手对不上 → 空，并记一条（不抛）
_resetForTest({});
const d = await resolveId('童年', '不存在的人', { fetcher: fakeFetch(songs) });
ok(d === '', '歌手对不上就回空');

// 4b) 多歌手（"A/B"）也要能对上 —— 曾经因为拼串里带分隔符漏掉过
_resetForTest({});
const d2 = await resolveId('因为爱情', '陈奕迅/王菲', {
  fetcher: fakeFetch([{ id: 64317, name: '因为爱情', artists: [{ name: '陈奕迅' }, { name: '王菲' }], duration: 200000 }]),
});
ok(d2 === '64317', '多歌手里能命中最全的那版');

// 4c) 流水里的歌手带分隔符、接口里是分开的两个歌手 → 仍能对上
_resetForTest({});
const d3 = await resolveId('素颜', '许嵩/何曼婷', {
  fetcher: fakeFetch([{ id: 167827, name: '素颜', artists: [{ name: '许嵩' }, { name: '何曼婷' }], duration: 200000 }]),
});
ok(d3 === '167827', '分隔符不影响歌手匹配');

// 5) 接口失败 → 回空、不抛
_resetForTest({});
const e = await resolveId('起风了', '买辣椒也用券', { fetcher: async () => { throw new Error('boom'); } });
ok(e === '', '接口异常回空且不抛');

// 6) remember 只收数字 id
_resetForTest({});
ok(remember('成都', '赵雷', '436514312') === true, 'remember 记数字 id');
ok(remember('成都', '赵雷', '') === false, '空 id 不记');
ok(remember('成都', '赵雷', 'abc') === false, '非数字不记');

// 7) 批量：缓存优先 + 只查缺的
_resetForTest({ '成都|赵雷': '436514312' });
let queries = [];
const f = await resolveMany(
  [{ title: '成都', artist: '赵雷' }, { title: '童年', artist: '罗大佑' }],
  { concurrency: 2, fetcher: async (u) => { queries.push(u); return { json: async () => ({ result: { songs } }) }; } },
);
ok(f.get('成都|赵雷') === '436514312', '批量里缓存命中');
ok(f.get('童年|罗大佑') === '109530', '批量里现查命中');
ok(queries.length === 1, `只查了缺的那首（实际 ${queries.length} 次）`);

console.log(`\n${fail ? `失败 ${fail} 项` : `songid 自测全部通过（${pass} 项）`}`);
process.exit(fail ? 1 : 0);
