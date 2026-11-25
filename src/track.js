/**
 * 0.17.52（B3）：当前曲目的唯一入口 —— 正常路径**不再调用 PowerShell**。
 *
 * 为什么要换：`py\nowplaying.ps1` 单次约 523ms（PowerShell 启动 + WinRT + 窗口枚举），
 * 采样器每 10 秒一次、三张卡复核再各一次、面板还有 8 秒缓存 —— 稳态下 6~10% 单核。
 *
 * 新的取法（按优先级）：
 *   1. `py\progress.js`（node + CDP，约 100ms）：播放条 `params.s_cid` → 歌曲 id；
 *      `cmd-icon-pause` → 在播/暂停；顺带拿进度。一次调用三样都有（0.17.46 已具备）。
 *   2. `https://music.163.com/api/song/detail?ids=[id]`（约 125ms）：官方歌名/歌手/时长，
 *      按 id 缓存（同一首只查一次）。
 *   3. **兜底**：CDP 不通 / 拿不到 id / 详情失败时，才回退 `readNow()`（SMTC + 窗口标题）。
 *
 * 回滚：设环境变量 `NCM_TRACK_SOURCE=smtc` 就整个回到原来的 PowerShell 路径，
 *       不用改代码。也可以把下面的 FORCE_SMTC 直接改成 true。
 */
import { readProgress } from './progress.js';
import { readNow } from './nowplaying.js';

/** 回滚开关：smtc = 老路径（PowerShell），其余 = 新路径（CDP 优先）。 */
const FORCE_SMTC = String(process.env.NCM_TRACK_SOURCE || '').trim().toLowerCase() === 'smtc';

/** 结果缓存：面板 3 秒轮询 + 采样器 10 秒一跳，5 秒内复用同一份，避免重复起进程。 */
const CACHE_TTL_MS = 5000;
/** 详情接口：成功缓存 6 小时（歌不会变），失败 60 秒内不重试。 */
const META_TTL_MS = 6 * 60 * 60 * 1000;
const META_FAIL_MS = 60 * 1000;
const MAX_META = 500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const metaCache = new Map();   // id -> { id, title, artist, durationMs, at }
const failCache = new Map();   // id -> until(ms)
let last = { at: 0, data: null };

/** 清缓存（自测用）。 */
export function _resetTrackCache() {
  metaCache.clear();
  failCache.clear();
  last = { at: 0, data: null };
}

/**
 * 按 id 查官方歌名/歌手（内存缓存）。失败返回 null，绝不抛。
 * `fetcher` 只给自测注入用；生产走网易云详情接口。
 */
export async function songMeta(id, { fetcher } = {}) {
  const k = String(id || '').trim();
  if (!k) return null;
  const hit = metaCache.get(k);
  if (hit && Date.now() - hit.at < META_TTL_MS) return hit;
  const until = failCache.get(k);
  if (until && Date.now() < until) return null;

  try {
    const j = fetcher
      ? await fetcher(k)
      : await fetch(`https://music.163.com/api/song/detail?ids=[${k}]`, {
        headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
        signal: AbortSignal.timeout(4000),
      }).then((r) => r.json());
    const s = j && Array.isArray(j.songs) ? j.songs[0] : null;
    if (!s) {
      failCache.set(k, Date.now() + META_FAIL_MS);
      return null;
    }
    const meta = {
      id: k,
      title: String(s.name || ''),
      artist: (s.artists || []).map((a) => a && a.name).filter(Boolean).join('/'),
      durationMs: Number(s.duration) || 0,
      at: Date.now(),
    };
    metaCache.set(k, meta);
    if (metaCache.size > MAX_META) metaCache.delete(metaCache.keys().next().value);
    return meta;
  } catch {
    failCache.set(k, Date.now() + META_FAIL_MS);
    return null;
  }
}

/** SMTC 兜底：老路径，只在 CDP/详情失败时走。 */
async function smtc() {
  const s = await readNow({ fresh: true }).catch(() => null);
  if (!s || !s.title) {
    return {
      ok: false, id: '', title: '', artist: '', playing: false, source: 'none', app: '', error: (s && s.error) || '读不到', at: Date.now(),
    };
  }
  return {
    ok: true,
    id: '',
    title: String(s.title || ''),
    artist: String(s.artist || ''),
    playing: s.playing === true,
    source: 'smtc',
    app: String(s.app || ''),
    at: Date.now(),
  };
}

/**
 * 当前曲目：`{ok, id, title, artist, playing, durationSec, source, app, at, error?}`。
 * `fresh:true` 时绕过 5 秒缓存（采样器每跳都要新数据）；否则可复用。
 */
export async function currentTrack({ cdpPort, fresh = false } = {}) {
  if (FORCE_SMTC) return smtc();

  const now = Date.now();
  if (!fresh && last.data && now - last.at < CACHE_TTL_MS) return last.data;

  // ① CDP：id + 在播状态 + 进度
  let p = null;
  try {
    p = await readProgress({ cdpPort, fresh });
  } catch {
    p = null;
  }
  const id = p && p.id ? String(p.id) : '';
  const barPlaying = !!(p && p.playing === true);

  // ② id → 官方歌名/歌手
  if (id) {
    const meta = await songMeta(id);
    if (meta && meta.title) {
      const data = {
        ok: true,
        id,
        title: meta.title,
        artist: meta.artist,
        durationSec: meta.durationMs ? Math.round(meta.durationMs / 1000) : 0,
        playing: barPlaying,
        source: 'cdp',
        app: '',
        at: now,
      };
      last = { at: now, data };
      return data;
    }
  }

  // ③ 兜底：SMTC；能保留的 id/在播状态尽量保留
  const s = await smtc();
  const data = { ...s, id: s.id || id, playing: p ? barPlaying : s.playing };
  last = { at: now, data };
  return data;
}
