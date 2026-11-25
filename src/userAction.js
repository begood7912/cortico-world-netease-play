/**
 * 用户动作的统一入口（0.17.43，A8）。
 *
 * 用户口径：「只要用户有动作（AI 点歌、手动切歌），接力自动停止。AI 那边的判断还没研究好，
 * 可以先接入一个判断，方便后续往里加内容。」
 *
 * 所以这里只做三件事：
 *   markUserAction(kind, detail)  —— 任何"用户在动手"的地方调一下，记下时间与类型
 *   lastUserAction()              —— 读最近一次（面板/排错用）
 *   blockingUserAction(ms)        —— 接力闸用：这类动作发生后的 ms 内不许递歌
 *
 * 以后要加"什么算用户动作"，只需要：
 *   1) 在调用点 markUserAction('新类型', …)；
 *   2) 如果是**该停接力**的类型，把它加进 BLOCK；
 *   3) chainGate 一个字都不用改。
 */
import { event } from './log.js';

/** 会打断接力的动作类型。面板上的纯展示操作、调音量之类不要加进来。 */
const BLOCK = new Set(['play', 'switch', 'source']);

let last = { at: 0, kind: '', detail: '' };

export function markUserAction(kind, detail = '') {
  const k = String(kind || '').trim() || 'other';
  last = { at: Date.now(), kind: k, detail: String(detail || '').slice(0, 120) };
  try {
    event('user.action', { kind: k, detail: last.detail });
  } catch { /* 日志写不进去不能反过来弄坏动作本身 */ }
  return last;
}

export function lastUserAction() {
  return { ...last };
}

/** 最近 ms 内有没有「该停接力」的用户动作。 */
export function blockingUserAction(ms = 45_000) {
  return !!last.at && Date.now() - last.at < ms && BLOCK.has(last.kind);
}

export function clearUserAction() {
  last = { at: 0, kind: '', detail: '' };
}
