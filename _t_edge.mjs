import { speak, stopSpeaking } from './src/speak.js';
import * as edgevoice from './src/edgevoice.js';

const say = '你好，我是晓晓。今天天气晴，适合听一首慢歌。';
const r1 = await edgevoice.refreshVoices();
console.log('语音列表:', r1.voices.length, '个中文音色');
console.log('下拉前三项:', edgevoice.zhVoiceOptions(true).slice(0, 3));
console.log('python 可用:', await edgevoice.pythonReady());

const ret = await speak({ text: say, engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', timeoutMs: 25000 });
console.log('speak 返回:', ret);
