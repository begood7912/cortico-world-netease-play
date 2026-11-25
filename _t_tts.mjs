import { settingsSnapshot, settingsOptions, settingsSet } from './src/settingspanel.js';
import { voicesCached } from './src/winvoice.js';

const sh = (o, zh) => JSON.stringify(o, null, 0);
const g = settingsOptions('zh', { ttsEngine: 'gpt' });
const w = settingsOptions('zh', { ttsEngine: 'windows' });
console.log('引擎下拉:', sh(g.ttsEngine));
console.log('gpt 音色:', sh(g.ttsVoice));
console.log('windows 音色数:', w.ttsVoice.length, '| 首项:', sh(w.ttsVoice[0]));
const cfg = { ttsEngine: 'windows' };
const r1 = settingsSet({}, cfg, { key: 'ttsEngine', value: 'azure' });
console.log('写歪引擎 →', r1.values.ttsEngine);
const r2 = settingsSet({}, { ttsEngine: 'gpt', ttsVoice: 'Microsoft Zira Desktop' }, { key: 'ttsVoice', value: 'Microsoft Zira Desktop' });
console.log('gpt 下写音色 →', JSON.stringify(r2.values.ttsVoice));
const snap = settingsSnapshot({ ttsEngine: 'windows' }, 'zh', {});
console.log('快照里 ttsEngine/ttsVoice:', snap.values.ttsEngine, snap.options.ttsVoice.length, 'system voices:', voicesCached().voices.length);
