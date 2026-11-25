/**
 * 歌单列表：给面板「默认歌单」做动态下拉，也给按 ID 点歌做名称映射。
 *
 * 框架支持 `x-options`：WebUI 每次打开下拉都会调 `WorldDefinition.configOptions(kind)`。
 * 那个调用是同步的，不能现场跑 Python，所以这里用一份缓存：
 *   - World 启动时刷新一次；
 *   - 每次点歌成功后刷新一次；
 *   - configOptions 只读缓存，读不到就返回空表（WebUI 会把当前值补进去）。
 *
 * 缓存文件：`data/playlists.json`（包内，随插件走）。
 */
import { cachePath } from './store.js';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runProc, parseResultJson, logParseFail, msgOf } from './proc.js';

const CACHE = cachePath('playlists.json');

/** 下拉选项源的 id，要和面板 schema 里的 `x-options` 对上。 */
export const OPTIONS_KIND = 'netease-playlists';

let memo = null;

/** 同步读缓存（configOptions 必须同步返回）。 */
export function loadCache() {
  if (memo) return memo;
  try {
    const j = JSON.parse(readFileSync(CACHE, 'utf8'));
    memo = {
      at: String(j.at || ''),
      playlists: Array.isArray(j.playlists) ? j.playlists : [],
    };
  } catch {
    memo = { at: '', playlists: [] };
  }
  return memo;
}

/** 下拉选项：第一项是"默认（小菱的歌单）"，其余按名字给。value 存歌单 ID。 */
export function options() {
  const { playlists } = loadCache();
  const list = [{ value: '', label: '默认（小菱的歌单）' }];
  for (const p of playlists) {
    if (!p || p.id == null) continue;
    list.push({ value: String(p.id), label: `${p.name || '未命名'}（${p.count || 0} 首）` });
  }
  return list;
}

/** 歌单 ID → 名字；找不到返回空串。 */
export function nameById(id) {
  const v = String(id ?? '').trim();
  if (!v) return '';
  const hit = loadCache().playlists.find((p) => String(p.id) === v);
  return hit && hit.name ? String(hit.name) : '';
}

/** 跑一次 playlists.py 刷新缓存。外壳（20 秒 / UTF8+端口 / RESULT_JSON）在 proc.js。 */
export async function refresh(cdpPort) {
  const port = Number.isFinite(cdpPort) && cdpPort > 0 ? String(cdpPort) : '9229';
  const msg = msgOf('playlists');
  const r = await runProc('playlists', { cdpPort: port });
  // 原实现把 stderr 也拼进同一段 buffer；保持这个口径，失败时才有原文可看
  const out = r.spawnError ? String(r.spawnError) : `${r.out}${r.err ? `\n${r.err}` : ''}`;

  const res = parseResultJson(out);
  if (!res || !res.ok) {
    if (!res) logParseFail('netease.playlists', r);
    return { ok: false, error: (res && res.error) || msg.parse };
  }
  const playlists = (res.playlists || []).filter((p) => p && p.id != null);
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, `${JSON.stringify({
    at: new Date().toISOString(), uid: res.uid, playlists,
  }, null, 2)}\n`, 'utf8');
  memo = null;
  return { ok: true, count: playlists.length };
}
