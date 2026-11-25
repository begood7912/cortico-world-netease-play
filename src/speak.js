/**
 * 把一句话变成一个声音（本机 GPT-SoVITS / 大肥鱼语音包，OpenAI 兼容）。
 *
 * 走 `POST {url}/audio/speech`，body `{input}` → 返回 wav。实测一句 20~30 字：
 * 合成约 2.5 秒、559 KB、播 6.4 秒。
 *
 * 播放用 PowerShell 的 SoundPlayer（py\playwav.ps1），spawn 出去不等它 ——
 * 播 6 秒，要是 await 就把整条链路堵住了。文件在这边 close 之后再删，
 * 脚本里删不掉：SoundPlayer 播完仍持有句柄。
 *
 * 同一时刻只放一句：正在播的时候又来一句，直接丢掉，别叠在一起吵。
 */
import { spawn } from 'node:child_process';
import { DATA_DIR } from './store.js';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { external } from './log.js';
import * as winvoice from './winvoice.js';
import * as edgevoice from './edgevoice.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const PS1 = join(PKG_ROOT, 'py', 'playwav.ps1');
const PS1_MP3 = join(PKG_ROOT, 'py', 'playmp3.ps1');
const TMP_DIR = join(DATA_DIR, 'speak');
const PS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DEFAULT_URL = 'http://127.0.0.1:9880';

let playing = false;
// 0.17.19：正在播的那个 PowerShell 进程 + 一个「取消代次」。
// 用户在合成途中点了歌，取消代次一变，合成回来就不许再播 ——
// 否则会出现「接力已停止，却又念了一句即将播放《起风了》，歌没换」。
let current = null;
let epoch = 0;

/**
 * 撤回这一声：合成中的直接作废，已经在播的当场停掉。
 * 调用点只该是「用户动作打断了接力播报」（点歌、手动换歌）。
 */
export function stopSpeaking() {
  epoch += 1;
  playing = false;
  const ch = current;
  current = null;
  if (ch) {
    try { ch.kill(); } catch { /* 已经退了 */ }
  }
  return true;
}

export function isSpeaking() {
  return playing;
}

/* ------------------------------------------------------------------------- *
 * 语音包会偶发「少念一段」：同一句 27 个字，测到过 5.87 秒，也测到过 3.91 秒
 * （少念了约 9 个字）。时长不能用来判断「念得对不对」，但能判断「念少了」——
 * 实测语速 0.19~0.22 秒/字，低于 0.17 秒/字就是明显缺内容，重合成一次。
 * 句子太长（>SEG_MAX 字）还容易整段被截，所以先按句号切段、各自校验、再拼 PCM。
 * ------------------------------------------------------------------------- */

const SEC_PER_CHAR = 0.19;      // 期望语速（取实测下限，宁可少量重试也不误判）
const MIN_RATIO = 0.86;         // 实际时长低于期望的这个比例 → 当作念少了
const MIN_SEC = 0.7;            // 极短句子给个下限，别因为抖一下就重试
const SEG_MAX = 44;             // 单段最多 44 字
const SEG_GAP_MS = 140;         // 拼接时两段之间留的空白
const RETRY = 1;                // 一次不成再合一次，取更长的那个

/* ------------------------------------------------------------------------- *
 * 0.16.55：句首留白。
 * 用户反馈「播报偶尔漏音」—— 开头第一个字被吞掉。SoundPlayer 起播要先跟音频设备
 * 握手，头几十到几百毫秒的声音发不出来，第一个字正好落在这一段里就没了。
 * 在 PCM 前面垫一段静音，让设备先醒过来，正文再从第一帧开始放。
 * 默认 1 秒（用户指定的实验值），`NP_PAD_HEAD_MS` 可临时改（0 = 关掉，做对比用）。
 * ------------------------------------------------------------------------- */
const PAD_HEAD_MS = (() => {
  const raw = process.env.NP_PAD_HEAD_MS;
  if (raw === undefined || raw === '') return 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
})();

function bareLen(text) {
  return String(text || '').replace(/[\s，,。.；;：:！!？?、…·“”"'「」（）()【】\-—]/g, '').length;
}

function parseWav(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        ch: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
      };
    }
    if (id === 'data') {
      if (!fmt) return null;
      return { fmt, pcm: buf.subarray(body, Math.min(body + size, buf.length)) };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

function wavSec(buf) {
  const w = parseWav(buf);
  if (!w || !w.fmt.byteRate) return 0;
  return w.pcm.length / w.fmt.byteRate;
}

function packWav(fmt, pcm) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(fmt.audioFormat, 20);
  head.writeUInt16LE(fmt.ch, 22);
  head.writeUInt32LE(fmt.rate, 24);
  head.writeUInt32LE(fmt.byteRate, 28);
  head.writeUInt16LE(fmt.blockAlign, 32);
  head.writeUInt16LE(fmt.bits, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** 把几段 wav 接成一段（同格式才行；格式不同就放弃拼接，由调用方退回整段）。 */
function joinWav(list) {
  const parts = list.map(parseWav).filter(Boolean);
  if (parts.length !== list.length || !parts.length) return null;
  const f0 = parts[0].fmt;
  for (const p of parts) {
    if (p.fmt.rate !== f0.rate || p.fmt.ch !== f0.ch || p.fmt.bits !== f0.bits || p.fmt.audioFormat !== f0.audioFormat) return null;
  }
  const gap = Buffer.alloc(Math.round((SEG_GAP_MS / 1000) * f0.byteRate));
  const chunks = [];
  parts.forEach((p, i) => {
    if (i) chunks.push(gap);
    chunks.push(p.pcm);
  });
  return packWav(f0, Buffer.concat(chunks));
}

/** 在 PCM 前面垫一段静音（0.16.55 句首留白，专治「漏第一个字」）。 */
export function padHead(buf, ms) {
  if (!(ms > 0)) return buf;
  const w = parseWav(buf);
  if (!w || !w.fmt.byteRate || !w.fmt.blockAlign) return buf;
  let n = Math.round((ms / 1000) * w.fmt.byteRate);
  n -= n % w.fmt.blockAlign;                    // 静帧也要按采样块对齐，否则播放器会认为文件坏了
  if (n <= 0) return buf;
  return packWav(w.fmt, Buffer.concat([Buffer.alloc(n), w.pcm]));
}

/** 按句号切段；单句过长再按逗号切；还是过长就硬切。 */
function splitText(text) {
  const t = String(text || '').trim();
  if (bareLen(t) <= SEG_MAX) return [t];
  const tent = t.replace(/([。！？!?…]+)/g, '$1\u0001');
  let segs = tent.split('\u0001').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of segs) {
    if (bareLen(s) <= SEG_MAX) { out.push(s); continue; }
    let rest = s;
    while (bareLen(rest) > SEG_MAX) {
      // 找 SEG_MAX 字附近最后一个逗号
      let cut = -1;
      let n = 0;
      for (let i = 0; i < rest.length; i += 1) {
        if (bareLen(rest[i]) > 0) n += 1;
        if (n >= SEG_MAX - 6 && /[，,；;：:]/.test(rest[i])) { cut = i + 1; break; }
      }
      if (cut <= 0) cut = Math.min(rest.length, SEG_MAX);
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  // 段数太多会把合成拖太久（每段要 1.5~2 秒）：超过 4 段就相邻合并
  const MAX_SEG = 4;
  while (out.length > MAX_SEG) {
    let best = 0;
    let bestLen = Infinity;
    for (let i = 0; i + 1 < out.length; i += 1) {
      const len = bareLen(out[i]) + bareLen(out[i + 1]);
      if (len < bestLen) { bestLen = len; best = i; }
    }
    out.splice(best, 2, `${out[best]}${out[best + 1]}`);
  }
  return out;
}

async function fetchWav(text, { url, voice, speed, timeoutMs }) {
  const body = { input: text };
  if (voice) body.voice = String(voice);
  if (Number(speed) > 0) body.speed = Number(speed);
  const res = await fetch(`${url}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'http' });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw Object.assign(new Error('empty-audio'), { kind: 'empty-audio' });
  return buf;
}

/** 一段文本 → 一段「确认没念少」的 wav。念少了就再合成一次，取更长的。 */
async function synthSeg(text, opts) {
  let best = null;
  let bestSec = 0;
  for (let attempt = 0; attempt <= RETRY; attempt += 1) {
    const buf = await fetchWav(text, opts);
    const sec = wavSec(buf);
    if (sec > bestSec) { best = buf; bestSec = sec; }
    const need = Math.max(MIN_SEC, bareLen(text) * SEC_PER_CHAR * MIN_RATIO);
    if (sec >= need) break;
  }
  return best;
}

/**
 * 合成并播放一句话。返回 { ok, bytes, ms, msSynth }；
 * `msSynth` 是合成耗时，播放是异步的，不在这里等。
 *
 * 0.1.02：新增 `engine`（'gpt' 默认 / 'windows'）。
 *   - 'gpt'     —— 老路线：POST {url}/audio/speech（GPT-SoVITS 等本机服务）
 *   - 'windows' —— 系统自带 System.Speech（见 winvoice.js），不需要任何服务在跑；
 *                  参数里的 url 在这条路上不参与，`voice` 变成 SAPI 的语音名。
 * 两条路线合成完都汇到同一段播放代码，所以「只放一句 / 句首留白 / 能被打断」完全一致。
 */
export async function speak({ text, url = DEFAULT_URL, voice, speed, timeoutMs = 30000, engine = 'gpt' } = {}) {
  const say = String(text || '').trim();
  if (!say) return { ok: false, reason: 'empty' };
  if (playing) return { ok: false, reason: 'busy' };
  // 这一声属于哪一代：中途 stopSpeaking() 就让这次合成白跑
  const myEpoch = epoch;

  const base = String(url || DEFAULT_URL).trim().replace(/\/+$/, '') || DEFAULT_URL;
  const t0 = Date.now();
  const eng = String(engine || '').trim().toLowerCase();
  const useWin = eng === 'windows';
  const useEdge = eng === 'edge';
  /* 0.1.04（用户口径）：voice 只对 Windows TTS 有意义；GPT-SoVITS 一直用服务端默认音色，
     所以这条路上即使配置里残留了 ttsVoice，也不往请求里塞。
     0.1.09：微软在线语音同样要吃 voice（晓晓 / 云希 …），它自己会按标点断句。 */
  const voiceOut = useWin || useEdge ? voice : undefined;
  const opts = { url: base, voice: voiceOut, speed, timeoutMs };
  let buf;
  let mp3 = null;
  let segs = 1;
  try {
    if (useWin) {
      // SAPI 自己会按标点断句，不用我们切段重试（它也不会「少念一段」）
      buf = await winvoice.synth(say, { voice, timeoutMs });
    } else if (useEdge) {
      /* 0.1.09：微软在线语音 —— python -m edge_tts 出 mp3，播放走 playmp3.ps1。
         它同样自己断句，不切段；超时给足（联网合成一句一般 1~2 秒）。 */
      const r = await edgevoice.synth(say, { voice: voice || edgevoice.DEFAULT_EDGE_VOICE, timeoutMs });
      if (!r.ok) {
        if (r.reason === 'timeout') return { ok: false, reason: 'edge-timeout', error: r.error };
        if (r.reason === 'no-module') return { ok: false, reason: 'edge-no-module', error: r.error };
        if (r.reason === 'empty-audio') return { ok: false, reason: 'empty-audio' };
        return { ok: false, reason: 'edge-fail', error: r.error };
      }
      mp3 = r.path;
    } else {
      // 长句切段各自合成、各自校验，拼成一条再播 —— 一句太长时整段被截的风险最高
      const parts = splitText(say);
      if (parts.length > 1) {
        const wavs = [];
        for (const p of parts) wavs.push(await synthSeg(p, opts));
        buf = joinWav(wavs);
        // 格式不一致拼不了，就退回整段合成（整段也要过校验）
        if (!buf) buf = await synthSeg(say, opts);
        else segs = parts.length;
      } else {
        buf = await synthSeg(say, opts);
      }
    }
  } catch (e) {
    const kind = (e && e.kind) || '';
    if (useWin) {
      external('voice', 'sapi', { voice: voice || '', why: String((e && e.message) || e) });
      if (kind === 'empty' || kind === 'empty-audio') return { ok: false, reason: 'empty-audio' };
      if (kind === 'timeout') return { ok: false, reason: 'sapi-timeout', error: String(e.message) };
      return { ok: false, reason: 'sapi-fail', error: String((e && e.message) || e) };
    }
    // 0.16.97：语音这条对端链路失败单独记，返回值不变（调用方照旧按 reason 处理）
    external('voice', 'synth', { url: base, voice: voice || '', why: String((e && e.message) || e) });
    if (kind === 'http') return { ok: false, reason: 'http', error: String(e.message) };
    if (kind === 'empty-audio') return { ok: false, reason: 'empty-audio' };
    return { ok: false, reason: 'unreachable', error: String((e && e.message) || e) };
  }
  const msSynth = Date.now() - t0;
  if (!mp3 && (!buf || buf.length < 1000)) return { ok: false, reason: 'empty-audio' };
  // 合成这段时间里被 stopSpeaking() 撤掉了 → 这段音频不要了
  if (myEpoch !== epoch) {
    if (mp3) { try { unlinkSync(mp3); } catch { /* 没生成 */ } }
    return { ok: false, reason: 'cancelled', cancelled: true, msSynth };
  }
  // 0.16.55：垫静音要在「念没念少」的判定之后 —— 那是量音频本身的时长，垫进去会干扰。
  // 0.1.09：mp3 那路不垫（它不带 PCM 头，垫不了；mp3 起播本来就没有吞首字的问题）。
  if (!mp3) buf = padHead(buf, PAD_HEAD_MS);

  try {
    mkdirSync(TMP_DIR, { recursive: true });
  } catch { /* 已存在 */ }
  let file = mp3;
  if (!mp3) {
    file = join(TMP_DIR, `say-${Date.now()}.wav`);
    try {
      writeFileSync(file, buf);
    } catch (e) {
      return { ok: false, reason: 'write', error: String((e && e.message) || e) };
    }
  }

  playing = true;
  let child;
  try {
    child = mp3
      ? spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_MP3, file], { windowsHide: true })
      : spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, file], { windowsHide: true });
  } catch (e) {
    playing = false;
    if (mp3) { try { unlinkSync(mp3); } catch { /* 没生成 */ } }
    return { ok: false, reason: 'spawn', error: String((e && e.message) || e) };
  }
  const finish = () => {
    playing = false;
    if (current === child) current = null;
    try { if (existsSync(file)) unlinkSync(file); } catch { /* 下次再删 */ }
  };
  current = child;
  child.on('error', finish);
  child.on('close', finish);

  // mp3 48kbps ≈ 6 KB/秒，够给日志和「播了多久」估个值
  const secs = mp3 ? Math.round(((mp3Bytes(mp3) / 6000) + 0) * 10) / 10 : Math.round(wavSec(buf) * 10) / 10;
  return { ok: true, bytes: mp3 ? mp3Bytes(mp3) : buf.length, msSynth, secs, segs, padMs: mp3 ? 0 : PAD_HEAD_MS, engine: mp3 ? 'edge' : (useWin ? 'windows' : 'gpt') };
}

function mp3Bytes(p) {
  try { return statSync(p).size; } catch { return 0; }
}

/** 清掉上次没删掉的 wav / mp3（启动时调一次）。只清 10 分钟前的，别碰正在放的那句。 */
export function sweepOld() {
  try {
    if (!existsSync(TMP_DIR)) return 0;
    const cutoff = Date.now() - 10 * 60 * 1000;
    let n = 0;
    for (const name of readdirSync(TMP_DIR)) {
      if (!/\.(wav|mp3|txt)$/i.test(name)) continue;
      const p = join(TMP_DIR, name);
      try {
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p);
          n += 1;
        }
      } catch { /* 单个文件被占用就算了 */ }
    }
    return n;
  } catch {
    return 0;
  }
}
