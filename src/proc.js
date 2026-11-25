/**
 * 子进程统一入口（0.17.3 起）。
 *
 * 为什么收：0.16.x 时代有 9 处各自写一遍 spawn + 超时 + 解析 + 错误文案，
 * 想改一个超时要翻 9 个文件，出了错还常常「只剩一句超时」，看不到子进程最后说了什么。
 *
 * 收的原则（很重要，别顺手改）：
 *   1. 只收「外壳」——起进程 / 攒输出 / 计时 / kill / 结算。业务判断留在原模块。
 *   2. 参数一律写进下面的 PROFILES 表：超时、工作目录、环境变量、输出约定、超时后的返回口径。
 *      **不给默认值**：表里没写就是错的，宁可启动时报错，也不要静默继承一个 20 秒。
 *   3. 将来接别的软件（酷狗 / QQ 音乐）时，在 SOURCES 里加一行来源，在 PROFILES 里
 *      用 `<source>.<动作>` 这个键登记自己的超时与环境，调用点只换键名，不动外壳。
 *   4. 失败必留现场：超时、非零退出、起不来、解析不出，都会写一行到 data/log/external.log，
 *      带上「哪个键、哪个脚本、等了多久、退出码、输出尾段」——排错时先看这一行。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { external } from './log.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 包根目录（src 的上一级）。 */
export const PKG_ROOT = join(HERE, '..');
/** 包里自带的脚本目录。 */
export const PY_DIR = join(PKG_ROOT, 'py');

/* ==========================================================================
 * 可执行文件
 * ========================================================================== */

const NODE_CANDIDATES = [
  'D:\\Dev\\node\\node.exe',
  'C:\\Program Files\\nodejs\\node.exe',
];

/** 跑子脚本用的 node：先找两个常见安装位，找不到就用 PATH 里的 node。 */
export function nodeExe() {
  for (const p of NODE_CANDIDATES) if (existsSync(p)) return p;
  return 'node';
}

const PY_CANDIDATES = [
  'C:\\Users\\begoo\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  'python',
];

/** Python 解释器：首选 3.12 那个固定位置，退到 PATH。 */
export function pyExe() {
  for (const p of PY_CANDIDATES) if (p === 'python' || existsSync(p)) return p;
  return 'python';
}

export const PYTHON = PY_CANDIDATES[0];

/** Coopanion 工作区（账本、点歌流水都在它下面）。 */
export const WORK_DIR = 'D:\\Programs\\Coopanion\\data\\home\\companion\\workspace';

/** 读播放状态用的 PowerShell（系统自带那个，不依赖 pwsh 7）。 */
export const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

/* ==========================================================================
 * 来源（以后接酷狗 / QQ 音乐就加在这里）
 * ========================================================================== */

export const SOURCES = {
  netease: { id: 'netease', label: '网易云音乐', current: true },
};

/* ==========================================================================
 * 参数表 —— 9 处进程包装的唯一出处
 *
 * kind    : node | py | ps
 * script  : py/ 目录下的脚本文件名
 * cwd     : 'py' 表示在 py/ 下跑；null 表示继承宿主 cwd（历史行为，别改）
 * env     : none | port | utf8 | utf8+port | pyenv | sandboxed
 *           · none      : 什么都不过去（原 chart / recommend 就是这样）
 *           · port      : 只加 NCM_CDP_PORT
 *           · utf8      : 只加 PYTHONIOENCODING / PYTHONUTF8
 *           · utf8+port : 两个都加
 *           · pyenv     : utf8 + NCM_TOOLS_DIR / NCM_WORK_DIR（addplay 用）
 *           · sandboxed : 继承环境但摘掉 3 个 Electron 变量（fastplay 专用）
 * marker  : last | result | raw —— 输出里怎么找 JSON
 * timeout : 毫秒，必填
 * onTimeout: error | empty | partial | code2
 * msg     : 各类失败的文案（保持与 0.16.x 完全一致，别顺手统一）
 * ========================================================================== */

export const PROFILES = {
  'netease.chart': {
    kind: 'node', script: 'chart.js', cwd: null, env: 'none',
    marker: 'last', timeout: 40000, onTimeout: 'error',
    msg: { spawn: '起不来脚本', timeout: '读榜单超时', parse: '脚本没输出' },
  },
  'netease.daily': {
    kind: 'node', script: 'recommend.js', cwd: null, env: 'none',
    marker: 'last', timeout: 20000, onTimeout: 'error',
    msg: { spawn: '起不来脚本', timeout: '读每日推荐超时', parse: '脚本没输出' },
  },
  'netease.lyric': {
    kind: 'node', script: 'lyric.js', cwd: null, env: 'port',
    marker: 'last', timeout: 18000, onTimeout: 'error',
    msg: { spawn: '起不来脚本', timeout: '取歌词超时', parse: '脚本没输出 JSON' },
  },
  'netease.progress': {
    kind: 'node', script: 'progress.js', cwd: null, env: 'port',
    marker: 'last', timeout: 5000, onTimeout: 'error',
    msg: { spawn: '起不来脚本', timeout: '读进度超时', parse: '脚本没输出 JSON' },
  },
  'netease.liked': {
    kind: 'node', script: 'liked.js', cwd: null, env: 'port',
    marker: 'last', timeout: 6000, onTimeout: 'error',
    msg: { spawn: '起不来脚本', timeout: '读点赞数超时', parse: '脚本没输出 JSON' },
  },
  'netease.fastplay': {
    kind: 'node', script: 'fastplay.js', cwd: 'py', env: 'sandboxed',
    // 0.1.17（B3）：2.5 秒 → 4.5 秒。2.5 秒是「页面已经停在目标歌单」时的实测值；
    // 客户端刚启动 / 正在切歌单时，CDP 每步都慢几百毫秒，累计可达 15 秒（11-25 实测）。
    // 2.5 秒只会把本来能成的点歌杀在半路，然后落到慢路径。
    marker: 'last', timeout: 4500, onTimeout: 'partial',
    msg: { spawn: '起不来快路径', timeout: '', parse: '' },
  },
  'netease.playlists': {
    kind: 'py', script: 'playlists.py', cwd: 'py', env: 'utf8+port',
    marker: 'result', timeout: 20000, onTimeout: 'partial',
    msg: { spawn: '', timeout: '', parse: '读不到歌单（客户端没开或端口不通？）' },
  },
  'netease.recoPlaylist': {
    kind: 'py', script: 'reco_playlist.py', cwd: 'py', env: 'none',
    marker: 'result', timeout: 40000, onTimeout: 'error',
    msg: { spawn: '起不来脚本', timeout: '歌单脚本超时', parse: '脚本没输出' },
  },
  'netease.addplay': {
    kind: 'py', script: 'addplay.py', cwd: null, env: 'pyenv',
    marker: 'result', timeout: 180000, onTimeout: 'code2',
    msg: { spawn: '', timeout: '', parse: '' },
  },
  'netease.nowplaying': {
    kind: 'ps', script: 'nowplaying.ps1', cwd: null, env: 'utf8',
    marker: 'last', timeout: 15000, onTimeout: 'empty',
    msg: { spawn: '', timeout: '读播放状态超时', parse: '播放探针没输出 JSON' },
  },
};

/** 取一个 profile；允许写简写（'chart' → 'netease.chart'）。 */
export function profileOf(job, { source = 'netease' } = {}) {
  const key = String(job || '');
  const full = key.includes('.') ? key : `${source}.${key}`;
  const p = PROFILES[full];
  if (!p) throw new Error(`proc: 没有登记这个键「${full}」`);
  if (!p.timeout) throw new Error(`proc: 「${full}」没写超时`);
  return { ...p, key: full, source: full.split('.')[0] };
}

/** 某个键登记的失败文案（各模块原样用，不在这里改写）。 */
export function msgOf(job, opts = {}) {
  return profileOf(job, opts).msg;
}

/** 一张表，排错/说明书用：每个键的脚本、超时、cwd、env、解析口径。 */
export function profileTable() {  return Object.entries(PROFILES).map(([key, p]) => ({
    key,
    kind: p.kind,
    script: `py/${p.script}`,
    timeoutMs: p.timeout,
    cwd: p.cwd === 'py' ? 'py/' : '(继承)',
    env: p.env,
    marker: p.marker,
    onTimeout: p.onTimeout,
  }));
}

/* ==========================================================================
 * 环境与参数
 * ========================================================================== */

function buildEnv(env, { cdpPort, cwdAbs, extraEnv } = {}) {
  const withPort = (base) => {
    if (cdpPort == null || cdpPort === '') return base;
    return { ...base, NCM_CDP_PORT: String(Number(cdpPort) || 9229) };
  };
  const utf8 = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

  switch (env) {
    case 'none':
      return undefined;              // 继承（与原实现一致：这两个脚本不读 env）
    case 'port':
      return withPort({ ...process.env });
    case 'utf8':
      return { ...utf8 };
    case 'utf8+port':
      return withPort(utf8);
    case 'pyenv':
      return {
        ...utf8,
        // 包里 op3.py / ncm_fav.py 与 addplay.py 同目录
        NCM_TOOLS_DIR: cwdAbs || PY_DIR,
        NCM_WORK_DIR: WORK_DIR,
        ...(extraEnv || {}),
      };
    case 'sandboxed': {
      // 宿主是 Electron：这几个变量带进子 node，进程可能在启动阶段就卡住
      const e = { ...process.env };
      delete e.NODE_OPTIONS;
      delete e.ELECTRON_RUN_AS_NODE;
      delete e.ELECTRON_NO_ATTACH_CONSOLE;
      return e;
    }
    default:
      throw new Error(`proc: 未知的 env 约定「${env}」`);
  }
}

function exeOf(p) {
  if (p.kind === 'node') return nodeExe();
  if (p.kind === 'py') return pyExe();
  if (p.kind === 'ps') return POWERSHELL;
  throw new Error(`proc: 未知的 kind「${p.kind}」`);
}

function argvOf(p, { payload, args } = {}) {
  if (Array.isArray(args)) return args;
  const script = join(PY_DIR, p.script);
  if (p.kind === 'ps') {
    return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  }
  return payload == null ? [script] : [script, String(payload)];
}

/** payload 统一走 base64：直接往 argv 里塞中文 JSON 会丢字段（实测歌单名变空）。 */
export function payloadOf(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/* ==========================================================================
 * 解析
 * ========================================================================== */

/** 末行纯 JSON：chart / recommend / lyric / progress / liked / fastplay / nowplaying 的约定。 */
export function parseLastJson(out) {
  const line = String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** RESULT_JSON 前缀：playlists / recoPlaylist / addplay 的约定。 */
export function parseResultJson(out) {
  const lines = String(out || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const s = lines[i].trim();
    if (!s.startsWith('RESULT_JSON')) continue;
    try {
      return JSON.parse(s.slice('RESULT_JSON'.length).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/* ==========================================================================
 * 统一执行
 * ========================================================================== */

const tail = (s, n = 400) => String(s || '').slice(-n);

/**
 * 起一次子进程，等它结束（或超时杀掉）。
 *
 * 返回 { key, code, timedOut, spawnError, out, err, ms, timeoutMs, script }
 * 只描述「发生了什么」，不替调用方决定 ok / 空状态 / 错误码 —— 那是各模块自己的契约。
 */
export function runProc(job, opts = {}) {
  const p = profileOf(job, { source: opts.source });
  const timeoutMs = Number(opts.timeoutMs) || p.timeout;
  const cwdAbs = opts.cwd || (p.cwd === 'py' ? PY_DIR : undefined);
  const exe = exeOf(p);
  const argv = argvOf(p, opts);
  const env = buildEnv(p.env, { cdpPort: opts.cdpPort, cwdAbs, extraEnv: opts.extraEnv });

  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let code = null;
    let signal = '';
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let timer = null;

    const settle = () => {
      if (settled) return null;
      settled = true;
      if (timer) clearTimeout(timer);
      return {
        key: p.key,
        code,
        signal,
        timedOut,
        spawnError,
        out,
        err,
        ms: Date.now() - t0,
        timeoutMs,
        script: `py/${p.script}`,
      };
    };

    let child;
    try {
      child = spawn(exe, argv, { windowsHide: true, cwd: cwdAbs, env });
    } catch (e) {
      spawnError = String((e && e.message) || e);
      const r = settle();
      logFail(r, 'spawn');
      resolve(r);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 已经退了 */ }
      const r = settle();
      logFail(r, 'timeout');
      resolve(r);
    }, timeoutMs);

    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { err += d.toString('utf8'); });

    child.on('error', (e) => {
      spawnError = String((e && e.message) || e);
      const r = settle();
      logFail(r, 'spawn');
      resolve(r);
    });

    child.on('close', (c, sig) => {
      code = c;
      signal = sig || '';
      const r = settle();
      if (r && c !== 0) logFail(r, 'exit');
      resolve(r);
    });
  });
}

/**
 * 失败必留现场。写进 external.log：
 *   endpoint = 'proc'，action = 那个键（如 netease.lyric）
 *   附带 script / phase / timedOut / code / ms / timeoutMs / out 尾段 / err 尾段
 * 成功不写，别把日志刷满。
 */
function logFail(r, phase) {
  if (!r) return;
  try {
    external('proc', r.key, {
      script: r.script,
      phase,
      timedOut: r.timedOut,
      code: r.code,
      signal: r.signal || '',
      ms: r.ms,
      timeoutMs: r.timeoutMs,
      spawnError: r.spawnError || '',
      out: tail(r.out, 300),
      err: tail(r.err, 300),
    });
  } catch { /* 日志写不进去不能反过来弄坏这次调用 */ }
}

/** 解析失败也留一行（调用方拿到 null 时调它）。 */
export function logParseFail(key, r) {
  try {
    external('proc', String(key), {
      script: r && r.script,
      phase: 'parse',
      code: r && r.code,
      ms: r && r.ms,
      out: tail(r && r.out, 300),
      err: tail(r && r.err, 300),
    });
  } catch { /* 同上 */ }
}

/** 给面板/自测用的一句摘要。 */
export function describeRun(r) {
  if (!r) return '没有结果';
  if (r.spawnError) return `${r.key} 起不来：${r.spawnError}`;
  if (r.timedOut) return `${r.key} 超时 ${r.timeoutMs}ms，输出尾段：${tail(r.out, 120) || '(空)'}`;
  if (r.code !== 0) return `${r.key} 退出码 ${r.code}，错误尾段：${tail(r.err, 120) || '(空)'}`;
  return `${r.key} 正常 ${r.ms}ms`;
}
