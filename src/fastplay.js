/**
 * 快路径点播（~0.4 秒）：歌如果已经在当前页面的列表里，直接在页面上双击那一行，
 * 不走 addplay.py 的搜歌 / 写歌单 / 等刷新那一整套（那套要 5~10 秒）。
 *
 * 找不到（不在当前列表）时返回 { ok:false }，调用方接着走慢路径。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { runProc, payloadOf, parseLastJson, logParseFail, nodeExe, PY_DIR, PYTHON, WORK_DIR } from './proc.js';

const RECORD_SCRIPT = join(PY_DIR, 'record_pick.py');

export async function fastPlay({
  // 0.1.21（用户口径「有 id 只走快路径」）：4.5 秒一刀切 → 分段预算之后，
  // 外层超时放到 6 秒（第一趟），重试趟 3.5 秒（skipHead，页面已经热了）。
  // 实测正路 1.1~1.5 秒：del 90ms / add 80ms / 等第一行 350~560ms / 点击确认 250~350ms。
  cdpPort, title, artist, songId = "", playlist = "", scrollPages = 2, timeoutMs = 6000, skipHead = false,
}) {
  // 参数走 base64：直接传含中文的 JSON 到 spawn 的 argv 会丢字段（实测 playlist 变空）
  const payload = payloadOf({ title, artist, songId, playlist, scrollPages, cdpPort, skipHead });
  // 外壳（4.5 秒 / cwd=py / 摘掉 Electron 变量 / 超时带现场）在 proc.js 的 `netease.fastplay`
  const r = await runProc('fastplay', { payload, cdpPort, timeoutMs });

  if (r.spawnError) {
    return { ok: false, reason: 'spawn-fail', err: String(r.spawnError), node: nodeExe() };
  }
  if (r.timedOut) {
    // 超时也要把子进程的 stdout/stderr 带出来，否则不知道它卡在哪一步
    return {
      ok: false,
      reason: 'timeout',
      timeoutMs: r.timeoutMs,
      out: String(r.out).slice(-300),
      err: String(r.err).slice(-300),
      node: nodeExe(),
    };
  }
  const j = parseLastJson(r.out);
  if (!j) {
    // 把原始输出带出去：宿主里出问题只能靠这个定位
    logParseFail('netease.fastplay', r);
    return {
      ok: false,
      reason: 'bad-output',
      code: r.code,
      out: String(r.out).slice(-400),
      err: String(r.err).slice(-400),
      node: nodeExe(),
    };
  }
  return j;
}

/**
 * 记一次点歌（用户自己点的才算）。
 * 故意不 await、也不报错——记账慢一点不能让播放等它，
 * 失败顶多是这条没记上，下次点还会补。
 */
export function recordPick({ songId, name, artist } = {}) {
  if (!name) return;
  try {
    const child = spawn(
      PYTHON,
      [RECORD_SCRIPT, JSON.stringify({ songId: songId || '', name, artist: artist || '' })],
      {
        cwd: PY_DIR,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          NCM_TOOLS_DIR: PY_DIR,
          NCM_WORK_DIR: WORK_DIR,
        },
      },
    );
    child.on('error', () => { /* 静默 */ });
    child.unref();
  } catch { /* 静默：记不上不影响播放 */ }
}
