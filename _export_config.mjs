/**
 * 把「我这台机器上填的全部配置」单独导出成一份 JSON —— 发布时这份不进包。
 *
 * 为什么要单独一份：配置存在宿主的 config.json（worlds."netease-play"），不在本包里；
 * 但一旦要重装 / 换机 / 发布，这些键（歌单 ID、榜单选择、天气 Key、客户端路径、模型地址）
 * 都是「我这边填的」，必须能一键找回，也不能跟着发布包出去。
 *
 * 用法：node _export_config.mjs [输出目录]
 *   默认输出到 F:\网易云陪听-私有\config-<时间戳>.json
 *
 * 只读宿主 config.json，不写任何东西回宿主。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'D:/Programs/Coopanion/data/home/companion/config.json';
const WORLD = 'netease-play';

const outDir = process.argv[2] || 'F:/AI点歌-私有';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

let host = null;
try {
  host = JSON.parse(readFileSync(HOST, 'utf8'));
} catch (e) {
  console.error(`读不到宿主配置：${e.message}`);
  process.exit(1);
}
const cfg = (host.worlds && host.worlds[WORLD]) || {};
if (!Object.keys(cfg).length) {
  console.error(`宿主配置里没有 worlds.${WORLD}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `config-${stamp}.json`);
const doc = {
  note: '网易云陪听 · 本机私有配置导出。发布包不含本文件，也不含 data/ 目录。',
  exportedAt: new Date().toISOString(),
  hostConfig: HOST,
  worldId: WORLD,
  keyCount: Object.keys(cfg).length,
  config: cfg,
};
writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

// 顺手列一下「哪些键被认为是个人填写项」，发布前要确认它们回默认
const PRIVATE = ['qwApiKey', 'qwApiHost', 'qwAdmin', 'qwCity', 'qwCountryCode',
  'playlist', 'chainCharts', 'clientExe', 'ollamaUrl', 'openaiUrl', 'openaiKey',
  'openaiModel', 'openaiModelManual', 'ttsUrl', 'chatModel', 'embedModel', 'cdpPort'];
const filled = PRIVATE.filter((k) => cfg[k] != null && cfg[k] !== '' && cfg[k] !== 0);
console.log(`导出完成：${file}`);
console.log(`键数 ${Object.keys(cfg).length}；其中「我填过的个人项」${filled.length} 个：${filled.join(', ')}`);
console.log(`目录里现有 ${readdirSync(outDir).filter((f) => f.endsWith('.json')).length} 份配置快照。`);
