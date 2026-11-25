/**
 * 本机 Ollama 的模型清单（给设置页的两个下拉用）。
 *
 * 为什么要有缓存：`configOptions(kind)` 是**同步**契约 —— 宿主不会 await，
 * 所以不能在打开设置页时现去 `/api/tags` + 逐个 `/api/show`。做法是启动时后台预热一次、
 * 落盘到 data/ollama-cache.json，下拉只读缓存；缓存没建好就先只给「不使用」一项，
 * 设置页照样能打开，不会卡住。
 *
 * 分类靠 `/api/show` 的 capabilities，不靠名字猜：
 *   - 含 embedding → 向量模型（bge-m3 / bge-small-zh）
 *   - 含 completion → 生成模型（qwen3.5:0.8b / minicpm5-2b）
 * 取不到 capabilities 时才退回名字匹配。
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { cachePath } from './store.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { external } from './log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = cachePath('ollama-cache.json');

/** 设置页两个下拉各自的 kind。 */
export const EMBED_KIND = 'ollama-embed';
export const CHAT_KIND = 'ollama-chat';
/** 「用哪边」的二选一（local / cloud）。 */
export const MODEL_SOURCE_KIND = 'model-source';
/** 云端模型名下拉。 */
export const CLOUD_MODEL_KIND = 'cloud-model';
/** 显存模式下拉（只对本机模型有效）。 */
export const VRAM_MODE_KIND = 'vram-mode';

/**
 * 本机模型的显存策略。
 *
 * 4B 那档全塞进 GPU 要 2.6~2.7 GB。实测（qwen3vl:4b，同一句话）：
 *   全 GPU ctx2048  2.73 GB，稳态 125~210 ms
 *   全 GPU ctx1024  2.59 GB，稳态 125~210 ms
 *   GPU 8 层 ctx1024 0.86 GB，稳态 1.13 s
 *   纯 CPU ctx1024   0.00 GB，稳态 1.28~1.41 s
 * 三个档的句子质量没有可见差别 —— 少塞几层只是变慢，不是变傻。
 * 卡① 本来就是「10 秒级可以接受」，所以 1.1 秒换 1.8 GB 显存是划算的。
 */
export function vramPlan(cfg) {
  const m = String((cfg && cfg.vramMode) || 'auto').trim() || 'auto';
  if (m === 'eco') return { numCtx: 1024, numGpu: 8 };
  if (m === 'cpu') return { numCtx: 1024, numGpu: 0 };
  return { numCtx: 2048, numGpu: undefined };
}

const DEFAULT_URL = 'http://127.0.0.1:11434';

/**
 * 云端（OpenAI 兼容）通道。
 *
 * 存在理由：本机上能跑的小模型，中文语感和指令遵循没法两全 —— 实测七个模型
 * 里只有 0.8B 同时守住「三档判断」和「字数下限」，而它写不出好句子。
 *
 * 二选一是硬开关（`modelSource` = local / cloud），**不是「能用云端就优先云端」**：
 * 选了 cloud 就必须三个字段都填齐；云端一旦报错（401 / 402 / 超时），
 * 卡①②③ 一起停摆，如实显示原因，**绝不偷偷回落到本机模型** ——
 * 那样用户以为在看云端的判断，其实是本机小模型编的。
 *
 * base 要填到版本前缀为止：DeepSeek 填 `https://api.deepseek.com` 或
 * `https://api.deepseek.com/v1` 都可以（下面统一拼 `/chat/completions`，DeepSeek 两个都收）。
 * OpenAI 官方要填 `https://api.openai.com/v1`。
 */
/** 当前用的云端模型名：下拉选中的优先，没选就用设置页手填那个。 */
export function cloudModelName(cfg) {
  const a = String((cfg && cfg.openaiModel) || '').trim();
  if (a) return a;
  return String((cfg && cfg.openaiModelManual) || '').trim();
}

export function hasCloudConfig(cfg) {
  const u = String((cfg && cfg.openaiUrl) || '').trim();
  const k = String((cfg && cfg.openaiKey) || '').trim();
  const m = cloudModelName(cfg);
  return Boolean(u && k && m);
}

/**
 * 当前走哪条路：
 *   'cloud' —— 选了云端且三个字段齐全（云端报错也不回落）
 *   'local' —— 选了本机且有模型名
 *   'none'  —— 什么都没配齐，三张卡都不工作
 */
export function modelMode(cfg) {
  const src = String((cfg && cfg.modelSource) || 'local').trim() || 'local';
  if (src === 'cloud') return hasCloudConfig(cfg) ? 'cloud' : 'none';
  return String((cfg && cfg.chatModel) || '').trim() ? 'local' : 'none';
}

/** 是不是「正在用云端」。 */
export function openaiReady(cfg) {
  return modelMode(cfg) === 'cloud';
}

/** 当前实际用的模型名（给面板显示和缓存记账用）。 */
export function modelLabel(cfg) {
  const m = modelMode(cfg);
  if (m === 'cloud') return cloudModelName(cfg);
  if (m === 'local') return String((cfg && cfg.chatModel) || '').trim();
  return '';
}

/** 有没有可用的模型（云端或本机任一，按开关判定）。 */
export function hasModel(cfg) {
  return modelMode(cfg) !== 'none';
}

/**
 * 云端一次非流式对话。
 *
 * `noThink` 默认开着，专治 DeepSeek V4 这类**默认就思考**的模型：
 * 它们把 token 全花在 `reasoning_content` 上，`content` 直接是空串、
 * `finish_reason` 是 `length` —— 现象就是「接口 200、模型不说话」。
 * 实测带 `thinking:{type:'disabled'}` + `reasoning_effort:'none'` 能在 0.5~1.1 秒
 * 直接出正文；换成真·OpenAI 官方端点这两个字段会被当成多余参数，
 * 所以 400/422 时去掉它们裸起重试一次。
 */
export async function chatOpenAI(base, key, model, messages, { temperature = 0.6, maxTokens = 220, timeoutMs = 30000, noThink = true } = {}) {
  // 和读模型表用同一套归一化：末尾斜杠、误填整条 /chat/completions、漏 /v1 都能兜住。
  // 漏 /v1 的那种补一次（OpenAI 官方必须带，DeepSeek 两个都收）。
  const base0 = normalizeBase(base);
  if (!base0) throw new Error('openai url 为空');
  // 地址没带 /vN 的，先按原样打；404 再补 /v1 试一次（OpenAI 官方必须带，有的网关只认裸 base）
  const roots = /\/v\d+$/.test(base0) ? [base0] : [base0, `${base0}/v1`];
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${String(key || '').trim()}`,
  };
  const send = (extra, r = roots[0]) => fetch(`${r}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: String(model || '').trim(),
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      ...extra,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const NO_THINK = { thinking: { type: 'disabled' }, reasoning_effort: 'none' };
  let res = await send(noThink ? NO_THINK : {});
  let body = await res.text();
  if (!res.ok && noThink && (res.status === 400 || res.status === 422)) {
    // 这个端点不认「关思考」的字段，裸起重来一次
    res = await send({});
    body = await res.text();
  }
  if (!res.ok && res.status === 404 && roots.length > 1) {
    res = await send(noThink ? NO_THINK : {}, roots[1]);
    body = await res.text();
  }
  if (!res.ok) {
    // 把服务端的原话带出来：401 是 key 不对、404 是 base 少了 /v1、402 是余额
    let detail = body.slice(0, 160);
    try {
      const j = JSON.parse(body);
      detail = (j.error && (j.error.message || j.error.type)) || detail;
    } catch { /* 不是 JSON 就按原文截断 */ }
    throw new Error(`openai ${res.status}: ${detail}`);
  }
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    throw new Error('openai 返回的不是 JSON');
  }
  const c = j && j.choices && j.choices[0];
  const msg = (c && c.message) || {};
  const text = String(msg.content || '').trim();
  if (!text) {
    // content 空而 reasoning_content 有内容 = 思考没关掉（或 token 用完）。如实报出来。
    const why = msg.reasoning_content
      ? '只出了思考过程，没出正文（token 被思考吃掉了）'
      : '模型返回了空内容';
    const fin = (c && c.finish_reason) || '';
    throw new Error(`openai ${fin || 'empty'}: ${why}`);
  }
  return text;
}

/**
 * 统一出口。按开关走，**不做回落**：
 * 选 cloud 就只认 cloud，云端报错直接把错误抛上去，让三张卡一起停。
 */
export async function chatAny(cfg, messages, opts = {}) {
  const m = modelMode(cfg);
  if (m === 'none') throw new Error('未配置可用的模型');
  if (m === 'cloud') {
    return chatOpenAI(cfg.openaiUrl, cfg.openaiKey, cloudModelName(cfg), messages, {
      temperature: opts.temperature === undefined ? 0.6 : opts.temperature,
      maxTokens: opts.numPredict || 220,
      timeoutMs: opts.timeoutMs || 30000,
    });
  }
  const plan = vramPlan(cfg);
  return chat(cfg && cfg.ollamaUrl, String((cfg && cfg.chatModel) || '').trim(), messages, {
    ...opts,
    numCtx: plan.numCtx,
    numGpu: plan.numGpu,
  });
}

let cache = null;

function readCache() {
  if (cache) return cache;
  try {
    const j = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    cache = { at: Number(j.at) || 0, models: Array.isArray(j.models) ? j.models : [] };
  } catch {
    cache = { at: 0, models: [] };
  }
  return cache;
}

function writeCache(obj) {
  cache = obj;
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf8');
  } catch { /* 写不了不影响下拉，下次再刷 */ }
}

/** 缓存里属于某一类的模型名（同步，给 configOptions 用）。 */
export function modelNames(kind) {
  const want = kind === EMBED_KIND ? 'embed' : kind === CHAT_KIND ? 'chat' : '';
  if (!want) return [];
  return readCache().models.filter((m) => m.kind === want).map((m) => m.name);
}

/** 缓存是否已经建过（给面板/日志判断用）。 */
export function cacheState() {
  const c = readCache();
  return { at: c.at, count: c.models.length };
}

/* ================= 云端模型清单 =================
 *
 * `GET {base}/models`（OpenAI 兼容；DeepSeek / OpenAI 官方 / vLLM 都提供）。
 * 为什么也要缓存：跟本机那套同样的理由 —— `configOptions(kind)` 是同步契约，
 * 宿主不会 await。设置页那个下拉每次被点开（pointerdown / focus）都会重新请求
 * `/api/config/options/cloud-model`，所以缓存越新，下拉里能选的越全。
 *
 * 一次拉失败也落盘（记 error），别让下拉一直转圈等不到东西。
 */

const CLOUD_CACHE_FILE = cachePath('cloud-models.json');

let cloudCache = null;
let cloudInflight = null;
let lastCloudAt = 0;

function readCloudCache() {
  if (cloudCache) return cloudCache;
  try {
    const j = JSON.parse(readFileSync(CLOUD_CACHE_FILE, 'utf8'));
    cloudCache = {
      at: Number(j.at) || 0,
      url: String(j.url || ''),
      models: Array.isArray(j.models) ? j.models.filter(Boolean) : [],
      error: String(j.error || ''),
    };
  } catch {
    cloudCache = { at: 0, url: '', models: [], error: '' };
  }
  return cloudCache;
}

function writeCloudCache(obj) {
  cloudCache = obj;
  try {
    writeFileSync(CLOUD_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* 写不了不影响下拉，下次再刷 */ }
}

/** 云端模型名（同步，给 configOptions 用）。 */
export function cloudModelNames() {
  return readCloudCache().models;
}

/** 云端缓存状态（给面板显示用）。 */
export function cloudCacheState() {
  const c = readCloudCache();
  return { at: c.at, count: c.models.length, url: c.url, error: c.error };
}

/**
 * 拉一遍云端模型清单。
 *
 * 地址怎么归一化（实测各家都这么填）：
 *   https://api.deepseek.com            → /v1/models
 *   https://api.deepseek.com/v1         → /v1/models
 *   https://api.openai.com/v1           → /v1/models
 *   https://xxx/v1/chat/completions     → 剥掉路径尾巴，按 /v1 处理（有人直接从文档里抄整条 URL）
 * 拿不到 `/v1/models` 时再退回 `{base}/models`（老网关/OneAPI 有的只暴露这一个）。
 *
 * **失败不清空已有的列表**：一次网络抖动、一次 8 秒超时，都会让下拉从「能选 2 个」
 * 变成「读取失败」，用户就会觉得「填了还是读不到」。错误只记到 error 上，
 * 只要地址没换，上次读到的名字继续留着。
 */
export async function refreshCloud(url, key) {
  const base = normalizeBase(url);
  const k = String(key || '').trim();
  if (!base) return { ok: false, reason: 'no-url' };
  if (!k) return { ok: false, reason: 'no-key' };
  if (cloudInflight) return cloudInflight;

  const roots = /\/v\d+$/.test(base) ? [base] : [`${base}/v1`, base];
  cloudInflight = (async () => {
    let lastErr = '';
    for (const root of roots) {
      try {
        const res = await fetch(`${root}/models`, {
          headers: { authorization: `Bearer ${k}` },
          signal: AbortSignal.timeout(8000),
        });
        const body = await res.text();
        if (!res.ok) {
          let detail = body.slice(0, 140);
          try {
            const j = JSON.parse(body);
            detail = (j.error && (j.error.message || j.error.type)) || detail;
          } catch { /* 非 JSON 就按原文截断 */ }
          lastErr = explainCloudError(res.status, detail);
          continue; // 换个端点再试（/v1 与裸 base 有的网关只认其中一个）
        }
        let j;
        try {
          j = JSON.parse(body);
        } catch {
          lastErr = '返回的不是 JSON，这个地址可能不是 OpenAI 兼容接口';
          continue;
        }
        const list = Array.isArray(j.data)
          ? j.data.map((m) => m && (m.id || m.name))
          : Array.isArray(j.models)
            ? j.models.map((m) => m && (m.name || m.model || m.id))
            : [];
        const models = list
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
          // 云端也可能有向量模型（vLLM / 自建网关常见），它们在卡①②③ 里跑不出话，直接不列
          .filter((x) => guessKind(x) !== 'embed');
        // 读到了：即使一个模型也读出来，也算成功（空表说明账号没开通任何模型）
        writeCloudCache({ at: Date.now(), url: base, models, error: '' });
        return { ok: true, count: models.length };
      } catch (e) {
        lastErr = explainFetchError(e);
      }
    }
    // 全都失败：保留上次成功读到的名字（同一个地址才保留，换了地址就该清）
    const prev = readCloudCache();
    const keep = prev.url === base ? prev.models : [];
    writeCloudCache({ at: Date.now(), url: base, models: keep, error: lastErr || '读不到模型列表' });
    return { ok: false, reason: 'http', error: lastErr };
  })().finally(() => { cloudInflight = null; });
  return cloudInflight;
}

/** 把用户手填的地址收拾成 base（可能带 /v1）。 */
export function normalizeBase(url) {
  let s = String(url || '').trim().replace(/\s+/g, '');
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  // 从文档里整条抄下来的情况
  s = s.replace(/\/(chat\/)?completions$/i, '').replace(/\/embeddings$/i, '').replace(/\/models$/i, '');
  s = s.replace(/\/+$/, '');
  return s;
}

/** 把 HTTP 状态翻成一句人话 —— 用户看见「openai 401」不知道要改哪儿。 */
function explainCloudError(status, detail) {
  const d = String(detail || '').trim();
  if (status === 401 || status === 403) return `Key 不对或没权限（HTTP ${status}）。${d ? `接口说：${d}` : ''}`;
  if (status === 404) return `地址不对（HTTP 404）：多半少了 /v1，或这个服务不提供 /models`;
  if (status === 429) return `被限流了（HTTP 429），过一会儿再点`;
  if (status >= 500) return `服务端出错（HTTP ${status}），不是 Key 的问题`;
  return `HTTP ${status}${d ? `：${d}` : ''}`;
}

function explainFetchError(e) {
  const s = String((e && e.message) || e);
  if (/timeout|abort/i.test(s)) return '连不上（8 秒超时）：地址写错，或这台机器访问不了外网';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s)) return '域名解析不了：地址拼错了';
  if (/ECONNREFUSED/i.test(s)) return '端口拒绝连接：地址或代理不对';
  return s;
}

/**
 * 设置页下拉被打开时顺手刷一次（不 await，不阻塞渲染）。
 * 10 秒内不重复请求：前端一次展开会连发 pointerdown + focus 两枪。
 */
export function refreshCloudLazy(url, key) {
  if (!url || !key) return;
  if (Date.now() - lastCloudAt < 3000) return;
  lastCloudAt = Date.now();
  refreshCloud(url, key).catch(() => {});
}

/**
 * 上次从 config.json 里读到的云端地址/Key。
 *
 * 为什么要记：`configOptions(kind, language)` 拿不到世界配置，只有 kind。
 * 世界 start() 时把当前配置塞进来，设置页下拉被点开时就能拿它去刷云端模型表。
 *
 * **为什么还要读盘**：`x-hot: true` 的配置项，宿主是热更 `worlds.<id>` 这个活对象，
 * **不会重启世界实例**，所以 start() 里存下来的那份永远是"填之前"的值（空）。
 * 结果是设置页明明填了地址和 Key，下拉里还在喊「先填地址」。
 * 早先这里按 5 秒节流读盘 —— 填完立刻点开下拉就正好落在节流窗口里，拿到的还是空值。
 * 现在按 config.json 的 mtime 判断，文件一变立刻用新的。
 */
let hintState = { url: '', key: '', botDir: '', mtime: 0 };

export function setCloudHint(url, key, botDir) {
  hintState = {
    url: String(url || '').trim(),
    key: String(key || '').trim(),
    botDir: String(botDir || hintState.botDir || '').trim(),
    mtime: -1, // 强制下次重新读盘
  };
}

/** 从 botDir 往上最多 5 层找 config.json，取本世界的 openaiUrl / openaiKey。 */
function readCloudFromConfigFile(botDir) {
  if (!botDir) return null;
  let dir = String(botDir);
  for (let i = 0; i < 5; i += 1) {
    const p = join(dir, 'config.json');
    try {
      if (existsSync(p)) {
        const mtime = statSync(p).mtimeMs;
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const w = j && j.worlds && j.worlds['netease-play'];
        if (w) {
          return {
            url: String(w.openaiUrl || '').trim(),
            key: String(w.openaiKey || '').trim(),
            model: String(w.openaiModel || '').trim(),
            source: String(w.modelSource || '').trim(),
            mtime,
          };
        }
      }
    } catch { /* 这个候选不行，往上再试 */ }
    const up = dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * 设置页现在该用哪个地址/Key 去刷模型表。
 *
 * 早先是「5 秒内不重复读盘」—— 于是用户填完地址立刻点开下拉，拿到的还是旧值（空），
 * 提示「先填地址」，看起来就是「填了也读不到」。改成按 config.json 的 mtime 判断：
 * 文件没变就不读（几毫秒的事，省下来也没意义），文件一变立刻用新的。
 * 磁盘上的值就是唯一事实 —— 用户清空地址，这里也必须是空。
 */
export function cloudHintState() {
  // 每次都读盘：config.json 只有几十 KB，一次 parse 是毫秒级，而这个函数只在
  // 设置页下拉被点开时才调用。换成「按 mtime 缓存」在 NTFS 上还会踩到同秒两次写入的坑，
  // 不如老老实实读 —— 用户填完点保存、立刻点下拉，就必须读到新值。
  const f = readCloudFromConfigFile(hintState.botDir);
  if (f) hintState = { url: f.url, key: f.key, botDir: hintState.botDir, mtime: f.mtime };
  return { url: hintState.url, key: hintState.key, botDir: hintState.botDir };
}

/** 磁盘上现在的云端配置（自动填模型名时用）。 */
export function cloudCfgOnDisk() {
  return readCloudFromConfigFile(hintState.botDir);
}

/** 名字兜底分类：拿不到 capabilities 时用。 */
function guessKind(name) {
  return /bge|embed|e5|gte|nomic|mxbai|jina/i.test(name) ? 'embed' : 'chat';
}

/**
 * 后台拉一遍 `/api/tags`，再对每个模型问一次 `/api/show` 取 capabilities。
 * 一次启动的代价约 9 个模型 × 几十毫秒，跑在后台，不阻塞 start()。
 */
export async function refresh(url = DEFAULT_URL) {
  const base = String(url || DEFAULT_URL).trim().replace(/\/+$/, '') || DEFAULT_URL;
  let list;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = ((await res.json()).models || []).map((m) => m.name).filter(Boolean);
  } catch {
    // 连不上：保留旧缓存（上次能用时的清单仍然可选）
    return { ok: false, reason: 'unreachable', count: readCache().models.length };
  }

  const models = [];
  for (const name of list) {
    let kind = guessKind(name);
    try {
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const caps = (await res.json()).capabilities || [];
        if (caps.includes('embedding')) kind = 'embed';
        else if (caps.includes('completion')) kind = 'chat';
        else kind = 'other';
      }
    } catch { /* 单个模型问不到就按名字猜 */ }
    models.push({ name, kind });
  }

  writeCache({ at: Date.now(), models });
  return { ok: true, count: models.length };
}

/**
 * 一次非流式对话。
 * `think: false` 必须传：本机这几个小模型默认会先吐一段思考链再给答案，
 * 不关掉的话返回里全是"用户想要…我需要…"，而且耗时翻倍。
 *
 * `numCtx` 默认 2048：minicpm5-2b-128k 的 128k 上下文是**预分配** KV cache，
 * 不管用不用都先占 6.35 GB 显存；压到 2048 只要 1.55 GB（0.8b 是 0.73 GB）。
 * 本世界的输入最长也就「性格 88 字 + 歌词 500 字 + 指令」，2048 够用。
 *
 * `numGpu` 是 ollama 的「塞几层进 GPU」，不传就全塞。传 0 是纯 CPU、显存归零。
 */
export async function chat(url, model, messages, { temperature = 0.6, numPredict = 220, numCtx = 2048, numGpu, timeoutMs = 25000 } = {}) {
  const base = String(url || DEFAULT_URL).trim().replace(/\/+$/, '') || DEFAULT_URL;
  try {
    return await chatOnce(base, model, messages, { temperature, numPredict, numCtx, numGpu, timeoutMs });
  } catch (e) {
    // 0.16.97：本机模型这条对端链路失败，单独记一份，排错先看这里
    external('model', 'chat', { url: base, model, why: String((e && e.message) || e) });
    throw e;
  }
}

async function chatOnce(base, model, messages, { temperature, numPredict, numCtx, numGpu, timeoutMs }) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      think: false,
      options: {
        temperature,
        num_predict: numPredict,
        num_ctx: numCtx,
        ...(numGpu === undefined ? {} : { num_gpu: numGpu }),
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  return String((j && j.message && j.message.content) || '').trim();
}
