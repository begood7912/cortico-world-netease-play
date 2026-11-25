/**
 * 0.17.62 自测：第一次开口的等待秒数。
 * 用户口径：二选一选「按天气听点什么」以后，5 分钟以内不许（填 1~4 一律按 5）。
 * 用法：node _t_idle_floor.mjs
 */
import { firstAskSec } from './src/idle.js';
import { settingsSet } from './src/settingspanel.js';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  if (got === want) { pass += 1; console.log(`[ OK ] ${name} = ${got}`); } else {
    fail += 1; console.log(`[FAIL] ${name}：期望 ${want}，实际 ${got}`);
  }
};

check('天气源 + 填 1 分钟 → 5 分钟', firstAskSec({ chainSource: 'wx', idleFirstMin: 1 }), 300);
check('天气源 + 填 4 分钟 → 5 分钟', firstAskSec({ chainSource: 'wx', idleFirstMin: 4 }), 300);
check('天气源 + 填 5 分钟 → 不变', firstAskSec({ chainSource: 'wx', idleFirstMin: 5 }), 300);
check('天气源 + 填 10 分钟 → 600 秒', firstAskSec({ chainSource: 'wx', idleFirstMin: 10 }), 600);
check('历史源 + 填 1 分钟 → 60 秒（不顶）', firstAskSec({ chainSource: 'reco', idleFirstMin: 1 }), 60);
check('缺省值 → 5 分钟', firstAskSec({}), 300);
check('关掉她自己开口 → 0', firstAskSec({ chainSource: 'wx', selfPick: false }), 0);

// 写入时也夹：宿主设置页和自家面板走的都是 settingsSet
const cfg = { chainSource: 'wx', idleFirstMin: 3 };
let r = settingsSet({ persist: (p) => Object.assign(cfg, p) }, cfg, { key: 'idleFirstMin', value: 2 });
check('天气源下填 2 → 存成 5', cfg.idleFirstMin === 5 && r.ok === true, true);
const cfg2 = { chainSource: 'reco', idleFirstMin: 2 };
r = settingsSet({ persist: (p) => Object.assign(cfg2, p) }, cfg2, { key: 'chainSource', value: 'wx' });
check('历史源 2 分钟时切到天气 → 顺手写回 5', cfg2.idleFirstMin === 5 && r.ok === true, true);

console.log(`\n${fail ? '有失败' : '全部通过'}：${pass} 通过，${fail} 失败。`);
process.exit(fail ? 1 : 0);
