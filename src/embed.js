/**
 * 文本向量：调本机 Ollama 的 embedding 接口（`POST /api/embed`）。
 * 卡① 用它把「听过的歌」和候选池放进同一个空间比相似度；卡片5 用它比天气。
 *
 * 几个实测细节：
 *   - bge-m3 出 1024 维；cpu 版单条 47ms，330 条要 15 秒 —— 冷启动（模型要先加载）更久。
 *   - 模型不存在时接口回 404，这里直接把错误抛上去，让卡上显示「向量模型不可用」，
 *     不要静默退化成随机推荐 —— 那比没有更糟。
 *
 * 0.17.43（B4，用户口径：「改为存入内存，不写文件」）：
 *   以前向量落盘 `data/embed-cache.json`（约 5.7MB），每次算完 8 秒节流整份重写 ——
 *   磁盘和 CPU 的尖峰主要来自它，而算出来的往往就是同一批歌，写盘收益很小。
 *   现在**只放进程内 Map**：同一个进程里「换一批」仍然只算新增文本；
 *   宿主重启后第一轮会重算一次（约 15 秒），之后照旧。
 */

const cache = new Map();
const MAX_CACHE = 8000;
/**
 * 一批最多多少条（0.0.1.6.30）。
 * 候选从「每日推荐 50 首」扩到「330 首」以后，一次全发会撞上请求超时：
 * 实测 bge-m3-cpu 47ms/条，330 条要 15 秒，冷启动更久。
 * 分批把单请求控制在 4 秒左右，一超时只丢一批而不是全丢。
 */
const EMBED_BATCH = 80;

export async function embedTexts(cfg, texts, { timeoutMs = 60000, batch = EMBED_BATCH } = {}) {
  const url = String((cfg && cfg.ollamaUrl) || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  const model = String((cfg && cfg.embedModel) || '').trim();
  if (!model) throw new Error('没选向量模型');

  const list = texts.map((t) => String(t || '').trim());
  if (!list.length) return [];

  // 已经算过的文本直接用（同一进程内的内存缓存）
  const miss = [];
  list.forEach((t, i) => {
    const k = `${model}\u0000${t}`;
    if (cache.has(k)) return;
    miss.push({ t, i, k });
  });
  const step = Math.max(1, Number(batch) || EMBED_BATCH);
  for (let from = 0; from < miss.length; from += step) {
    const part = miss.slice(from, from + step);
    const res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: part.map((m) => m.t) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`向量接口 HTTP ${res.status}`);
    const j = await res.json();
    const arr = j && j.embeddings;
    if (!Array.isArray(arr) || arr.length !== part.length) throw new Error('向量条数对不上');
    part.forEach((m, i) => {
      cache.set(m.k, arr[i]);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    });
  }
  return list.map((t) => cache.get(`${model}\u0000${t}`));
}

/** 已经有多少条向量在手（面板/排查用）。 */
export function embedCacheSize() {
  return cache.size;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  if (!x || !y) return 0;
  return dot / Math.sqrt(x * y);
}
