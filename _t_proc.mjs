/**
 * proc.js 自测（不进包）：参数表、解析器、以及外壳的四种结局。
 * 外壳一律用 `node -e` 假脚本跑，不碰真实脚本、不碰 CDP。
 */
import assert from 'node:assert/strict';
import { PROFILES, profileTable, payloadOf, parseLastJson, parseResultJson, runProc, msgOf } from './src/proc.js';

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };

// 1) 参数表：10 个键，超时与旧实现一致
const expect = {
  'netease.chart': 40000,
  'netease.daily': 20000,
  'netease.lyric': 18000,
  'netease.progress': 5000,
  'netease.liked': 6000,
  'netease.fastplay': 4500,
  'netease.playlists': 20000,
  'netease.recoPlaylist': 40000,
  'netease.addplay': 180000,
  'netease.nowplaying': 15000,
};
const table = profileTable();
assert.equal(table.length, Object.keys(expect).length);
ok(`参数表 ${table.length} 个键`);
for (const [k, v] of Object.entries(expect)) {
  assert.ok(PROFILES[k], `缺 ${k}`);
  assert.equal(PROFILES[k].timeout, v, `${k} 超时被改了`);
}
ok('10 个超时与旧实现逐一相等');

// 2) 失败文案与旧实现逐字相同
assert.equal(msgOf('chart').timeout, '读榜单超时');
assert.equal(msgOf('daily').timeout, '读每日推荐超时');
assert.equal(msgOf('lyric').timeout, '取歌词超时');
assert.equal(msgOf('lyric').parse, '脚本没输出 JSON');
assert.equal(msgOf('progress').timeout, '读进度超时');
assert.equal(msgOf('liked').timeout, '读点赞数超时');
assert.equal(msgOf('recoPlaylist').timeout, '歌单脚本超时');
assert.equal(msgOf('nowplaying').timeout, '读播放状态超时');
ok('8 条超时/解析文案逐字一致');

// 3) 解析器
assert.deepEqual(parseLastJson('x\n{"ok":true,"t":12}\n'), { ok: true, t: 12 });
assert.equal(parseLastJson('not json'), null);
assert.deepEqual(parseResultJson('a\nRESULT_JSON {"ok":true}\n'), { ok: true });
assert.equal(parseResultJson('a\nRESULT_JSON {坏}\n'), null);
assert.equal(parseResultJson('没有标记'), null);
ok('末行 JSON / RESULT_JSON 两种解析');
assert.equal(JSON.parse(Buffer.from(payloadOf({ title: '起风了' }), 'base64').toString('utf8')).title, '起风了');
ok('payload base64 往返不丢中文');

// 4) 外壳：正常 / 非零退出 / 超时 / 起不来
const good = await runProc('chart', { args: ['-e', 'console.log(JSON.stringify({ok:true}))'] });
assert.equal(good.code, 0);
assert.equal(parseLastJson(good.out).ok, true);
ok(`正常退出 code=0 ms=${good.ms}`);

const bad = await runProc('lyric', { args: ['-e', 'console.error("boom");process.exit(3)'] });
assert.equal(bad.code, 3);
assert.ok(bad.err.includes('boom'));
ok('非零退出保留 stderr，code=3');

const slow = await runProc('progress', { args: ['-e', 'setTimeout(()=>{},1000)'], timeoutMs: 120 });
assert.equal(slow.timedOut, true);
assert.equal(slow.timeoutMs, 120);
assert.equal(slow.ms < 400, true, `超时判定太慢：${slow.ms}ms`);
ok(`超时 120ms 内判定（实测 ${slow.ms}ms）`);

const unknown = () => { try { runProc('不存在的键'); } catch (e) { return e.message; } return ''; };
assert.ok(unknown().includes('没有登记'));
ok('未登记的键直接报错，不会静默给默认值');

console.log(`\nproc 自测全部通过（${n} 项）`);
