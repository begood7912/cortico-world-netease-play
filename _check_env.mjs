/**
 * 装完自检（INSTALL.md §4 那一句）。
 *
 * 只读检查，不装东西、不改配置：Node / Python / 三个包 / 三个端口 / 宿主登记 / 写死路径是否对得上。
 * 输出每项一行 OK / WARN / FAIL，最后给一句总结。有 FAIL 时退出码 1（方便 AI 判）。
 *
 * 用法：node _check_env.mjs            （在包目录下）
 *      node _check_env.mjs --port 9300 （改 CDP 端口再查）
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CDP_PORT = Number(argOf('--port', 9229)) || 9229;

const lines = [];
let fails = 0;
let warns = 0;
function ok(msg) { lines.push(`  OK    ${msg}`); }
function warn(msg) { warns += 1; lines.push(`  WARN  ${msg}`); }
function fail(msg) { fails += 1; lines.push(`  FAIL  ${msg}`); }
function head(msg) { lines.push('', `## ${msg}`); }

function run(cmd, args, timeout = 8000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
  return {
    code: r.error ? -1 : (r.status ?? -1),
    out: `${r.stdout || ''}${r.stderr || ''}`.trim(),
    err: r.error ? String(r.error.message) : '',
  };
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/* ------------------------------------------------------------------ 1. Node */
head('Node');
const nodeVer = process.versions.node;
const nodeMajor = Number(nodeVer.split('.')[0]);
if (nodeMajor >= 22) ok(`node ${nodeVer}（≥22）`);
else fail(`node ${nodeVer} 低于 22 —— py/*.js 要用全局 fetch/WebSocket，请升级 Node`);

/* --------------------------------------------------------------- 2. Python */
head('Python');
// 与 src/proc.js 同一套候选（这里独立写一份，故意不 import，避免把日志模块带起来）
const PY_CANDIDATES = [
  'C:\\Users\\begoo\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  'python',
];
let pyExe = null;
for (const p of PY_CANDIDATES) {
  if (p === 'python' || existsSync(p)) {
    const r = run(p, ['--version']);
    if (r.code === 0) { pyExe = p; break; }
  }
}
if (!pyExe) {
  fail('找不到能跑的 python —— 装 3.12 并勾 PATH，或改 src/proc.js 的 PY_CANDIDATES');
} else {
  const r = run(pyExe, ['--version']);
  ok(`解释器 ${pyExe} → ${r.out}`);
  const mods = run(pyExe, ['-c', 'import requests, websocket, pypinyin; print("ok")']);
  if (mods.code === 0 && mods.out.includes('ok')) ok('包齐全：requests / websocket-client / pypinyin');
  else fail(`缺 Python 包（${mods.out || mods.err || '无输出'}）→ python -m pip install requests websocket-client pypinyin`);
}

/* --------------------------------------------- 3. 端口（9229 / 9880 / 11434）*/
head('端口');
function probe(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch { /* 已关 */ } res(v); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
const p9229 = await probe(CDP_PORT);
if (p9229) ok(`${CDP_PORT} 网易云 CDP 通`);
else warn(`${CDP_PORT} 不通 —— 客户端没开或没带 --remote-debugging-port（点歌时才需要，见 INSTALL §2.6）`);

const p9880 = await probe(9880);
if (p9880) ok('9880 语音服务通');
else warn('9880 不通 —— 语音可选；要念出来就装「大肥鱼语音全能包」或把 ttsUrl 指向兼容服务');

const p11434 = await probe(11434);
if (p11434) ok('11434 Ollama 通');
else warn('11434 不通 —— 本机模型可选；也可改用云端 OpenAI 兼容接口');

/* ---------------------------------------------------------- 4. 宿主登记 */
head('宿主登记');
const EXT_DIR = argOf('--ext', 'D:\\Programs\\Coopanion\\data\\extensions');
const HOME_DIR = resolve(EXT_DIR, '..', 'home', 'companion');

if (!existsSync(EXT_DIR)) {
  fail(`扩展目录不存在：${EXT_DIR} —— 用 --ext 指定你的 Coopanion data\\extensions`);
} else {
  const pkg = readJson(join(EXT_DIR, 'package.json'));
  const dep = pkg?.dependencies?.[PKG.name];
  if (dep) ok(`extensions/package.json 已登记 ${PKG.name} → ${dep}`);
  else fail(`extensions/package.json 缺依赖 ${PKG.name}（见 INSTALL §2.3）`);

  const linkPath = typeof dep === 'string' && dep.startsWith('link:') ? dep.slice(5) : null;
  if (linkPath) {
    const abs = resolve(linkPath);
    if (existsSync(abs)) ok(`link 目标存在：${abs}`);
    else warn(`link 目标不存在：${abs}`);
  }

  const owners = readJson(join(EXT_DIR, 'world-owners.json'));
  if (owners?.['netease-play'] === PKG.name) ok('world-owners.json 有 netease-play → 本包');
  else warn('world-owners.json 还没记 netease-play（宿主加载成功后会自己补，可忽略）');

  const installed = join(EXT_DIR, 'node_modules', PKG.name);
  if (existsSync(installed)) ok(`node_modules 里有 ${PKG.name}`);
  else fail(`node_modules 里没有 ${PKG.name} —— 还没 pnpm add 成功（见 INSTALL §2.3）`);
}

head('配置启用');
const CFG = join(HOME_DIR, 'config.json');
if (!existsSync(CFG)) {
  warn(`找不到 ${CFG} —— 用 --ext 指对了再查一边`);
} else {
  const cfg = readJson(CFG);
  const w = cfg?.worlds?.['netease-play'];
  if (w?.enabled === true) ok('config.json worlds["netease-play"].enabled = true');
  else fail('config.json 里 netease-play 没启用（见 INSTALL §2.4 / 面板电源按钮）');
}

/* ------------------------------------------------ 5. 包内写死的本机路径 */
head('包内写死的本机路径');
const procSrc = readFileSync(join(HERE, 'src', 'proc.js'), 'utf8');
const workDirRaw = (procSrc.match(/export const WORK_DIR = '([^']+)'/) || [])[1] || '';
const workDir = workDirRaw.replace(/\\\\/g, '\\');
if (!workDir) fail('src/proc.js 里没找到 WORK_DIR 常量（结构变了？）');
else if (existsSync(workDir)) ok(`WORK_DIR 存在：${workDir}`);
else fail(`WORK_DIR 指的地方不存在：${workDir} —— 改成这台机器的 <Coopanion数据目录>\\home\\companion\\workspace`);

const nodeCand = [...procSrc.matchAll(/'([A-Za-z]:\\+[^']*node\.exe)'/g)]
  .map((m) => m[1].replace(/\\\\/g, '\\'));
if (nodeCand.length === 0) warn('proc.js 的 NODE_CANDIDATES 解析不到绝对路径（只靠 PATH 的 node）');
else if (nodeCand.some((p) => existsSync(p))) ok(`node 候选命中：${nodeCand.find((p) => existsSync(p))}`);
else warn(`node 候选都不是本机路径（${nodeCand.join(' / ')}）→ 靠 PATH 的 node，或改 src/proc.js §5`);

const clientSrc = readFileSync(join(HERE, 'src', 'client.js'), 'utf8');
const clientPaths = [...clientSrc.matchAll(/'([A-Za-z]:\\\\[^']*cloudmusic\.exe)'/g)]
  .map((m) => m[1].replace(/\\\\/g, '\\'));
const anyClient = clientPaths.some((p) => existsSync(p));
if (anyClient) ok('找到网易云客户端（client.js 候选里有存在的那个）');
else warn('client.js 候选里没有实际存在的 cloudmusic.exe —— 自定义安装位的话加进候选（INSTALL §5）');

/* ------------------------------------------- 5.5 Windows 自带语音（0.1.02） */
head('Windows 自带语音（System.Speech）');
try {
  const { listVoices } = await import('./src/winvoice.js');
  const v = await listVoices();
  if (!v.ok) {
    warn(`列不出系统语音：${v.error} —— 选了「Windows TTS」也念不出来`);
  } else if (!v.voices.length) {
    warn('系统里一套语音都没装 —— 「Windows TTS」不可用，只能走 GPT-SoVITS');
  } else {
    const zh = v.voices.filter((x) => /zh|chinese/i.test(x.culture));
    if (zh.length) ok(`中文语音 ${zh.length} 套：${zh.map((x) => x.name).join('、')}`);
    else warn(`有 ${v.voices.length} 套语音但都不是中文（${v.voices.map((x) => x.name).join('、')}）—— Windows TTS 会按英文念中文`);
    const others = v.voices.filter((x) => !/zh|chinese/i.test(x.culture));
    if (others.length) lines.push(`        另外 ${others.length} 套非中文：${others.map((x) => `${x.name}(${x.culture})`).join('、')}`);
    // 真合成一句，确认不是「列得出来但合不出来」
    try {
      const b = await import('./src/winvoice.js').then((m) => m.synth('自检：语音可以出声。', { voice: zh[0] ? zh[0].name : '' }));
      if (b && b.length > 1000) ok(`试合成一句成功（${(b.length / 1024).toFixed(0)} KB wav）`);
      else warn('试合成返回的音频太小，Windows TTS 可能有问题');
    } catch (e) {
      warn(`试合成失败：${(e && e.message) || e}`);
    }
  }
} catch (e) {
  warn(`Windows 语音自检没跑成：${(e && e.message) || e}`);
}

/* ------------------------------------------- 5.6 微软在线语音（0.1.09） */
head('微软在线语音（edge-tts）');
try {
  const ev = await import('./src/edgevoice.js');
  const py = await ev.pythonReady();
  if (!py) {
    warn('本机 python 里没有 edge-tts —— 选了「微软在线语音」会念不出来。装法：pip install edge-tts');
  } else {
    ok('python 里有 edge-tts');
    const c = await ev.refreshVoices({ maxAgeMs: 60 * 1000 });
    if (c && c.voices && c.voices.length) {
      const zh = c.voices.filter((v) => /^zh/i.test(v.locale));
      ok(`中文神经音色 ${zh.length} 个：${zh.slice(0, 6).map((v) => v.name.replace(/Neural$/, '')).join('、')}${zh.length > 6 ? ' 等' : ''}`);
      try {
        const r = await ev.synth('自检：在线语音可以出声。', { voice: 'zh-CN-XiaoxiaoNeural' });
        if (r.ok) {
          ok(`试合成一句成功（${(r.bytes / 1024).toFixed(0)} KB mp3，${r.ms} ms）`);
          try { (await import('node:fs')).unlinkSync(r.path); } catch { /* 留着会被 sweep 清 */ }
        } else {
          warn(`试合成失败（${r.reason}）：${r.error || ''} —— 可能要联网或接口变动`);
        }
      } catch (e) {
        warn(`试合成抛错：${(e && e.message) || e}`);
      }
    } else {
      warn('拉不到中文音色列表 —— 网络不通或接口变动，「微软在线语音」下拉会只有晓晓一项');
    }
  }
} catch (e) {
  warn(`在线语音自检没跑成：${(e && e.message) || e}`);
}

/* ------------------------------------------------------- 6. 包自身完整性 */
head('包完整性');
const must = ['package.json', 'describe.json', 'ENV_PROMPT.md',
  'src/index.js', 'src/world.js', 'src/events.js',
  'py/addplay.py', 'py/op3.py', 'py/ncm.py', 'py/pick_ledger.py',
  'py/playwav.ps1', 'py/winsapi.ps1', 'py/playmp3.ps1', 'src/winvoice.js', 'src/edgevoice.js', 'webui/panel.js', 'webui/panel.css'];
const missing = must.filter((f) => !existsSync(join(HERE, f)));
if (missing.length === 0) ok(`${must.length} 个关键文件齐`);
else fail(`缺文件：${missing.join(', ')} —— 包不完整`);

/* ------------------------------------------------------------- 输出 + 退出码 */
console.log(`\n网易云陪听 环境自检  v${PKG.version}  包目录：${HERE}`);
console.log(lines.join('\n'));
console.log(`\n小结：FAIL ${fails} 项，WARN ${warns} 项。`);
if (fails === 0) {
  console.log('硬性依赖齐全。语音/模型/天气是可选项，缺了只是少功能。');
} else {
  console.log('先按上面 FAIL 的提示补齐，再跑一次。');
}
process.exit(fails === 0 ? 0 : 1);
