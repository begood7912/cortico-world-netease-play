/**
 * 点播一首歌：快路径（页面里已经在列表里，双击那一行，约 0.4 秒）→ 慢路径（搜歌 → 排到歌单最前 → 连播）。
 *
 * 接力 / 换一批 / 她问「要放吗」这几条路都要世界自己按播放，
 * 所以抽到这里，面板和世界共用同一套（行为一字不改，只是换了个家）。
 */
import { event } from './log.js';
import { logPath } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playSongs, DEFAULT_PLAYLIST } from './python.js';
import { fastPlay, recordPick } from './fastplay.js';
import { nameById } from './playlists.js';
import { markIdleAnswered } from './idle.js';
import { cdpAlive, ensureClient } from './client.js';
import { clearQuiet } from './quiet.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function logPlay(obj = {}) {
  // 0.16.98：播放诊断也走统一信封，type 用 play.<动作>
  const { ev, ...fields } = obj;
  event(`play.${ev || 'note'}`, fields);
}

/**
 * 0.17.44（A3）：这一次算不算「用户自己点的歌」。
 * 只有 `by === 'user'` 才记账 —— 慢路径以前写死 `auto:false`，把接力/换一批也记进去了。
 * 单独抽出来是为了能被自测直接断言。
 */
export const isAutoPick = (by) => String(by || 'user') !== 'user';

/**
 * 播一首。返回 {ok, message, title, fast?, ms?, count?}。
 * `by`: 'user' | 'auto' —— 程序自己递的歌（接力 / 换一批 / 她问「要放吗」）不进「点歌次数」（那是用户开口点的口径）。
 */
export async function playSong(c, a, by = 'user') {
  // 0.16.66（第 90 节）：世界自己挑的歌对象一律是 `{ name, artist, id }` ——
  // `pickIdleSong()` 就是这个形状，只有面板点歌那条带 `title`。
  // 以前这里只认 `a.title`，于是接力、换一批、她问「要放吗」这三条路
  // 全都在第一行就返回「没给歌名」—— 播报已经出口、歌却一首也没放出来。
  const title = String((a && (a.title || a.name)) || '').trim();
  if (!title) return { ok: false, message: '没给歌名' };
  const artist = String((a && a.artist) || '').trim();
  const id = String((a && (a.songId || a.id)) || '').trim();

  // 0.0.1.6.34：客户端没开就别往里冲了 —— 原来会先跑 5 秒快路径超时、再起 python 抓一次 cookie，
  // 最后报表成「CDP 执行异常」这种谁也看不懂的话。
  // 0.0.1.6.35：用户口径是「点放的时候直接去启动客户端，起来以后再放」——
  // 所以这里不是报错，是先把客户端拉起来，等它就绪，然后照常往下走。
  if (!(await cdpAlive(c && c.cdpPort))) {
    const up = await ensureClient(c || {}, { timeoutMs: 30000 });
    if (!up.ok) {
      logPlay({ title, artist, id, by, reason: 'player-off', launch: up.reason || '' });
      return {
        ok: false,
        reason: 'player-off',
        message: up.reason === 'no-exe'
          ? '找不到网易云的安装位置，放不了（装到别处的话在设置里填一下客户端路径）'
          : '网易云没开，我试着拉了一下但没起来，放不了',
      };
    }
    logPlay({ title, artist, id, by, reason: 'client-launched', launchMs: up.ms, launched: !!up.launched });
  }

  const t0 = Date.now();
  // 面板下拉存的是歌单 ID，快路径要点侧栏、按名字认，所以先换成名字
  const plRaw = String((c && c.playlist) || '').trim();
  const plName = plRaw ? (nameById(plRaw) || plRaw) : DEFAULT_PLAYLIST;
  const fast = await fastPlay({
    cdpPort: c && c.cdpPort, title, artist, songId: id, playlist: plName,
  });
  logPlay({
    title, artist, id, plName, by, fastMs: Date.now() - t0, fast,
  });
  if (fast && fast.ok) {
    if (by === 'user') recordPick({ songId: id, name: title, artist });
    // 真的放起来了 → 她那句「要我帮你放吗」就算有了着落，确认条收起（0.0.1.6.13）
    markIdleAnswered();
    // 0.0.1.6.38：他真在听了，「先安静着」这个临时开关到此为止
    clearQuiet('played');
    return { ok: true, message: `正在放：${title}（${Date.now() - t0}ms）`, title, artist, fast: true, ms: Date.now() - t0 };
  }

  const song = { name: title };
  if (artist) song.artist = artist;
  if (id && /^\d+$/.test(id)) song.id = id;   // 有 id 就带着走：脚本按 id 直接用，不搜索、不放错版本
  const r = await playSongs({
    playlist: (c && c.playlist) || '',
    songs: [song],
    // 0.17.44（A3）：慢路径也按 by 走 —— 程序递的歌不记账（快路径一直是这么判的）
    auto: isAutoPick(by),
    dryRun: false,
    cdpPort: c && c.cdpPort,
    favAt: c && c.favThreshold,
    autoFav: !(c && c.autoFav === false),
    allowRestart: !!(c && c.allowRestart === true),
  });
  const j = r && r.result;
  if (!j) {
    const tail = String((r && r.out) || '').trim().split(/\r?\n/).slice(-3).join(' / ');
    return { ok: false, message: `播放脚本没给结果${tail ? `：${tail}` : ''}` };
  }
  if (!j.ok) {
    // 0.17.42：错误可能出在 del / add / play 三段中的任意一段，`error` 已经是人话，
    // `errors` 里带原始 code（排错用）。以前笼统报「没搜到合格的歌」。
    return { ok: false, reason: 'add-failed', message: `没放成：${j.error || '没搜到合格的歌'}` };
  }

  const added = j.added || [];
  /* 0.17.42：`ok` 现在只代表「加进歌单了」。加进去但播放器没确认时，这里必须判失败 ——
     否则接力会把它当成已经放上，下一轮接着往下接，用户听到的却是上一首。 */
  if (!j.played) {
    const pe = (j.errors || []).find((e) => e && e.stage === 'play');
    return {
      ok: false,
      reason: 'not-playing',
      title: added[0] ? (added[0].title || added[0].name || title) : title,
      artist,
      message: `加进歌单了，但没放起来${pe && pe.message ? `：${String(pe.message).slice(0, 120)}` : ''}`,
    };
  }
  const nm = added[0] ? (added[0].title || added[0].name || title) : title;
  const cnt = added[0] && j.ledger ? j.ledger.counts?.[String(added[0].id)] : undefined;
  markIdleAnswered();
  clearQuiet('played');
  return {
    ok: true,
    message: `正在放：${nm}${cnt ? `（第 ${cnt} 次点）` : ''}`,
    title: nm,
    // 慢路径才拿得到「搜出来那条的正式歌手名」，回报文案要带它（0.0.1.6.37）
    artist: String((added[0] && (added[0].matched_artist || added[0].artist || added[0].artists)) || artist || ''),
    count: cnt,
    fast: false,
    ms: Date.now() - t0,
  };
}
