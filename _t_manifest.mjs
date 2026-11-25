import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST, AFFECTS, ENDPOINTS, cap, route, isExternal, manifestSummary, assertRoutable } from './src/manifest.js';

const ROOT = path.resolve('.');
const SRC = path.join(ROOT, 'src');

let bad = 0;
const fail = (m) => { console.log('[FAIL] ' + m); bad++; };
const ok = (m) => console.log('[ OK ] ' + m);

// 1 ID 唯一
const ids = MANIFEST.map((b) => b.id);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
dup.length ? fail('重复的块 id：' + dup.join(',')) : ok('块 id 唯一（' + ids.length + ' 块）');

// 2 affects 合法
for (const b of MANIFEST) {
  for (const a of b.affects || []) if (!AFFECTS.includes(a)) fail(`${b.id} 的 affects 里有未定义的影响面：${a}`);
}
ok('affects 全部在允许清单内');

// 3 对端声明合法
for (const b of MANIFEST) {
  if (b.kind === 'internal' && (b.endpoints || []).length) fail(`${b.id} 是 internal 却声明了 endpoints`);
  if (b.kind !== 'internal' && !(b.endpoints || []).length) fail(`${b.id} 是 ${b.kind} 却没有 endpoints`);
  for (const e of b.endpoints || []) if (!ENDPOINTS[e]) fail(`${b.id} 声明了未知对端：${e}`);
}
ok('对端声明合法');

// 4 entry 文件真实存在
for (const b of MANIFEST) {
  if (b.status !== 'current') continue;
  if (!b.entry.length) fail(`${b.id} 标为 current 却没有 entry`);
  for (const f of b.entry) {
    if (!fs.existsSync(path.join(SRC, f))) fail(`${b.id} 的 entry 不存在：${f}`);
  }
}
ok('current 块的 entry 文件都存在');

// 5 每个 src 模块至少被登记一次（manifest.js 自身除外）
const all = fs.readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'manifest.js');
const listed = new Set(MANIFEST.flatMap((b) => b.entry));
const missing = all.filter((f) => !listed.has(f));
missing.length ? fail('没有归属的模块：' + missing.join(', ')) : ok('全部 src 模块都有归属（' + all.length + ' 个）');

// 6 路由示例
console.log('\n--- route 示例 ---');
for (const id of ['chain', 'cards', 'voice', 'netease']) {
  const r = route(id);
  console.log(id.padEnd(8), r.ok ? `${r.kind.padEnd(8)} 对端=[${r.endpoints.join(',') || '-'}]` : r.error);
}

// 7 两栏
const s = manifestSummary();
console.log('\n--- 分栏 ---');
console.log('内部块 ' + s.internal.length + '：' + s.internal.map((b) => b.id).join(', '));
console.log('对端块 ' + s.external.length + '：' + s.external.map((b) => `${b.id}(${b.endpoints.join('/')})`).join(', '));
console.log('对端 ' + s.endpoints.length + '：' + s.endpoints.join(', '));

// 8 反向：内部块不许引用 adapters
try { for (const b of MANIFEST.filter((x) => x.kind === 'internal')) assertRoutable(b.id); ok('内部块未引用 adapters'); }
catch (e) { fail(e.message); }

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
