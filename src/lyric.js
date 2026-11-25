/**
 * 取一首歌的歌词正文（给「此刻」页第一张卡用）。
 *
 * 为什么不在这个进程里直接联网：cookie 里的 MUSIC_U 是 HttpOnly，
 * 只有 CDP 的 Network.getCookies 能读到，而 CDP 要 WebSocket —— 宿主是 Electron，
 * 它的 Node 不一定有全局 WebSocket。所以按 fastplay 的老办法：spawn 一个
 * `D:\Dev\node\node.exe` 去跑 `py\lyric.js`，用它拿 cookie、搜歌、取歌词。
 *
 * 缓存 6 小时：同一首歌反复问没必要，CDP + 两次 HTTP 加起来一秒多。
 */
import { cachePath, songKey, readJson, writeJson } from './store.js';
import { runProc, payloadOf, parseLastJson, logParseFail, msgOf } from './proc.js';

const CACHE_FILE = cachePath('lyric-cache.json');

const TTL_MS = 6 * 60 * 60 * 1000;

const key = songKey;

let cache = null;
function readCache() {
  // 0.16.99：读写都走 store；内存里那份仍在，命中就不碰盘
  if (!cache) cache = readJson(CACHE_FILE, {});
  return cache;
}

function writeCache(obj) {
  cache = obj;
  writeJson(CACHE_FILE, obj);
}

/** 同步读缓存（面板渲染要的是同步值）。没缓存返回 null。 */
export function peekLyric(title, artist) {
  const c = readCache()[key(title, artist)];
  if (!c) return null;
  if (Date.now() - (c.at || 0) > TTL_MS) return null;
  return c.data || null;
}

/**
 * 取歌词。先看缓存，否则跑一次脚本。
 *
 * `wantTimed`：卡② 要引用「播放到 60 秒时正在唱的那一句」，必须带时间轴。
 * 早先的缓存只有正文（cache 里 29452 字节那批），拿来定位不了，所以这种老记录要重取一次。
 */
export async function readLyric({ title, artist, cdpPort, wantTimed = false } = {}) {
  const hit = peekLyric(title, artist);
  if (hit && (!wantTimed || (Array.isArray(hit.timed) && hit.timed.length > 0))) {
    return hit;
  }

  // 外壳（18 秒 / NCM_CDP_PORT / 末行 JSON / 失败留现场）在 proc.js 的 `netease.lyric`
  const payload = payloadOf({
    title: String(title || ''),
    artist: String(artist || ''),
    cdpPort: Number(cdpPort) || 9229,
  });
  const msg = msgOf('lyric');
  const r = await runProc('lyric', { payload, cdpPort });

  let data;
  if (r.spawnError) data = { ok: false, error: `${msg.spawn}：${r.spawnError}` };
  else if (r.timedOut) data = { ok: false, error: msg.timeout };
  else {
    data = parseLastJson(r.out);
    if (!data) {
      logParseFail('netease.lyric', r);
      data = { ok: false, error: msg.parse };
    }
  }

  if (data && data.ok && data.text) {
    const c = readCache();
    c[key(title, artist)] = { at: Date.now(), data };
    writeCache(c);
  }
  return data || { ok: false, error: '没返回' };
}
