/**
 * 0.17.66 自测：`src/world.js` 里不能出现「调用了但根本没定义」的函数。
 *
 * 起因（0.17.61 的遗留，0.17.66 修）：`sayIdle()` 里多了一句 `if (bootGuardHit(c))`，
 * 而 `bootGuardHit` 从来没定义过 —— 每次安静到点都抛 ReferenceError，
 * 被采样器的 `.catch(() => {})` 吞掉：桌宠一声不出、也没有「要放歌吗」三个选项的窗口，
 * 而日志里一行线索都没有。`node --check` 只查语法，查不出这种。
 *
 * 做法：把 world.js 里所有「前面没有点号」的调用名收集起来，逐个要求在
 *   ① world.js 内有定义（function / const / let / class 方法）
 *   ② 或从别的模块 import 进来
 *   ③ 或是内置全局
 * 找不到就报失败。
 *
 * 用法：node _t_world_refs.mjs
 */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORLD = 'src/world.js';
const src = readFileSync(WORLD, 'utf8');
// 去掉注释和字符串字面量，免得里面的名字被当成调用
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');

/** 所有 src 下的源码（查「别的模块导出了没有」）。 */
const SRC = 'src';
const others = readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'world.js')
  .map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'await',
  'import', 'require', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math',
  'Date', 'Promise', 'Set', 'Map', 'Error', 'parseInt', 'parseFloat', 'isNaN',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'encodeURIComponent',
  'decodeURIComponent', 'console', 'super', 'constructor', 'async', 'key',
]);

const called = new Set();
// 前面不是「. / 单词字符」才算独立调用（排除 obj.method() 这种）
for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]{2,})\s*\(/g)) called.add(m[1]);

const definedHere = new Set();
for (const m of code.matchAll(/(?:function\s+|const\s+|let\s+|var\s+|async\s+|get\s+)([A-Za-z_$][\w$]*)\s*[=(]/g)) {
  definedHere.add(m[1]);
}
// class 方法：`  async sayIdle({ ... }) {`
for (const m of code.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/gm)) {
  definedHere.add(m[1]);
}
const imported = new Set();
for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
  m[1].split(',').forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop().trim(); if (n) imported.add(n); });
}

const missing = [];
for (const n of called) {
  if (GLOBALS.has(n) || definedHere.has(n) || imported.has(n)) continue;
  // 别的模块导出的
  if (new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${n}\\b`).test(others)) continue;
  missing.push(n);
}

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`[ OK ] ${name}`); } else { fail += 1; console.log(`[FAIL] ${name} ${extra}`); }
};

check(`world.js 里没有未定义调用（扫了 ${called.size} 个名字）`, missing.length === 0, `可疑：${missing.join(', ')}`);
check('bootGuardHit 这类幽灵函数已清干净', !/\bbootGuardHit\s*\(/.test(code));

console.log(`\n${fail ? '有失败' : '全部通过'}：${pass} 通过，${fail} 失败。`);
process.exit(fail ? 1 : 0);
