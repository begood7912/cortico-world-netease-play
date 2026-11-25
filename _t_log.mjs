import { event, external, externalOk, LOG_PATHS } from './src/log.js';
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';

let bad = 0;
const eq = (n, a, b) => { const ok = a === b; if (!ok) { bad++; console.log('  ×', n, a, '!=', b); } else console.log('  ✓', n); };

eq('目录建立', existsSync(LOG_PATHS.dir), true);
event('test.envelope', { k: 1, name: 'x' });
external('netease', 'play', { why: 'test' });
externalOk('model', 'refresh');
const lines = readFileSync(LOG_PATHS.events, 'utf8').trim().split('\n');
const last = JSON.parse(lines[lines.length - 1]);
eq('信封有 at', typeof last.at, 'number');
eq('信封有 type', last.type, 'test.envelope');
eq('字段平铺', last.name, 'x');
const ext = readFileSync(LOG_PATHS.external, 'utf8').trim().split('\n');
const extLast = JSON.parse(ext[ext.length - 1]);
eq('对端记录 endpoint', extLast.endpoint, 'model');
eq('对端记录 ok=true', extLast.ok, true);

// 全量 import：41 个模块逐个加载，坏一个就报出来
const mods = readdirSync('./src').filter((f) => f.endsWith('.js')).sort();
const broken = [];
for (const m of mods) {
  try { await import('./src/' + m); } catch (e) { broken.push(m + ': ' + (e && e.message)); }
}
eq(`全模块 import（${mods.length} 个）`, broken.length, 0);
if (broken.length) console.log(broken.join('\n'));

console.log(bad === 0 ? '\n全部通过' : `\n失败 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
