/**
 * 想听清单：包内 data\wants.jsonl，一行一首，新的在前。
 *
 * 为什么按「歌名 + 歌手」去重而不是按 id：清单里可能有搜来的曲目和点歌账本里的曲目，
 * 两边 id 不一定对齐；而「同一首」在听感上就是同名同歌手。同一首只留一条，
 * 不然一天能提十遍。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { state, ensureDir, STATE_DIR } from './store.js';
import { join } from 'node:path';
import { PKG_ROOT } from './python.js';

const WANTS = state('wants.jsonl');



function key(item) {
  return `${String(item.name ?? item.title ?? '').trim()}|${String(item.artist ?? '').trim()}`.toLowerCase();
}

/** 读清单，新的在前。 */
export function readWants(limit = 10) {
  if (!existsSync(WANTS)) return [];
  let raw = '';
  try { raw = readFileSync(WANTS, 'utf8'); } catch { return []; }
  const seen = new Set();
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const k = key(item);
    if (!k || k === '|' || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function wantCount() {
  return readWants(500).length;
}

/**
 * 加一首。返回 { added, total }。
 * 记过的就什么都不做——重复提醒比不提醒更烦。
 */
export function addWant(item, at = Date.now()) {
  const existing = readWants(500);
  const k = key(item);
  if (existing.some((w) => key(w) === k)) return { added: false, total: existing.length };
  ensureDir(STATE_DIR);
  const line = `${JSON.stringify({
    at,
    name: String(item.name ?? item.title ?? '').trim(),
    artist: String(item.artist ?? '').trim(),
    songId: String(item.songId ?? item.id ?? ''),
    why: String(item.why ?? '').trim().slice(0, 60),
    url: String(item.url ?? ''),
  })}\n`;
  try {
    appendFileSync(WANTS, line, 'utf8');
    return { added: true, total: existing.length + 1 };
  } catch (error) {
    return { added: false, total: existing.length, error: String(error) };
  }
}

/** 清空。面板上有清理入口时才用。 */
export function clearWants() {
  try {
    if (existsSync(WANTS)) unlinkSync(WANTS);
    return true;
  } catch {
    return false;
  }
}
