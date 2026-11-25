/**
 * 读「这首歌有多少人喜欢」（卡② 顶上那行用，0.16.53）。
 *
 * 网易云没有任何接口给单曲收藏人数：`/api/song/detail`、`/api/v3/song/detail`、
 * `/api/v1/song/detail` 三路都试过，字段里只有 pop（0-100 热度）、starredNum（恒 0），
 * 网页版歌曲页也不显示。**只有客户端界面上有**：
 *
 *   底部播放条 / 详情页的红心按钮
 *     span.cmd-typography.redstar-count[data-testid=tid_redstar_btn]
 *     → 文本是「100w+」或不满一万时的纯数字「8632」
 *
 * 所以这里只做一件事：连 CDP，Runtime.evaluate 一次，把「歌名 + 那个计数」读出来。
 * 歌名一起读是为了核对 —— 播放条上的计数只属于播放条里那首，拿它去配别的歌就是错的
 * （没在放歌时页面还留着上一首的计数，必然串）。
 *
 * 用法: node liked.js <base64({"cdpPort":9229})>   环境变量 NCM_CDP_PORT 也可
 * 输出: {"ok":true,"name":"有我呢","count":"100w+","hasBar":true}
 *       {"ok":false,"error":"..."}
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

/* 播放条用几何特征定位（窗口尺寸会变，别写死坐标），与 py\ncm.py 的 BAR_FINDER 一致。
   歌名取法：播放条里 redstar-count 之前最后一个「短文本叶子」，跳过进度和时间、跳过
   VIP / 极高 这类音质标签 —— 这是实测出来的顺序：进度 → 歌名 → VIP → 计数。 */
const EXPR = `(() => {
  const bar = (() => {
    const w = window.innerWidth, h = window.innerHeight;
    return [...document.querySelectorAll("*")].find(e => {
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      return cs.position === "fixed" && r.y > h * 0.75 && r.height > 50 && r.height < 130
             && r.width > w * 0.75;
    }) || null;
  })();

  const holder = bar || document;
  let cntEl = holder.querySelector(".redstar-count");
  if (!cntEl) cntEl = document.querySelector(".redstar-count");
  const count = cntEl ? (cntEl.textContent || "").trim() : "";

  let name = "";
  if (bar) {
    const leaves = [...bar.querySelectorAll("*")]
      .filter(e => e.children.length === 0 && (e.innerText || "").trim());
    const i = leaves.findIndex(e => String(e.className || "").includes("redstar-count"));
    for (let k = (i < 0 ? leaves.length - 1 : i - 1); k >= 0; k -= 1) {
      const t = (leaves[k].innerText || "").trim();
      if (/^[0-9: \/]+$/.test(t)) continue;
      if (/^(VIP|HVIP|SQ|极高|标准|流畅|杜比|臻音|沉浸)$/.test(t)) continue;
      if (t.length > 30) continue;
      name = t;
      break;
    }
  }
  return { count, name, hasBar: !!bar };
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
    if (r.exceptionDetails) {
      throw new Error(('页面里报错：' + (((r.exceptionDetails.exception || {}).description) || '')).slice(0, 120));
    }
    const v = r.result ? r.result.value : null;
    if (!v || !v.count) {
      done({ ok: false, error: '没读到喜欢人数（可能没有歌在放，或界面不在播放页）', got: v });
      return;
    }
    done({ ok: true, name: String(v.name || ''), count: String(v.count), hasBar: !!v.hasBar });
  } catch (e) {
    done({ ok: false, error: String((e && e.message) || e) });
  } finally {
    try { ws.close(); } catch { /* 已关 */ }
    void closed;
  }
})();
