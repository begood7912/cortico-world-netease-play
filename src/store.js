/**
 * 数据目录与文件路径（0.16.98）—— 全包只在这里决定「东西放哪」。
 *
 * 三种东西分开叫：
 *   state  要长期记住的状态（接力到哪、她挑过什么、账本游标）
 *   cache  能重算、丢了只是慢一点的缓存（榜单、歌单、歌词、模型表、embedding）
 *   log    事件流水（由 log.js 用，见那边）
 *
 * 现在三者都还落在原来的 data\ 根目录下，文件名一个没变 ——
 * 先做到「只有一处拼路径」，真搬家时只改下面三行常量 + 一次迁移脚本，
 * 别的模块一行都不用动。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = join(HERE, '..', 'data');
export const STATE_DIR = DATA_DIR;
export const CACHE_DIR = DATA_DIR;
export const LOG_DIR = join(DATA_DIR, 'log');

const joinIn = (dir, name) => join(dir, String(name));

/** 状态文件路径。 */
export function state(name) {
  return joinIn(STATE_DIR, name);
}

/** 缓存文件路径。 */
export function cachePath(name) {
  return joinIn(CACHE_DIR, name);
}

/** 日志文件路径（目录由 log.js 建）。 */
export function logPath(name) {
  return joinIn(LOG_DIR, name);
}

/** 建目录，失败不抛（写不进去时由调用方自己兜）。 */
export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

/** 读 JSON，坏文件/不存在都回 fallback，不抛。 */
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 写 JSON（先写 .tmp 再原子改名，避免半截文件）。父目录不存在就建。 */
export function writeJson(file, value) {
  const tmp = file + '.tmp';
  try {
    ensureDir(dirname(file));
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    // 0.17.41：以前这里只是「再写一遍目标文件」，注释说的 rename 并不存在 ——
    // 于是 data\ 下留了一堆同名 .tmp，而且写一半崩了会留下半截 JSON。
    // 现在真的用 rename（Windows 上 libuv 走 MoveFileEx，目标已存在也会替换）。
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 一首歌的判重键（歌名 + 歌手，去空白转小写）。六个模块原来各写一遍，现在只这一份。 */
export function songKey(title, artist) {
  return `${String(title || '').trim()}|${String(artist || '').trim()}`.toLowerCase();
}
