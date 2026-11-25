/**
 * 播放进度（剩多少秒）+ 当前歌曲 id + 在播状态。
 *
 * 进度读不到这件事必须说清：`py\nowplaying.ps1` 走的是 SMTC（系统媒体信息），
 * 那里只有曲目和播放/暂停，**没有进度、也没有歌曲 id**。两者都只在页面里：
 *   · 进度：进度条 input[aria-valuetext]
 *   · id ：播放条 [data-log*="page_pc_mini_bar"] 的 params.s_cid（实测与搜索接口一致）
 * 所以 spawn 一个 node 去连 CDP，**一次 evaluate 把三样一起拿回来**（0.17.46）。
 *
 * 缓存 2 秒：采样器 10 秒一跳，同一跳里可能被好几处问到，别反复起进程。
 */
import { runProc, payloadOf, parseLastJson, logParseFail, msgOf, profileOf } from './proc.js';

const TIMEOUT_MS = profileOf('progress').timeout;
const TTL_MS = 2000;

let cached = null;   // { at, port, data }

/** 读一次。返回 {ok, t, d, left, text, id, playing} 或 {ok:false, error, id?, playing?}。 */
export async function readProgress({ cdpPort, fresh = false } = {}) {
  const port = Number(cdpPort) || 9229;
  if (!fresh && cached && cached.port === port && Date.now() - cached.at < TTL_MS) {
    return cached.data;
  }

  // 外壳（5 秒 / NCM_CDP_PORT / 末行 JSON / 失败留现场）在 proc.js 的 `netease.progress`
  const payload = payloadOf({ cdpPort: port });
  const msg = msgOf('progress');
  const r = await runProc('progress', { payload, cdpPort: port });

  let data;
  if (r.spawnError) data = { ok: false, error: `${msg.spawn}：${r.spawnError}` };
  else if (r.timedOut) data = { ok: false, error: msg.timeout };
  else {
    data = parseLastJson(r.out);
    if (!data) {
      logParseFail('netease.progress', r);
      data = { ok: false, error: msg.parse };
    }
  }

  cached = { at: Date.now(), port, data };
  return data;
}

export const PATHS = { SCRIPT: 'py/progress.js', TIMEOUT_MS, TTL_MS };
