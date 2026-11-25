/**
 * 0.17.39 自测：来源开关（chainSource）是唯一真源。
 *
 * 覆盖：
 *   1. activeSource / isHistoryActive / isWeatherActive 的翻译
 *   2. 选「按天气」时，历史推荐那条链路**一次都不算**（generateRecommend 立刻返回 inactive）
 *   3. 选「听歌历史」时，天气那条链路**一次都不算**（peekWxReco 立刻返回 inactive）
 *   4. 设置页换来源不报错（会清两边缓存、清接力里的旧承诺）
 *
 * 跑：node _t_source.mjs
 */
import { activeSource, isHistoryActive, isWeatherActive, normalizeSource } from './src/source.js';
import { generateRecommend } from './src/recommend.js';
import { peekWxReco } from './src/wxreco.js';
import { weatherNow, fetchWeather, peekWeather } from './src/qweather.js';
import { settingsSet } from './src/settingspanel.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(`${m}（${JSON.stringify(a)}）`) : fail(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

const hist = { chainSource: 'reco' };
const wx = { chainSource: 'wx' };
const none = {};

// 1. 翻译
eq(activeSource(hist), 'history', 'chainSource=reco → history');
eq(activeSource(wx), 'weather', 'chainSource=wx → weather');
eq(activeSource(none), 'history', '没设置 → 默认 history');
eq(isHistoryActive(hist) && !isWeatherActive(hist), true, 'hist 两问一致');
eq(isWeatherActive(wx) && !isHistoryActive(wx), true, 'wx 两问一致');
eq(normalizeSource('wx'), 'weather', '旧值 wx 归一');
eq(normalizeSource('reco'), 'history', '旧值 reco 归一');
eq(normalizeSource('nonsense'), '', '未知值归一为空');

// 2. 天气模式下历史不刷
const r1 = await generateRecommend(wx);
eq(r1 && r1.reason, 'inactive', '天气模式下 generateRecommend 不算');

// 3. 历史模式下天气不算（不 kick、直接 inactive）
const s1 = peekWxReco(hist, { kick: false });
eq(s1 && s1.reason, 'inactive', '历史模式下 peekWxReco 不算');
eq(Array.isArray(s1.items) && s1.items.length === 0, true, 'inactive 时不给数据');

// 3b. 0.17.40：读天气只读缓存，抓取只有 fetchWeather 一个入口
//     （有缓存时 peekWeather 与 weatherNow(force:false) 必须返回同一份对象；没缓存时必须返回 ok:false）
const cached = peekWeather();
const w0 = await weatherNow({}, { force: false });
// peekWeather 每次返回新对象（带 at），所以比内容不比引用
const readOnly = (cached && cached.ok)
  ? !!(w0 && w0.ok && w0.at === cached.at && w0.now && cached.now && w0.now.text === cached.now.text)
  : !!(w0 && w0.ok === false);
eq(readOnly, true, 'weatherNow(force:false) 只读缓存、不抓远端');
const w1 = await fetchWeather({});
eq(w1 && w1.error, '还没填 API Key', '没 key 时 fetchWeather 不发请求');

// 4. 设置页切来源不炸、值落到位
//    注意：这一步会调 clearSourceState / invalidateRecommend —— 在本包目录里跑会动 data/ 下的
//    真实缓存（chain.json 里的预告会被清掉）。默认跳过，要跑就设 NCM_TEST_LIVE=1。
if (process.env.NCM_TEST_LIVE === '1') {
  const cfg = { chainSource: 'reco' };
  const ctx = { persist: () => {} };
  const out = settingsSet(ctx, cfg, { key: 'chainSource', value: 'wx' });
  eq(out && out.ok, true, 'settingsSet(chainSource=wx) 成功');
  eq(cfg.chainSource, 'wx', '配置已就地更新');
  const out2 = settingsSet(ctx, cfg, { key: 'chainSource', value: '啥也不是' });
  eq(cfg.chainSource, 'reco', '写歪的值回落到 reco');
  eq(out2 && out2.ok, true, '回落也算成功');
} else {
  console.log('[SKIP] 设置页切换会动 data/ 下的真实缓存；要跑请设 NCM_TEST_LIVE=1');
}

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
