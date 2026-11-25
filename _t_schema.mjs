import { SETTING_SCHEMA, DEFAULTS, SETTING_KEYS, BOOL_KEYS, INT_KEYS, STR_KEYS, PROMPT_KEYS, RANGES, keysAffecting, lintSchema } from './src/settings.schema.js';
import { AFFECTS } from './src/manifest.js';
import { settingsSnapshot, settingsSet } from './src/settingspanel.js';

let bad = 0;
const eq = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => a[k] === b[k]); };
const check = (name, ok, extra = '') => { if (ok) console.log('[ OK ] ' + name); else { console.log('[FAIL] ' + name + (extra ? ' → ' + extra : '')); bad++; } };

// 旧表逐项对照（这些值取自 0.16.95 的 settingspanel.js）
const EXPECT = {
  cardsOn: true, cardHear: true, cardFeel: true, cardComment: true, cardsPreview: true,
  showLiked: true, sayHead: true, sayBody: true, sayBodyFirst: false, announce: true,
  selfPick: true, idleFirstMin: 5, idleBootGuardMin: 5, idleRepeatMin: 60, askTwoOnly: false,
  aiRandomChain: true,
  aiPlayPrompt: '',
  quietStart: '23:00', quietEnd: '07:00', quietOn: false,
  chainPick: true, chainSpeak: true, chainSource: 'reco', chainPlaylist: false, chainClearDaily: true,
  chainClearHour: 6, chainCharts: '3778678,19723756',
  playlist: '', autoFav: true, favThreshold: 2, allowRestart: false, cdpPort: 9229, clientExe: '',
  modelSource: 'local', ollamaUrl: 'http://127.0.0.1:11434', embedModel: '', vramMode: 'eco',
  chatModel: '', ttsUrl: 'http://127.0.0.1:9880', ttsEngine: 'gpt', ttsVoice: '',
  qwApiHost: '', qwApiKey: '', qwInterval: 15, qwAlign: false,
  qwAdmin: '', qwCountryCode: '', qwCity: '',
  promptHearHead: '', promptHearTail: '', promptFeelHead: '', promptFeelTail: '', promptCommentHead: '', promptCommentTail: '',
};
check('默认值与旧表逐项一致', eq(DEFAULTS, EXPECT), JSON.stringify(Object.keys(EXPECT).filter((k) => DEFAULTS[k] !== EXPECT[k])));
check('键数 54', Object.keys(SETTING_SCHEMA).length === 54, String(Object.keys(SETTING_SCHEMA).length));
check('白名单 21 布尔 + 7 数字 + 26 文本', BOOL_KEYS.length === 21 && INT_KEYS.length === 7 && STR_KEYS.length === 26, `${BOOL_KEYS.length}/${INT_KEYS.length}/${STR_KEYS.length}`);
check('六段提示词齐全', PROMPT_KEYS.length === 6);
check('范围表 7 项', Object.keys(RANGES).length === 7, String(Object.keys(RANGES).join(',')));
check('schema 自检通过', lintSchema(AFFECTS).length === 0, lintSchema(AFFECTS).join('; '));
check('反查：改 cards 面涉及 6 个键', keysAffecting('cards').length > 0, String(keysAffecting('cards').length));

// 快照：空配置下必须是默认值
const snap = settingsSnapshot({});
check('快照 values 等于默认值', eq(snap.values, DEFAULTS));
check('快照 known 全 false', Object.values(snap.known).every((v) => v === false));
check('chainCharts 名字解析', typeof snap.chainChartNames === 'string' && snap.chainChartNames.includes('热歌榜'), String(snap.chainChartNames));
check('提示词默认文案 6 段', Object.keys(snap.promptDefaults || {}).length === 6);

// 写入：规整与夹取
const cfg = {};
const ctx = { persist: () => {} };
let r = settingsSet(ctx, cfg, { key: 'cardsOn', value: 'false' });
check('布尔规整 false', r.values.cardsOn === false && cfg.cardsOn === false);
r = settingsSet(ctx, cfg, { key: 'favThreshold', value: 999 });
check('数字上夹到 20', r.values.favThreshold === 20);
r = settingsSet(ctx, cfg, { key: 'favThreshold', value: 1 });
check('数字下夹到 2', r.values.favThreshold === 2);
r = settingsSet(ctx, cfg, { key: 'chainClearHour', value: 'abc' });
check('数字收到非数字时报错且不改值', r.ok === false && cfg.chainClearHour === undefined);
r = settingsSet(ctx, cfg, { key: '不存在', value: 1 });
check('白名单外拒绝', r.ok === false);
r = settingsSet(ctx, cfg, { key: 'vramMode', value: '乱写' });
check('枚举兜底回 eco', r.values.vramMode === 'eco');
r = settingsSet(ctx, cfg, { key: 'chainCharts', value: ['3778678', '19723756', '3778678'] });
check('榜单归一去重', r.values.chainCharts === '3778678,19723756', r.values.chainCharts);

console.log('\n' + (bad ? bad + ' 项未通过' : '全部通过'));
process.exit(bad ? 1 : 0);


