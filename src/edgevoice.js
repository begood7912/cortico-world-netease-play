/**
 * 微软在线神经语音（Edge 那套：晓晓 / 晓伊 / 云希 …）—— 0.1.09。
 *
 * 用户口径：「TTS 的音色 xiaoxiao 那些，并不是中英文」。
 * 系统自带的 System.Speech 只有 Huihui / Kangkang / Yaoyao 三个老音色，
 * 晓晓这类是微软在线神经语音，得走 Edge 的 readaloud 接口（免费、不用 Key）。
 *
 * 两条链路分开：
 *   - 语音列表：直接 GET voices/list（318 个，取 zh 那批），落盘缓存 24 小时；
 *   - 合成：交给本机 python 的 edge-tts（`python -m edge_tts`），它负责签名头，
 *     输出 mp3（48kbps 24kHz 单声道），播放交给 py\playmp3.ps1（WPF MediaPlayer）。
 *
 * 为什么不用自己实现 WebSocket：7.x 的 Sec-MS-GEC 是自定义 SHA256 变体，
 * 自己抄一遍不如直接用官方包；代价是用户机器上要 `pip install edge-tts`。
 */
import { spawn } from 'node:child_process';
import https from 'node:https';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store.js';
import { external } from './log.js';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const VOICE_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TOKEN}`;
const CACHE_FILE = join(DATA_DIR, 'edge-voices.json');
const TMP_DIR = join(DATA_DIR, 'speak');
const TTL_MS = 24 * 60 * 60 * 1000;          // 列表一天刷一次就够
const PY = process.env.NP_PYTHON || 'python';
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/* 常见中文音色的中文名：`zh-CN-XiaoxiaoNeural` → 晓晓。没收录的照样能选，只是显示英文名。 */
const NAMES = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-liaoning-XiaobeiNeural': '小北（东北话）',
  'zh-CN-shaanxi-XiaoniNeural': '小妮（陕西话）',
  'zh-HK-HiuGaaiNeural': '曉佳（粤语）',
  'zh-HK-HiuMaanNeural': '曉曼（粤语）',
  'zh-HK-WanLungNeural': '雲龍（粤语）',
  'zh-TW-HsiaoChenNeural': '曉臻（台湾）',
  'zh-TW-HsiaoYuNeural': '曉雨（台湾）',
  'zh-TW-YunJheNeural': '雲哲（台湾）',
};

let cache = { at: 0, voices: [] };            // { at, voices: [{ name, gender, locale }] }
let loading = null;

function readCacheFromDisk() {
  try {
    if (!existsSync(CACHE_FILE)) return;
    const j = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(j.voices)) cache = { at: Number(j.at) || 0, voices: j.voices };
  } catch { /* 坏了就当没有 */ }
}
readCacheFromDisk();

function fetchVoiceList(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(VOICE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const all = JSON.parse(body);
          const zh = all
            .filter((v) => String(v.Locale || '').toLowerCase().startsWith('zh'))
            .map((v) => ({ name: v.ShortName, gender: v.Gender || '', locale: v.Locale || '' }));
          resolve(zh);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** 列表缓存（同步）：面板快照要立刻用，不能等网络。 */
export function voicesCached() {
  return cache;
}

/** 后台刷一次列表；不到期就跳过。 */
export function refreshVoices({ maxAgeMs = TTL_MS, timeoutMs = 10000 } = {}) {
  if (loading) return loading;
  if (cache.voices.length && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache);
  loading = fetchVoiceList(timeoutMs)
    .then((voices) => {
      cache = { at: Date.now(), voices };
      try {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
      } catch { /* 落不了盘下次再刷 */ }
      return cache;
    })
    .catch((e) => {
      external('voice', 'edge-voices', { why: String((e && e.message) || e) });
      return cache;
    })
    .finally(() => { loading = null; });
  return loading;
}

/** 设置页那个下拉：中文那批，带中文名。排序按「普通话优先 → 方言 → 粤语/台湾」。 */
export function zhVoiceOptions(zh = true) {
  const rank = (loc) => {
    const l = String(loc || '').toLowerCase();
    if (l === 'zh-cn') return 0;
    if (l.startsWith('zh-cn-')) return 1;
    if (l.startsWith('zh-hk')) return 2;
    return 3;
  };
  const base = cache.voices.length
    ? [...cache.voices].sort((a, b) => rank(a.locale) - rank(b.locale) || a.name.localeCompare(b.name))
    : [{ name: DEFAULT_VOICE, gender: 'Female', locale: 'zh-CN' }];
  return base.map((v) => {
    const cn = NAMES[v.name] || v.name.replace(/^zh-[A-Za-z-]+-/, '').replace(/Neural$/, '');
    const g = v.gender === 'Male' ? (zh ? '男声' : 'male') : (zh ? '女声' : 'female');
    return { value: v.name, label: `${cn} · ${g}` };
  });
}

/** 只认列表里真有的；还没有列表时放行（别把用户配好的值抹掉）。 */
export function pickVoice(value) {
  if (!value) return DEFAULT_VOICE;
  const known = cache.voices.map((v) => v.name);
  if (known.length && !known.includes(value)) return DEFAULT_VOICE;
  return value;
}

/** 本机 python 有没有 edge-tts（结果缓存，别每次都 spawn）。 */
let pyOk = null;
export function pythonReady() {
  if (pyOk !== null) return Promise.resolve(pyOk);
  return new Promise((resolve) => {
    let done = false;
    const ch = spawn(PY, ['-m', 'edge_tts', '--version'], { windowsHide: true });
    const fin = (ok) => { if (!done) { done = true; pyOk = ok; resolve(ok); } };
    ch.on('error', () => fin(false));
    ch.on('close', (code) => fin(code === 0));
    ch.stdout.on('data', () => {});
    ch.stderr.on('data', () => {});
    setTimeout(() => { try { ch.kill(); } catch { /* 已退 */ } fin(false); }, 8000);
  });
}

/**
 * 合成一句到 mp3 文件。返回 { ok, path, bytes, ms }。
 * 文本走临时 txt（`-f`），不塞命令行参数 —— 中文引号、长句、换行都不会出事。
 */
export async function synth(text, { voice, rate, timeoutMs = 30000 } = {}) {
  const say = String(text || '').trim();
  if (!say) return { ok: false, reason: 'empty' };
  try { mkdirSync(TMP_DIR, { recursive: true }); } catch { /* 已存在 */ }
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const txt = join(TMP_DIR, `edge-${stamp}.txt`);
  const out = join(TMP_DIR, `edge-${stamp}.mp3`);
  try {
    writeFileSync(txt, say, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'write', error: String((e && e.message) || e) };
  }

  const args = ['-m', 'edge_tts', '-f', txt, '-v', String(voice || DEFAULT_VOICE), '--no-progress', '--write-media', out];
  if (rate) args.push('--rate', String(rate));

  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    let done = false;
    const ch = spawn(PY, args, { windowsHide: true });
    let err = '';
    ch.stderr.on('data', (d) => { err += String(d); });
    ch.on('error', (e) => { if (!done) { done = true; resolve({ ok: false, kind: 'spawn', error: String(e.message || e) }); } });
    ch.on('close', (code) => {
      if (done) return;
      done = true;
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, kind: /ModuleNotFound|No module named/i.test(err) ? 'no-module' : 'fail', error: err.trim().slice(-300) || `exit ${code}` });
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      try { ch.kill(); } catch { /* 已退 */ }
      resolve({ ok: false, kind: 'timeout', error: 'edge-tts 超时' });
    }, timeoutMs);
  });

  try { unlinkSync(txt); } catch { /* 留着也没事，会被 sweep 清 */ }
  if (!res.ok) {
    try { unlinkSync(out); } catch { /* 没生成 */ }
    external('voice', 'edge', { voice: String(voice || ''), why: res.error || res.kind });
    return { ok: false, reason: res.kind || 'fail', error: res.error };
  }

  let bytes = 0;
  try { bytes = statSync(out).size; } catch { bytes = 0; }
  if (bytes < 500) {
    try { unlinkSync(out); } catch { /* 没生成 */ }
    return { ok: false, reason: 'empty-audio' };
  }
  return { ok: true, path: out, bytes, ms: Date.now() - t0 };
}

export const DEFAULT_EDGE_VOICE = DEFAULT_VOICE;
