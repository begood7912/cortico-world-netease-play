/**
 * Windows 自带语音（SAPI / System.Speech）—— 0.1.02 新增的第二条出声路线。
 *
 * 为什么要它：GPT-SoVITS 那套是「本机跑一个 HTTP 服务」，服务没开就整句静音。
 * 系统自带的 SAPI 不需要任何服务，装没装中文语音包决定音质，但至少能出声。
 *
 * 分工：这里只负责「文本 → wav Buffer」；播放仍然交给 speak.js 那条老链路
 * （py\playwav.ps1 + SoundPlayer），所以「同一时刻只放一句」「句首留白」
 * 「被打断就撤」这些行为两条路线完全一致。
 *
 * 为什么不把文本当命令行参数：中文 + 引号 + 换行会让 PowerShell 参数解析炸掉，
 * 统一写成一个 UTF-8 临时 txt，由脚本自己读。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const PS1 = join(PKG_ROOT, 'py', 'winsapi.ps1');
const TMP_DIR = join(DATA_DIR, 'speak');
const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ch = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], { windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ch.kill(); } catch { /* 已退 */ }
      reject(Object.assign(new Error('timeout'), { kind: 'timeout' }));
    }, timeoutMs);
    let err = '';
    ch.stderr.on('data', (d) => { err += String(d); });
    ch.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    ch.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(err.trim());
      else reject(Object.assign(new Error(`exit ${code}${err ? `: ${err.trim()}` : ''}`), { kind: 'ps' }));
    });
  });
}

/**
 * 列出系统里装了哪些语音（给设置页自检 / 文档用）。
 * 返回 { ok, voices:[{name,culture,gender,age}], hasZh }
 */
export async function listVoices({ timeoutMs = 20000 } = {}) {
  const out = join(TMP_DIR, `voices-${Date.now()}.json`);
  try { mkdirSync(TMP_DIR, { recursive: true }); } catch { /* 已存在 */ }
  try {
    await run(['-list', out], timeoutMs);
    const raw = JSON.parse(readFileSync(out, 'utf8') || '[]');
    const voices = (Array.isArray(raw) ? raw : []).map((v) => ({
      name: String(v.name || ''),
      culture: String(v.culture || ''),
      gender: String(v.gender || ''),
      age: String(v.age || ''),
    })).filter((v) => v.name);
    const hasZh = voices.some((v) => /zh|chinese|中文/i.test(v.culture) || /huihui|yaoyao|kangkang|xiaoxiao|zhiwei|hanhan/i.test(v.name));
    return { ok: true, voices, hasZh };
  } catch (e) {
    return { ok: false, voices: [], hasZh: false, error: String((e && e.message) || e) };
  } finally {
    try { if (existsSync(out)) unlinkSync(out); } catch { /* 忽略 */ }
  }
}

/* ------------------------------------------------------------------------- *
 * 语音列表缓存（0.1.04）：设置页要把它做成下拉，而面板首帧不能等 PowerShell。
 * 所以这里存一份同步可读的缓存，刷新是后台异步做的（10 分钟一次够了 —— 装语音包
 * 需要重启系统，不会在运行中变）。
 * ------------------------------------------------------------------------- */
let cache = { at: 0, ok: false, voices: [], hasZh: false, error: '' };
let probing = false;

/** 同步读缓存；没探过就是空列表。 */
export function voicesCached() {
  return cache;
}

export function refreshVoices({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  if (process.platform !== 'win32' || process.env.NP_NO_PROBE === '1') return Promise.resolve(cache);
  if (probing) return Promise.resolve(cache);
  if (cache.at && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache);
  probing = true;
  return listVoices()
    .then((r) => { cache = { at: Date.now(), ok: Boolean(r.ok), voices: r.voices || [], hasZh: Boolean(r.hasZh), error: String(r.error || '') }; return cache; })
    .catch((e) => { cache = { ...cache, at: Date.now(), ok: false, error: String((e && e.message) || e) }; return cache; })
    .finally(() => { probing = false; });
}

/**
 * 文本 → wav Buffer。voice 为空就用系统默认；rate 是 SAPI 的 -10..10（默认 0）。
 * 失败抛错，kind 标在 error 上，由 speak.js 翻译成 reason。
 */export async function synth(text, { voice = '', rate = 0, timeoutMs = 30000 } = {}) {
  const say = String(text || '').trim();
  if (!say) throw Object.assign(new Error('empty'), { kind: 'empty' });
  try { mkdirSync(TMP_DIR, { recursive: true }); } catch { /* 已存在 */ }
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const inTxt = join(TMP_DIR, `sapi-${tag}.txt`);
  const outWav = join(TMP_DIR, `sapi-${tag}.wav`);
  try {
    writeFileSync(inTxt, say, 'utf8');
    await run([inTxt, outWav, String(voice || ''), String(Number(rate) || 0)], timeoutMs);
    const buf = readFileSync(outWav);
    if (buf.length < 1000) throw Object.assign(new Error('empty-audio'), { kind: 'empty-audio' });
    return buf;
  } finally {
    try { if (existsSync(inTxt)) unlinkSync(inTxt); } catch { /* 忽略 */ }
    try { if (existsSync(outWav)) unlinkSync(outWav); } catch { /* 忽略 */ }
  }
}
