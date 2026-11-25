/**
 * 事件日志（0.16.97）—— 全部日志只从这里写。
 *
 * 两个文件，按「谁的责任」分家：
 *   data/log/events.jsonl  内部事件：接力、播报、挑选、选择、清歌单…（自己能决定的事）
 *   data/log/external.log  对端失败：网易云 / 模型 / 语音 / python 进程（别人家的接口出错）
 * 分家的意义：出问题时先看 external.log 判断是不是外面挂了，再看 events 看自己当时在做什么。
 *
 * 信封固定：{ at, type, ...字段 }。at 是毫秒时间戳，type 是点号命名 `域.动作`
 * （chain.announced / chain.fail / play.send / store.reset …），后面字段随便加，
 * 但 type 一经使用就冻结，改语义要换新 type。
 *
 * 文件只追加、不讀、不轮转：查的时候用 `Get-Content -Tail` 或脚本筛。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { DATA_DIR } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(DATA_DIR, 'log');
const EVENTS = join(DIR, 'events.jsonl');
const EXTERNAL = join(DIR, 'external.log');
// 0.17.43（D4）：自测（_t_log.mjs 等）以前直接往 events.jsonl 里写 test.envelope，
// 生产日志混进几十行测试数据。现在 test.* 默认写到单独文件；要写生产日志请设 NCM_LOG_TEST=1。
const TEST_EVENTS = join(DIR, 'test-events.jsonl');

let ready = false;
function ensure() {
  if (ready) return;
  try { mkdirSync(DIR, { recursive: true }); ready = true; } catch { /* 目录建不了就不写，别把主流程拖死 */ }
}

/** 内部事件：`type` 用点号，`fields` 平铺进信封。 */
export function event(type, fields = {}) {
  ensure();
  const t = String(type);
  const line = { at: Date.now(), type: t, ...fields };
  // 0.17.43（D4）：test.* 默认不写生产事件流
  const file = (t.startsWith('test.') && process.env.NCM_LOG_TEST !== '1') ? TEST_EVENTS : EVENTS;
  try { appendFileSync(file, JSON.stringify(line) + '\n', 'utf8'); } catch { /* 同上 */ }
  return line;
}

/**
 * 对端失败/异常：谁是那条链路、哪个动作、结果如何、原文是什么。
 * 不抛异常 —— 记录本身不能成为新的故障点。
 */
export function external(endpoint, action, detail = {}, ok = false) {
  ensure();
  const row = {
    at: new Date().toISOString(),
    endpoint,
    action,
    ok,
    ...detail,
  };
  try { appendFileSync(EXTERNAL, JSON.stringify(row) + '\n', 'utf8'); } catch { /* 同上 */ }
  return row;
}

/** 对端成功也记（只在你需要知道「这次通了没有」时用，别刷屏）。 */
export function externalOk(endpoint, action, detail = {}) {
  return external(endpoint, action, detail, true);
}

/** 两份日志的绝对路径，给面板/说明书引用，不要在别处再拼一遍。 */
export const LOG_PATHS = { dir: DIR, events: EVENTS, external: EXTERNAL, testEvents: TEST_EVENTS };
