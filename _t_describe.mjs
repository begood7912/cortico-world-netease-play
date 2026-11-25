/**
 * 0.17.45（D5）：校验 describe.json 与代码一致。
 *
 * 宿主的 `check:extension` 做的是同一件事（跑不了宿主 CLI 时用这个兜底）：
 *   1. describe.tools 覆盖 tools() 的全部工具；
 *   2. 每个工具的 description / parameters 与代码一致；
 *   3. prompts 里的 envPrompt 全文 === ENV_PROMPT.md。
 *
 * 跑：node _t_describe.mjs
 */
import { readFileSync } from 'node:fs';
import def from './src/index.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(m) : fail(`${m}：不一致`));

const desc = JSON.parse(readFileSync('./describe.json', 'utf8'));
const code = def.describe.tools;

eq(Array.isArray(desc.tools), true, 'describe.tools 是数组');
eq(desc.tools.length, code.length, `工具数量一致（${code.length}）`);

const byName = new Map(desc.tools.map((t) => [t.name, t]));
for (const t of code) {
  const d = byName.get(t.name);
  if (!d) { fail(`describe 缺少工具：${t.name}`); continue; }
  eq(d.description, t.description, `${t.name} 的 description 一致`);
  eq(JSON.stringify(d.parameters), JSON.stringify(t.parameters), `${t.name} 的 parameters 一致`);
  if (t.summary) eq(JSON.stringify(d.summary), JSON.stringify(t.summary), `${t.name} 的 summary 一致`);
}
for (const name of byName.keys()) {
  if (!code.some((t) => t.name === name)) fail(`describe 多出工具：${name}`);
}

// 0.17.58：事件自描述 —— describe.events 必须覆盖代码里的全部事件，trigger/tags 取自同一份声明
const codeEvents = def.describe.events || [];
const descEvents = desc.events || [];
eq(Array.isArray(descEvents), true, 'describe.events 是数组');
eq(descEvents.length, codeEvents.length, `事件数量一致（${codeEvents.length}）`);
const byType = new Map(descEvents.map((e) => [e.type, e]));
for (const e of codeEvents) {
  const d = byType.get(e.type);
  if (!d) { fail(`describe 缺少事件：${e.type}`); continue; }
  eq(d.trigger, e.trigger, `${e.type} 的 trigger 一致`);
  eq(JSON.stringify(d.tags), JSON.stringify(e.tags), `${e.type} 的 tags 一致`);
  if (!/^[a-z0-9-]+\./.test(e.type)) fail(`事件 type 不合 <world>.<name> 惯例：${e.type}`);
  if (!Array.isArray(e.tags) || !e.tags.length) fail(`事件没写 tags：${e.type}`);
  for (const tag of e.tags || []) if (!['snapshot', 'speak'].includes(tag)) fail(`${e.type} 的 tags 有非法值：${tag}`);
  if (!['preempt', 'interrupt', 'flush', 'debounce', 'piggyback'].includes(e.trigger)) fail(`${e.type} 的 trigger 非法：${e.trigger}`);
}
for (const t of byType.keys()) if (!codeEvents.some((e) => e.type === t)) fail(`describe 多出事件：${t}`);

const env = readFileSync('./ENV_PROMPT.md', 'utf8');
const p = (desc.prompts || []).find((x) => x && x.role === 'envPrompt');
if (!p) fail('describe.prompts 缺少 envPrompt');
else {
  eq(p.key, 'worlds.netease-play.envPrompt', 'envPrompt 的 key 一致');
  eq(String(p.content || '').trim(), env.trim(), 'envPrompt 全文与 ENV_PROMPT.md 一致');
}

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
