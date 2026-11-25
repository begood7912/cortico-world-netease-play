/**
 * 「AI 推荐歌单」—— 接力点歌这两首的去处（0.16.58）。
 *
 * 用户口径：
 *   - 设置里勾上「接力点歌歌单」→ 接力的歌落进这张歌单；**没有这张歌单就当场建一张**，有就用现成的。
 *   - 歌单名固定：**AI 推荐歌单**（用户定名，不是「AI 特荐推荐歌单」）。
 *   - 每天清零一次（开关 + 只填小时，默认 6 点）；**懒清零**：
 *     到点时电脑没开、也没在听歌 → 什么都不做；等下一次接力触发时先清、清完再跑。
 *
 * 实际干活的是 `py\reco_playlist.py`（复用 op3.py 的 cookie / 建歌单 / 加歌 / 删歌）。
 * 这里只负责起子进程、解析最后一行 RESULT_JSON，跟取每日推荐一个套路。
 */
import { runProc, payloadOf, parseResultJson, logParseFail, msgOf } from './proc.js';

/** 歌单名固定，不跟用户兜圈子。 */
export const RECO_PLAYLIST_NAME = 'AI 推荐歌单';

/** 起一次 py/reco_playlist.py。外壳（40 秒 / RESULT_JSON / 失败留现场）在 proc.js。 */
async function run(action, extra = {}) {
  const payload = payloadOf({ action, name: RECO_PLAYLIST_NAME, ...extra });
  const msg = msgOf('recoPlaylist');
  const r = await runProc('recoPlaylist', { payload });

  if (r.spawnError) return { ok: false, error: `${msg.spawn}：${r.spawnError}` };
  if (r.timedOut) return { ok: false, error: msg.timeout };
  const j = parseResultJson(r.out);
  if (j) return j;
  logParseFail('netease.recoPlaylist', r);
  const tail = String(r.out || r.err || '').trim().slice(-300);
  return { ok: false, error: tail || msg.parse };
}

/** 有没有这张歌单（只查，不建）。 */
export function peekRecoPlaylist() {
  return run('list');
}

/** 有就用、没有就建。返回 { ok, playlist:{id,name,count}, created } */
export function ensureRecoPlaylist() {
  return run('ensure');
}

/** 把歌加进去（歌单不存在会先建）。songs: [{name, artist, id}] */
export function addToRecoPlaylist(songs) {
  const list = (Array.isArray(songs) ? songs : [])
    .filter((x) => x && x.name)
    .map((x) => ({ name: String(x.name), artist: String(x.artist || ''), id: String(x.id || '') }));
  if (!list.length) return Promise.resolve({ ok: false, error: '没有歌' });
  return run('add', { songs: list });
}

/** 把歌单里的歌全部清掉（每日清零用）。 */
export function clearRecoPlaylist() {
  return run('clear');
}
