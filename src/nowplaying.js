/**
 * 读「现在在放什么」：起一次 py\nowplaying.ps1，拿一行 JSON。
 *
 * 两路合并的结果（SMTC 管状态、窗口标题管曲目）都在脚本里做完了，这里只负责
 * 起进程、解析、缓存。缓存是因为面板每 5 秒刷一次，而一次 PowerShell 启动要 0.6 秒，
 * 不缓存会把 CPU 白烧掉。
 */
import { runProc, parseLastJson, logParseFail, msgOf, profileOf } from './proc.js';

/** 缓存有效期。面板 5 秒刷一次，这里 8 秒——同一个数据不会重复起进程。 */
const TTL_MS = 8000;
const TIMEOUT_MS = profileOf('nowplaying').timeout;

let cached = null; // { at, data }
let inflight = null;

function empty(msg) {
  return { ok: false, playing: false, app: '', title: '', artist: '', source: 'none', error: msg, at: Date.now() };
}

/** 同步拿上一次结果，给不需要新数据的地方用（例如先渲染再刷新）。 */
export function cachedNow() {
  return cached ? cached.data : null;
}

/** 读当前曲目。并发调用会合并成一次。 */
export async function readNow({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.data;
  if (inflight) return inflight;
  inflight = run();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 探针：外壳（15 秒 / PowerShell / 末行 JSON）在 proc.js 的 `netease.nowplaying`。
 *  这里的契约很特别 —— **超时不算错，返回空状态**，否则面板会闪红。 */
async function run() {
  const msg = msgOf('nowplaying');
  const r = await runProc('nowplaying');

  let data;
  if (r.spawnError) data = empty(String(r.spawnError));
  else if (r.timedOut) data = empty(msg.timeout);
  else {
    data = parseLastJson(r.out);
    if (!data) {
      logParseFail('netease.nowplaying', r);
      data = empty(msg.parse);
    } else {
      data.at = Date.now();
    }
  }
  cached = { at: Date.now(), data };
  return data;
}
