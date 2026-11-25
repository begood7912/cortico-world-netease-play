/**
 * quietHours 自测（不进包）：窗口判定 + 安静时间里的播报闸。
 */
import assert from 'node:assert/strict';
import { parseHM, normHM, inQuietHours, quietLabel } from './src/quietHours.js';
import { NeteasePlayWorld } from './src/world.js';

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const at = (h, m = 0) => new Date(2026, 10, 24, h, m, 0, 0);

// 1) 解析
assert.equal(parseHM('23:00'), 1380);
assert.equal(parseHM('7:30'), 450);
assert.equal(parseHM('07：30'), 450);
assert.equal(parseHM('24:00'), null);
assert.equal(parseHM('2360'), null);
assert.equal(parseHM(''), null);
ok('HH:MM 解析（含全角冒号、越界、空串）');
assert.equal(normHM('7:05', 'x'), '07:05');
assert.equal(normHM('7:5', 'x'), 'x');
assert.equal(normHM('乱写', '23:00'), '23:00');
ok('规整成 HH:MM，写错退回 fallback');

// 2) 跨夜窗口 23:00 - 07:00
const night = { quietOn: true, quietStart: '23:00', quietEnd: '07:00' };
assert.equal(inQuietHours(night, at(23, 0)), true);
assert.equal(inQuietHours(night, at(2, 30)), true);
assert.equal(inQuietHours(night, at(6, 59)), true);
assert.equal(inQuietHours(night, at(7, 0)), false);
assert.equal(inQuietHours(night, at(12, 0)), false);
assert.equal(inQuietHours(night, at(22, 59)), false);
ok('跨零点窗口（23:00–07:00）边界正确');

// 3) 当天窗口 09:00 - 18:00
const day = { quietOn: true, quietStart: '09:00', quietEnd: '18:00' };
assert.equal(inQuietHours(day, at(10, 0)), true);
assert.equal(inQuietHours(day, at(8, 59)), false);
assert.equal(inQuietHours(day, at(18, 0)), false);
ok('当天窗口（09:00–18:00）边界正确');

// 4) 关掉 / 起止相同 / 写错 → 一律出声
assert.equal(inQuietHours({ ...night, quietOn: false }, at(2, 0)), false);
assert.equal(inQuietHours({ quietOn: true, quietStart: '00:00', quietEnd: '00:00' }, at(3, 0)), false);
assert.equal(inQuietHours({ quietOn: true, quietStart: '瞎写', quietEnd: '07:00' }, at(3, 0)), false);
assert.equal(inQuietHours({}, at(3, 0)), false);
ok('开关没开 / 起止相同 / 写错 → 不当安静时间');
assert.equal(quietLabel(night), '23:00 – 07:00');
ok('短句 23:00 – 07:00');

// 5) 世界层：安静时间里 say* 一律不出声（不合成、不调模型）
const cfg = { ...night, ttsUrl: 'http://127.0.0.1:9880' };
// 把系统时间挪到 02:30 —— 这些 say* 用的是 Date.now() 默认值
const realNow = Date.now;
Date.now = () => at(2, 30).getTime();
try {
  const w = new NeteasePlayWorld({ cfg, botDir: '' });
  const chain = await w.sayChain({ next: { name: '起风了', artist: '买辣椒也用券' }, left: 30 });
  assert.equal(chain.reason, 'quiet-hours');
  const idle = await w.sayIdle({ idleSec: 600 });
  assert.equal(idle.reason, 'quiet-hours');
  const about = await w.sayAbout({ title: '起风了', artist: '买辣椒也用券' });
  assert.equal(about.reason, 'quiet-hours');
  ok('安静时间里 sayChain / sayIdle / sayAbout 都返回 quiet-hours');
} finally {
  Date.now = realNow;
}

// 6) 窗口外照旧走（这里只证明闸没误伤：没有模型时会返回 no-model，而不是 quiet）
Date.now = () => at(12, 0).getTime();
try {
  const w = new NeteasePlayWorld({ cfg, botDir: '' });
  const chain = await w.sayChain({ next: { name: '起风了', artist: '' }, left: 30 });
  assert.notEqual(chain.reason, 'quiet-hours');
  ok('窗口外不拦（sayChain 走到正常分支）');
} finally {
  Date.now = realNow;
}

console.log(`\nquietHours 自测全部通过（${n} 项）`);
