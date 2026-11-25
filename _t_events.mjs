/**
 * 0.17.58：事件标注自测。
 *
 * 用假宿主接住 pushEvent 的入参，核对五件事：
 *   1. type 是 `<world>.<name>`（netease-play.ask / netease-play.her-line）；
 *   2. trigger 是 flush（不抢轮、也不被合批压住）；
 *   3. tags 分别是 snapshot / speak（都在契约允许的两个值里）；
 *   4. origin 显式写了 external；senderKey 带具体键（不是和 type 同值的常量）；
 *   5. 正文是陈述句（旧的「这一条照做就行 / 不要自己判断」已搬进 ENV_PROMPT.md）。
 *
 * 跑：node _t_events.mjs
 */
import { readFileSync } from 'node:fs';
import { NeteasePlayWorld } from './src/world.js';
import { ASK_EVENT, HER_LINE_EVENT } from './src/events.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(m) : fail(`${m}：得到 ${JSON.stringify(a)}，应为 ${JSON.stringify(b)}`));

const pushed = [];
const world = new NeteasePlayWorld({ id: 'netease-play', botName: '菱', cfg: {} });
world._host = {
  pushEvent: async (e, opts) => { pushed.push({ e, opts }); return { cursor: pushed.length }; },
};

// 1. 她要说的一句话
const r1 = await world.pushHerLine('那我就先放《有我呢》了，唱完我接着挑。', { kind: 'queue-start' });
if (!r1.ok) fail('pushHerLine 没推出去：' + JSON.stringify(r1));
const h = pushed[pushed.length - 1];
eq(h.e.type, 'netease-play.her-line', 'her-line 的 type');
eq(h.opts && h.opts.trigger, 'flush', 'her-line 的 trigger 是 flush');
eq(JSON.stringify(h.e.tags), JSON.stringify(['speak']), 'her-line 的 tags 是 [speak]');
eq(h.e.origin, 'external', 'her-line 显式写了 origin=external');
eq(h.e.senderKey, 'netease-play.her-line:queue-start', 'her-line 的 senderKey 带 kind');
if (!h.e.text.includes('那我就先放《有我呢》了')) fail('her-line 正文没带上她这句话');
if (h.e.text.includes('不要复述旁白')) fail('her-line 还留着旧的命令式旁白');

// 2. 安静太久 → 请她开口 + 弹窗
const r2 = await world.pushAskBubble({
  pick: { name: '有我呢', artist: '郭一凡', id: '1758612597' },
  minutes: 30,
  flavor: '夜里想听点能跟着哼的',
  say: '现在太安静了。我想听《有我呢》，要我帮你放吗？',
});
if (!r2.ok) fail('pushAskBubble 没推出去：' + JSON.stringify(r2));
const a = pushed[pushed.length - 1];
eq(a.e.type, 'netease-play.ask', 'ask 的 type');
eq(a.opts && a.opts.trigger, 'flush', 'ask 的 trigger 是 flush');
eq(JSON.stringify(a.e.tags), JSON.stringify(['snapshot']), 'ask 的 tags 是 [snapshot]');
eq(a.e.origin, 'external', 'ask 显式写了 origin=external');
eq(a.e.senderKey, 'netease-play.ask:1758612597', 'ask 的 senderKey 带歌曲 id');
if (!a.e.text.includes('现在太安静了。我想听《有我呢》')) fail('ask 正文没带上她那句话');
if (!a.e.text.includes('要放歌吗？')) fail('ask 正文没写弹窗标题');
if (a.e.text.includes('这一条照做就行') || a.e.text.includes('不要自己判断要不要跳过')) {
  fail('ask 正文还留着旧的命令口吻');
}
if (!a.e.text.includes('环境提示词')) fail('ask 正文没指向环境提示词里的规则');

// 3. 源码里不该再出现旧的标注
const wj = readFileSync('./src/world.js', 'utf8');
for (const badWord of ["trigger: 'interrupt'", "trigger: 'debounce'", "type: 'netease-ask'", "type: 'netease-her-line'"]) {
  if (wj.includes(badWord)) fail(`world.js 里还有旧的标注：${badWord}`);
}

// 4. 声明本身合法
eq(ASK_EVENT.trigger, 'flush', 'ASK_EVENT.trigger');
eq(JSON.stringify(ASK_EVENT.tags), JSON.stringify(['snapshot']), 'ASK_EVENT.tags');
eq(HER_LINE_EVENT.trigger, 'flush', 'HER_LINE_EVENT.trigger');
eq(JSON.stringify(HER_LINE_EVENT.tags), JSON.stringify(['speak']), 'HER_LINE_EVENT.tags');

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
