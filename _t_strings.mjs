import { TEXT, text, texts, lintStrings } from './src/strings.js';
import { settingsSnapshot } from './src/settingspanel.js';
import { MANIFEST } from './src/manifest.js';

let bad = 0;
const eq = (name, a, b) => {
  const ok = a === b;
  if (!ok) { bad++; console.log('  ×', name, '|', a, '!=', b); }
  else console.log('  ✓', name);
};

const ids = Object.keys(TEXT);
eq('ID 总数 78（39 项 × 标题/说明）', ids.length, 78);
eq('lint 无问题', lintStrings().length, 0);
eq('中文取用', text('set.chainSpeak.title'), '接力时念一句「即将播放…」');
eq('英文取用', text('set.chainSpeak.title', { lang: 'en' }), 'Announce the next song');
eq('缺键回显 ID', text('set.nothere.desc'), 'set.nothere.desc');
eq('整包中文条数', Object.keys(texts('zh')).length, 78);

const snap = settingsSnapshot({}, 'zh');
eq('快照带 texts', Object.keys(snap.texts || {}).length, 78);
eq('快照英文', settingsSnapshot({}, 'en').texts['set.cardsOn.title'], 'All three at once');
eq('快照里键与 schema 一致',
  Object.keys(snap.texts).filter((k) => k.endsWith('.title')).length,
  MANIFEST.length > 0 ? 39 : 0);

for (const id of ids) {
  if (typeof TEXT[id].zh !== 'string' || typeof TEXT[id].en !== 'string') { bad++; console.log('  × 类型', id); }
}

// 前端那一侧：GROUPS 里的每个 key 都必须在中英两栏都取得到
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('./webui/panel.js', 'utf8');
  // 0.17.30：不再写死行号（一插代码就切错段）；按 GROUPS 这个数组的首尾定位
  const from = src.indexOf('const GROUPS = [');
  const to = src.indexOf('];', from);
  const lines = src.slice(from, to).split('\n');
  const keys = lines.filter((l) => l.includes("key: '")).map((l) => /key: '([A-Za-z]+)'/.exec(l)[1]);
  const missing = keys.filter((k) => !TEXT[`set.${k}.title`] || !TEXT[`set.${k}.desc`]);
  eq(`前端 ${keys.length} 个键全部有 title/desc`, missing.length, 0);
  if (missing.length) console.log('    缺：', missing.join(', '));
  eq('前端条目行已无 zh ? 字面量标题', lines.filter((l) => l.includes("key: '")).filter((l) => l.includes("title: zh ?")).length, 0);
  console.log('  · 卡片级仍保留字面量（5 张卡）:', lines.filter((l) => l.includes("title: zh ?")).length);
}

console.log(bad === 0 ? '\n全部通过' : `\n失败 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);


