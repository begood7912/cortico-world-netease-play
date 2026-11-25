/**
 * 0.17.55 自测：天气多句解析 + 多样性挑选。
 * 跑：node _t_wx.mjs
 */
import { _parseLines, _pickDiverse } from './src/wxreco.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(`${m}（${JSON.stringify(a)}）`) : fail(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

eq(_parseLines('{"lines":["一","二","三"]}').join('|'), '一|二|三', '纯 JSON 解析');
eq(_parseLines('```json\n{"lines":["甲","乙"]}\n```').join('|'), '甲|乙', '带代码块围栏也能解析');
eq(_parseLines('{"lines":[]}').length, 0, '空数组');
eq(_parseLines('不是 JSON').length, 0, '乱文本返回空');
eq(_parseLines('{"lines":["一","二","三","四"]}').length, 3, '最多取 3 句');
eq(_parseLines('{"lines":["  「你好」  "]}')[0], '你好', '清洗引号/空白');

const list = [
  { name: 'A', artist: 'x' },
  { name: 'A2', artist: 'x' },
  { name: 'B', artist: 'y' },
  { name: 'C', artist: 'z' },
  { name: 'D', artist: 'w' },
  { name: 'E', artist: 'v' },
];
eq(_pickDiverse(list, 3).map((s) => s.name).join(','), 'A,B,C', '优先不同歌手');
eq(_pickDiverse(list, 6).length, 6, '不够时按顺序补满');
eq(_pickDiverse(list, 6).map((s) => s.name).join(','), 'A,B,C,D,E,A2', '补位仍然去重');

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
