/**
 * 读当前播放进度（给「接力点歌」用）。
 *
 * SMTC 那边只有曲目和播放状态，没有进度 —— 进度只在页面 DOM 里：
 * 网易云新 UI 的进度条是一个 styled-components 容器
 *   div[aria-label="播放进度调节"]     ← 文本就是「01:42 / 04:57」
 *     └ input[aria-valuetext="101.871"] ← 当前秒数（精确到毫秒）
 * 所以这里只做一件事：连 9229，Runtime.evaluate 一次，把 t/d 读出来。
 *
 * 用法: node progress.js <base64({"cdpPort":9229})>   环境变量 NCM_CDP_PORT 也可
 * 输出: {"ok":true,"t":101.871,"d":297,"left":195.1,"text":"01:42 / 04:57"}
 */

const raw = process.argv[2] || '';
let opts = {};
try {
  opts = raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) : {};
} catch {
  opts = {};
}
const CDP_PORT = String(opts.cdpPort || process.env.NCM_CDP_PORT || 9229);
const TIMEOUT_MS = 7000;

function done(obj, code = 0) {
  console.log(JSON.stringify(obj));
  process.exit(code);
}

function withTimeout(p, ms, onTimeout) {
  return Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(onTimeout()), ms)),
  ]);
}

const EXPR = `(() => {
  // 0.17.46：顺手把「正在放的歌曲 id」和「在播/暂停」也读出来 —— 同一次 evaluate，+1ms。
  // id 只认播放条（page_pc_mini_bar）里的 params.s_cid；整页扫会读到列表行/导航的 id（串歌）。
  const barInfo = () => {
    const bars = [...document.querySelectorAll('[data-log*="page_pc_mini_bar"]')];
    let id = '';
    for (const b of bars) {
      let p = {};
      try { p = (JSON.parse(b.getAttribute('data-log') || '{}').params) || {}; } catch (e) { continue; }
      if (p.s_cid) { id = String(p.s_cid); break; }
    }
    if (!id) {
      const foot = document.querySelector('[class*=page-footer]');
      if (foot) {
        for (const e of foot.querySelectorAll('[data-log]')) {
          let p = {};
          try { p = (JSON.parse(e.getAttribute('data-log') || '{}').params) || {}; } catch (err) { continue; }
          if (p.s_cid) { id = String(p.s_cid); break; }
        }
      }
    }
    const host = bars[0] || document.querySelector('[class*=page-footer]');
    const playing = !!(host && host.querySelector('[class*="cmd-icon-pause"]'));
    return { id: id, playing: playing };
  };
  const bi = barInfo();

  // 优先用 aria-label 定位；英文界面 / UI 改版时退回 styled 容器类名。
  let el = document.querySelector('[aria-label="播放进度调节"]');
  if (!el) el = document.querySelector('[class*="StyledSliderContainer"]');
  if (!el) return { t: null, d: null, text: '', id: bi.id, playing: bi.playing };
  const input = el.querySelector('input[aria-valuetext]');
  const v = input ? parseFloat(input.getAttribute('aria-valuetext')) : NaN;
  const txt = (el.textContent || '').trim();
  const m = txt.match(/(\\d{1,2}):(\\d{2})\\s*\\/\\s*(\\d{1,2}):(\\d{2})/);
  const cur = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  const dur = m ? Number(m[3]) * 60 + Number(m[4]) : NaN;
  return {
    t: Number.isFinite(v) ? v : (Number.isFinite(cur) ? cur : null),
    d: Number.isFinite(dur) ? dur : null,
    text: txt,
    id: bi.id,
    playing: bi.playing,
  };
})()`;

(async () => {
  let targets;
  try {
    targets = await withTimeout(
      fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json()),
      TIMEOUT_MS,
      () => { throw new Error(`连不上 ${CDP_PORT}`); },
    );
  } catch (e) {
    done({ ok: false, error: String((e && e.message) || e) });
    return;
  }

  const page = (targets || []).filter((t) => t.type === 'page').pop();
  if (!page || !page.webSocketDebuggerUrl) {
    done({ ok: false, error: '没有可用的页面' });
    return;
  }

  let ws;
  try {
    ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch (e) {
    done({ ok: false, error: String((e && e.message) || e) });
    return;
  }

  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  });

  const closed = new Promise((resolve) => {
    ws.addEventListener('close', () => resolve(null), { once: true });
    ws.addEventListener('error', () => resolve(null), { once: true });
  });

  try {
    await withTimeout(new Promise((r) => ws.addEventListener('open', r, { once: true })), TIMEOUT_MS, () => {
      throw new Error('CDP 打不开');
    });
    await send('Runtime.enable');
    const r = await withTimeout(
      send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true }),
      TIMEOUT_MS,
      () => { throw new Error('页面没回话'); },
    );
    if (r.exceptionDetails) throw new Error(('页面里报错：' + ((r.exceptionDetails.exception || {}).description || '')).slice(0, 120));
    const v = r.result ? r.result.value : null;
    const id = v && v.id ? String(v.id) : '';
    const playing = !!(v && v.playing);
    if (!v || !Number.isFinite(v.t) || !Number.isFinite(v.d)) {
      done({ ok: false, error: '没读到进度（可能没有歌在放）', id, playing, got: v });
      return;
    }
    done({
      ok: true,
      t: Math.round(v.t * 10) / 10,
      d: Math.round(v.d * 10) / 10,
      left: Math.round((v.d - v.t) * 10) / 10,
      text: String(v.text || ''),
      // 0.17.46：当前播放歌曲 id（播放条 s_cid）与在播状态
      id,
      playing,
    });
  } catch (e) {
    done({ ok: false, error: String((e && e.message) || e) });
  } finally {
    try { ws.close(); } catch { /* 已关 */ }
    void closed;
  }
})();
