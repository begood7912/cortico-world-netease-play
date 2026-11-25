/**
 * 「AI 推荐歌单」今天清空过没有 —— 单独一个文件，**不放在 chain.json 里**（第 97 节）。
 *
 * 为什么要搬出来：原来这个章记在 `data\chain.json` 的 `dailyKey` 字段上，
 * 而 `clearChain()` 是 `writeRaw({})` —— 整份倒空，章跟着没了。
 * 于是「章丢了 → 下一次接力又判今天没清 → 又清一次」，一张歌单一天能被清好几次
 * （2026-11-23 实测：上午点进去三首，最后只剩一首）。
 *
 * 现在的口径（用户原话）：
 *   清空以后记一笔「今天已清空」（`cleared: 1` + 日期），
 *   后面的动作**先读这个字段**，读到 1 就直接返回，连清空接口都不发。
 *
 * 文件长这样（`data\reco-clear.json`）：
 *   {
 *     "day": "2026-11-23",     // 按「切日小时」（默认 6 点）算出来的那一天
 *     "cleared": 1,            // 1 = 这一天已经清空过
 *     "hour": 6,
 *     "at": "2026-11-23T08:12:03+08:00",
 *     "removed": 27,           // 删了几首（回溯用）
 *     "kept": "山海不说话"       // 清完补回去了哪首（回溯用）
 *   }
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { state, ensureDir, DATA_DIR } from './store.js';
import { join } from 'node:path';
import { PKG_ROOT } from './python.js';

export const RECO_CLEAR_FILE = join(PKG_ROOT, 'data', 'reco-clear.json');

const pad = (n) => String(n).padStart(2, '0');

/**
 * 「这一轮算哪一天」—— 按切日小时算：现在还没到 h 点，就算前一天那一轮。
 * 纯粹为了把「今天已清」这个章和「哪一轮清零」对齐（默认 6 点切日）。
 */
export function currentDayKey(hour = 6, now = new Date()) {
  const h = Math.min(23, Math.max(0, Number(hour) || 0));
  const mark = now.getHours() < h ? new Date(now.getTime() - 24 * 3600 * 1000) : now;
  return `${mark.getFullYear()}-${pad(mark.getMonth() + 1)}-${pad(mark.getDate())}`;
}

/** 盘上那份记录；读不到/坏文件一律当「没清过」。 */
export async function readRecoClear() {
  try {
    const txt = await readFile(RECO_CLEAR_FILE, 'utf8');
    const j = JSON.parse(txt);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** 记下「今天已清空」。顺便把删了几首、补回了哪首也留下，方便事后对时间。 */
export async function writeRecoClear(rec = {}) {
  const out = {
    day: String(rec.day || ''),
    cleared: Number(rec.cleared) === 1 ? 1 : 0,
    hour: Number(rec.hour) || 0,
    at: String(rec.at || new Date().toISOString()),
    removed: Number(rec.removed) || 0,
    kept: String(rec.kept || ''),
  };
  try {
    ensureDir(DATA_DIR);
    await writeFile(RECO_CLEAR_FILE, `${JSON.stringify(out)}\n`, 'utf8');
  } catch {
    /* 写不进去不影响这一轮播放；下一次会因为读不到而再清一次，宁可多清也别漏记成「清过了」 */
  }
  return out;
}

/** 这个记录是不是「今天这一轮已经清过了」。纯函数，方便自测。 */
export function isClearedToday(rec, hour = 6, now = new Date()) {
  if (!rec) return false;
  if (Number(rec.cleared) !== 1) return false;
  return String(rec.day || '') === currentDayKey(hour, now);
}

export const PATHS = { RECO_CLEAR_FILE };
