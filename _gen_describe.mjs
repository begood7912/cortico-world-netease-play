/**
 * 0.17.58：重新生成 describe.json（不做别的）。
 *
 * 宿主导出 describe 的逻辑（`extensions/describe-export.ts`）就是：
 *   { tools: [...def.describe.tools], events: [...def.describe.events], prompts: [envPrompt 全文] }
 * 这边照着写一份，保证和 `src/index.js` / `ENV_PROMPT.md` 完全对得上。
 * `_t_describe.mjs` 负责校验；改完代码跑一次本脚本，再跑自测。
 *
 * 跑：node _gen_describe.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import def from './src/index.js';

const env = readFileSync('./ENV_PROMPT.md', 'utf8').trim();

const doc = {
  tools: def.describe.tools,
  events: def.describe.events,
  prompts: [
    {
      key: 'worlds.netease-play.envPrompt',
      title: '网易云陪听 · 用法',
      role: 'envPrompt',
      content: env,
    },
  ],
};

writeFileSync('./describe.json', JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`describe.json 已生成：${doc.tools.length} 工具 / ${doc.events.length} 事件 / ${doc.prompts.length} 提示词`);
