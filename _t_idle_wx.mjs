/**
 * 0.17.61 自测：天气源打开时，安静提示是不是「天气句在前、突然想到一首歌在后」，
 * 以及「开机加载期不发」这条闸。
 *
 * 用法：node _t_idle_wx.mjs
 */
import { readFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { buildIdle, bootedRecently } from './src/idle.js';
import { peekWxReco } from './src/wxreco.js';
import { DEFAULTS } from './src/settings.schema.js';

const HOST_CFG = 'D:/Programs/Coopanion/data/home/companion/config.json';
const cfg = { ...DEFAULTS };
try {
  const j = JSON.parse(readFileSync(HOST_CFG, 'utf8'));
  Object.assign(cfg, j.worlds && j.worlds['netease-play'] ? j.worlds['netease-play'] : {});
} catch (e) {
  console.log(`读不到宿主配置（${e.message}），用默认值跑`);
}
cfg.chainSource = 'wx';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`[ OK ] ${name}`); } else { fail += 1; console.log(`[FAIL] ${name} ${extra}`); }
};

// ① 开机闸：现在这台机器早就开过机，5 分钟闸必须放行
check('开机 5 分钟内拦（用一个肯定小于 uptime 的阈值反证）', bootedRecently(uptime() / 60 + 1) === true);
check('开机 5 分钟闸现在放行', bootedRecently(5) === false);
check('阈值 0 = 不拦', bootedRecently(0) === false);

// ② 先把天气快照热起来（真机启动时是启动即算，这里手动等它算完）
let snap = peekWxReco(cfg, { kick: true });
const deadline = Date.now() + 60000;
while ((!snap || !snap.ok || !snap.line) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  snap = peekWxReco(cfg, { kick: false });
}
console.log(`\n天气快照：ok=${snap && snap.ok} line=${(snap && snap.line) || '（空）'} reason=${(snap && snap.reason) || ''}\n`);
check('天气快照算出来了', !!(snap && snap.ok && snap.line), JSON.stringify(snap && { reason: snap.reason, error: snap.error }));
const t0 = Date.now();
for (let i = 1; i <= 5; i += 1) {
  const r = await buildIdle({ cfg, persona: '', idleSec: 60 });
  const okShape = r.flavorFrom === 'wx' && /。$|！$|？$/.test(r.flavor) !== null;
  console.log(`\n#${i} ${r.spoken}\n     pick=${r.pick && r.pick.name} flavorFrom=${r.flavorFrom} brief=${r.brief || '（无）'} (${[...String(r.brief || '')].length} 字)`);
  check(`第 ${i} 句用天气构成`, r.flavorFrom === 'wx', `实际 ${r.flavorFrom}`);
  check(`第 ${i} 句给了 AI 的天气说明（20~60 字）`, [...String(r.brief || '')].length >= 20 && [...String(r.brief || '')].length <= 60, `${[...String(r.brief || '')].length} 字`);
  check(`第 ${i} 句前半句 ≤26 字`, [...String(r.flavor || '')].length <= 27, `${[...String(r.flavor || '')].length} 字`);
  check(`第 ${i} 句是「天气 → 突然想到一首歌《X》」`, /^.+。突然想到一首歌《.+》。要我帮你放吗？$/.test(r.spoken) || /突然想到一首歌.+要我帮你放吗？/.test(r.spoken), r.spoken);
  check(`第 ${i} 句没再出现「我想听」`, !r.spoken.includes('我想听'));
  check(`第 ${i} 句不太长（≤60 字）`, [...r.spoken.replace(/\s/g, '')].length <= 60, `${[...r.spoken].length} 字`);
}

console.log(`\n合计耗时 ${Date.now() - t0} ms`);
console.log(`\n${fail ? '有失败' : '全部通过'}：${pass} 通过，${fail} 失败。`);
process.exit(fail ? 1 : 0);
