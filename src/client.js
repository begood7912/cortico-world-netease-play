/**
 * 网易云客户端在不在（0.0.1.6.34）。
 *
 * 为什么需要这个：世界所有播放动作都靠 CDP（`http://127.0.0.1:9229`）操作客户端页面。
 * 客户端没开的时候，原来的行为是 —— 安静计时照走，到点照样推「要我帮你放吗？」，
 * 用户点「放」再兜一圈失败，最后她说「播放器那边没响应」。等于明知放不了还要问。
 *
 * 0.0.1.6.35：不再只是「报一声没开」。客户端没开时**自己去把它拉起来**：
 * 找到安装路径 → 带 `--remote-debugging-port=9229` 启动 → 轮询等 CDP 就绪 → 然后照常播。
 * 用户口径：「直接用缓存的数据去启动客户端，启动以后再后台慢慢读新数据。」
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearQuiet } from './quiet.js';

const CHECK_TTL_MS = 5000;

let last = { at: 0, ok: false, port: 0 };
/** 0.17.45（B2）：进程探测的缓存改成异步 + 30 秒（tasklist 单次 32ms，别每 5 秒同步卡一次）。 */
const PROC_TTL_MS = 30_000;
const execFileP = promisify(execFile);
let procAt = 0;
let procOk = false;
let procInflight = null;

function normalizePort(port) {
  const n = Number(port);
  return Number.isFinite(n) && n > 0 ? n : 9229;
}

/** 客户端在不在。network 层错误一律当「没开」，不抛异常 —— 调用方不该为此长 try/catch。 */
export async function cdpAlive(port, { force = false } = {}) {
  const p = normalizePort(port);
  if (!force && last.port === p && Date.now() - last.at < CHECK_TTL_MS) return last.ok;
  let ok = false;
  try {
    const res = await fetch(`http://127.0.0.1:${p}/json`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const list = await res.json();
      ok = Array.isArray(list) && list.some((x) => x && x.type === 'page');
    }
  } catch {
    ok = false;
  }
  last = { at: Date.now(), ok, port: p };
  return ok;
}

/** 上一次探测的结果（同步，给面板渲染用，不阻塞）。 */
export function lastAlive() {
  return last;
}

/* ---------------------------------------------------------------- 启动客户端 */

const EXE_CANDIDATES = [
  'C:\\Program Files\\NetEase\\CloudMusic\\cloudmusic.exe',
  'C:\\Program Files (x86)\\NetEase\\CloudMusic\\cloudmusic.exe',
  'D:\\Program Files\\NetEase\\CloudMusic\\cloudmusic.exe',
  'D:\\NetEase\\CloudMusic\\cloudmusic.exe',
];

/** 找客户端 exe。配置里写死了就用配置（用户换过安装目录时只改一处）。 */
export function findClientExe(cfg) {
  const custom = String((cfg && cfg.clientExe) || '').trim();
  if (custom && existsSync(custom)) return custom;
  for (const p of EXE_CANDIDATES) if (existsSync(p)) return p;
  const local = join(String(process.env.LOCALAPPDATA || ''), 'NetEase', 'CloudMusic', 'cloudmusic.exe');
  return existsSync(local) ? local : '';
}

/** 等客户端 CDP 就绪。启动一次网易云大约 8~20 秒（冷启动比热启动慢一倍）。 */
export async function waitClient(port, { timeoutMs = 40000, stepMs = 1000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdpAlive(port, { force: true })) return { ok: true, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return { ok: false, ms: Date.now() - t0 };
}

let lastLaunchAt = 0;
let launching = null;

/**
 * 退掉正在跑的客户端，等它真的没了（0.1.30）。
 *
 * 用途：客户端开着、但没带 9229 —— 这时「只等 CDP」是等不出来的（等 40 秒照样失败），
 * 只能退掉再带端口重开。什么时候允许杀，由设置里的 allowRestart 决定（默认 true）。
 */
async function killClient() {
  try {
    await execFileP('taskkill', ['/F', '/IM', 'cloudmusic.exe'], {
      timeout: 5000,
      windowsHide: true,
    });
  } catch { /* 进程不在时 taskkill 返回非零，属正常，不算失败 */ }
  for (let i = 0; i < 24; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await clientProcessRunning({ force: true }))) return true;
  }
  return false;
}

/**
 * 进程在不在（不看 CDP）。
 *
 * 为什么要多这一道：`/json` 偶尔会漏一拍 —— 实测遇到过「两次探测都失败但其实客户端开得好好的」，
 * 那就白白 spawn 了一个实例（网易云单实例会把现有窗口拉到前台抢焦点）。spawn 之前先用进程表兜一下，
 * 进程在就只等 CDP、不启动。
 */
export async function clientProcessRunning({ force = false } = {}) {
  /* 0.17.45（B2）：改成**异步 + 30 秒缓存**。
     实测 tasklist 单次约 32ms，原来是 execFileSync —— 每 5 秒把整个事件循环卡住一次，
     面板/接力/采样全跟着顿一下。现在异步跑，且 5 秒 → 30 秒（进程在不在不需要那么灵敏）。 */
  const now = Date.now();
  if (!force && procAt && now - procAt < PROC_TTL_MS) return procOk;
  if (procInflight) return procInflight;
  procInflight = (async () => {
    let ok = false;
    try {
      const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq cloudmusic.exe', '/NH'], {
        timeout: 3000,
        windowsHide: true,
        encoding: 'utf8',
      });
      ok = /cloudmusic\.exe/i.test(String(stdout || ''));
    } catch {
      ok = false; // 查不出来就当没开（宁可多等一次 CDP）
    }
    procOk = ok;
    procAt = Date.now();
    procInflight = null;
    return ok;
  })();
  return procInflight;
}

/**
 * 保证客户端可操作：已经开着就秒回；没开就启动 + 等就绪。
 * 60 秒内重复调用不再重复 spawn（网易云单实例，多开只会互相抢焦点），只等它起来。
 * 返回 `{ ok, ms, launched, exe, reason }`。
 */
export async function ensureClient(cfg, { timeoutMs = 40000 } = {}) {
  const port = normalizePort(cfg && cfg.cdpPort);
  // 连探两次（隔 300ms）：客户端在忙的时候 `/json` 偶尔会漏一拍，
  // 只探一次会把「开着」判成「没开」然后白白再起一个实例（单实例会抢焦点）。
  if (await cdpAlive(port, { force: true })) return { ok: true, ms: 0, launched: false };
  await new Promise((r) => setTimeout(r, 300));
  if (await cdpAlive(port, { force: true })) return { ok: true, ms: 300, launched: false };

  if (launching) return launching;

  const exe = findClientExe(cfg);
  if (!exe) return { ok: false, reason: 'no-exe', exe: '' };

  const t0 = Date.now();
  let launched = false;
  let restarted = false;
  // 进程已经在跑（只是 CDP 这一拍没响应）→ 一般只等它。
  /* 0.1.30（用户口径）：但如果它根本没带调试端口，「等」是没有尽头的 ——
     设置里「允许脚本重启网易云」默认打勾，这时直接退掉再带端口拉起（会打断当前播放，
     用户明确要这个行为；他取消勾选才当「绝不杀客户端」）。 */
  const alreadyRunning = await clientProcessRunning({ force: true });
  if (alreadyRunning && !(cfg && cfg.allowRestart === false)) {
    /* 先宽限 2 秒：客户端刚被拉起来时，端口会晚一拍才通 —— 这段时间里杀了它反而更糟。
       4 × 500ms 还不通，才认定「它根本没带调试端口」。 */
    let up = false;
    for (let i = 0; i < 4 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      up = await cdpAlive(port, { force: true });
    }
    if (!up) {
      restarted = await killClient();
      if (!restarted) return { ok: false, reason: 'kill-fail', exe };
    }
  }
  if ((restarted || !alreadyRunning) && (restarted || Date.now() - lastLaunchAt > 60000)) {
    lastLaunchAt = Date.now();
    try {
      const child = spawn(exe, [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      launched = true;
    } catch (e) {
      return { ok: false, reason: 'spawn-fail', error: String(e && e.message ? e.message : e), exe };
    }
  }

  launching = waitClient(port, { timeoutMs })
    .then((r) => {
      // 0.0.1.6.40：客户端被拉起来了 → 「先安静着」这个临时开关当场放开。
      // 用户口径：「客户端拉起以后就自动放开，这个简单一点，因为点歌的时候也会把客户端自动拉起。」
      if (r.ok) clearQuiet('client-up');
      return { ...r, launched, restarted, exe, ms: Date.now() - t0 };
    })
    .finally(() => { launching = null; });
  return launching;
}

