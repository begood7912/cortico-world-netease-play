import { DATA_DIR, STATE_DIR, CACHE_DIR, LOG_DIR, state, cachePath, logPath, ensureDir, readJson, writeJson } from './src/store.js';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

let bad = 0;
const eq = (n, a, b) => { const ok = a === b; if (!ok) { bad++; console.log('  ×', n, a, '!=', b); } else console.log('  ✓', n); };

eq('DATA_DIR 就是老 data 目录', DATA_DIR.endsWith(join('coopanion-world-netease-play', 'data')), true);
eq('三类目录暂时同根', STATE_DIR === DATA_DIR && CACHE_DIR === DATA_DIR, true);
eq('state 与老路径一致', state('chain.json'), join(DATA_DIR, 'chain.json'));
eq('cachePath 与老路径一致', cachePath('chart.json'), join(DATA_DIR, 'chart.json'));
eq('logPath 落在 data/log', logPath('events.jsonl'), join(DATA_DIR, 'log', 'events.jsonl'));
eq('LOG_DIR 一致', LOG_DIR, join(DATA_DIR, 'log'));
eq('ensureDir 成功', ensureDir(LOG_DIR), true);

const dir = mkdtempSync(join(tmpdir(), 'store-'));
const f = join(dir, 'a.json');
eq('写 JSON', writeJson(f, { x: 1 }), true);
eq('读回 JSON', readJson(f, null).x, 1);
eq('坏文件回 fallback', readJson(join(dir, 'nope.json', 'x'), 'fb'), 'fb');
rmSync(dir, { recursive: true, force: true });

console.log(bad === 0 ? '\n全部通过' : `\n失败 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
