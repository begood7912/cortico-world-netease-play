/**
 * 把整条 Python 链路包成异步函数。
 * 脚本只跑**包里自带的那份**（py/ 目录）——整套脚本随插件走，不再读外部目录，
 * 面板上也没有「脚本目录」这一项了。包内缺 addplay.py 会直接报错，不会偷偷换地方。
 *
 * 脚本内部引用的路径（Coopanion 工作区、网易云客户端）仍然指向本机现在的位置。
 */
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { external } from './log.js';

import { nameById } from './playlists.js';
// 0.17.4：点歌时手上就有 id，写进 id 缓存（听歌流水与排名页都靠它）
import { remember, resolveId } from './songid.js';
import {
  runProc, parseResultJson, PKG_ROOT, PYTHON, WORK_DIR, nodeExe,
} from './proc.js';

/** 路径与解释器统一来自 proc.js（0.17.3 起唯一出处），这里只做转出，别在别处再写一遍。 */
export { PKG_ROOT, PYTHON, WORK_DIR, nodeExe };

/** 包里自带的脚本目录 —— 唯一运行位置。 */
export const PKG_SCRIPT_DIR = join(PKG_ROOT, 'py');

export const NOTES = join(WORK_DIR, 'notes');
/** 不指定歌单时落到这张。 */
export const DEFAULT_PLAYLIST = '小菱的歌单';

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 包里自带的脚本目录。缺 addplay.py 直接报错，避免悄悄跑到陌生目录上。 */
async function packageScriptDir() {
  if (!(await exists(join(PKG_SCRIPT_DIR, 'addplay.py')))) {
    throw new Error(`插件包里的 py/addplay.py 不见了：${PKG_SCRIPT_DIR}（包不完整，重装或从备份恢复）`);
  }
  return PKG_SCRIPT_DIR;
}

/**
 * 跑一次 addplay.py。外壳（180 秒 / cwd=脚本目录 / UTF8+目录变量）在 proc.js 的 `netease.addplay`。
 * 保持老契约：超时 = code -2，起不来 = code -1，其余 = 子进程退出码。
 */
async function runPy(scriptDir, args, timeoutMs, extraEnv) {
  const addplay = join(scriptDir, 'addplay.py');
  const r = await runProc('addplay', {
    args: [addplay, ...args],
    cwd: scriptDir,
    timeoutMs,
    extraEnv,
  });
  const code = r.timedOut ? -2 : (r.spawnError ? -1 : r.code);
  const err = r.spawnError ? `${r.err}${String(r.spawnError)}` : r.err;
  return { code, out: r.out, err };
}

/** 从输出里找最后一行 RESULT_JSON（实现统一在 proc.js，这里保留旧名字给老调用点用）。 */
export function parseResult(out) {
  return parseResultJson(out);
}

/**
 * 点歌。
 * songs: [{ name, artist?, alt?: string[], id? }]
 * auto:  AI 自己挑的歌，不记次数（用户没开口）
 */
export async function playSongs({
  playlist, songs, auto, dryRun, cdpPort, favAt, autoFav, allowRestart,
}) {
  const dir = await mkdtemp(join(tmpdir(), 'ncm-play-'));
  const file = join(dir, 'songs.json');
  // 0.17.5：进脚本之前先把 id 补齐 —— 有 id 的脚本就直接按 id 走（不搜歌、不打分）；
  // 没 id 的（AI 只给了歌名、或接力挑的歌缺 id）在这里先查一次，查不到才让脚本自己搜。
  const list = (Array.isArray(songs) ? songs : []).map((s) => ({ ...(s || {}) }));
  await Promise.all(list.map(async (s) => {
    const t = String(s.name || s.title || '').trim();
    const a = String(s.artist || '').trim();
    const cur = String(s.id == null ? '' : s.id).trim();
    if (/^\d+$/.test(cur)) { remember(t, a, cur); return; }
    if (!t) return;
    const sid = await resolveId(t, a, { timeoutMs: 4000 });
    if (sid) s.id = sid;
  }));
  await writeFile(file, JSON.stringify(list), 'utf8');
  // 面板下拉存的是歌单 ID；纯数字就当 ID 换成名字，其余按名字原样传
  const plRaw = String(playlist ?? '').trim();
  const pl = plRaw ? (nameById(plRaw) || plRaw) : DEFAULT_PLAYLIST;
  const args = [pl, '--json', file];
  if (auto) args.push('--auto');
  if (dryRun) args.push('--dry-run');
  if (autoFav === false) args.push('--no-fav');
  else if (Number.isFinite(favAt) && favAt !== 2) args.push('--fav-at', String(favAt));
  if (allowRestart !== true) args.push('--no-restart');
  const port = Number.isFinite(cdpPort) && cdpPort > 0 ? cdpPort : 9229;
  let sd;
  try {
    sd = await packageScriptDir();
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      code: -1, out: '', err: String(error), result: null, scriptDir: PKG_SCRIPT_DIR,
    };
  }
  const result = await runPy(sd, args, 180000, { NCM_CDP_PORT: String(port) });
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  // 0.16.97：python 这条对端链路非零退出，单独记一份（返回值不变）
  if (result && result.code !== 0) {
    external('proc', 'playSongs', { code: result.code, err: String(result.err || '').slice(-400) });
  }
  return { ...result, result: parseResult(result.out), scriptDir: sd };
}

/** 读账本 点歌次数.json。 */
export async function readLedger() {
  const { readFile } = await import('node:fs/promises');
  const file = join(NOTES, '点歌次数.json');
  try {
    const raw = await readFile(file, 'utf8');
    const j = JSON.parse(raw);
    return { ok: true, updated: j.updated ?? '', songs: j.songs ?? {} };
  } catch (error) {
    return { ok: false, error: String(error), updated: '', songs: {} };
  }
}
