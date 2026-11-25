/**
 * 「模型」页签的后端（0.0.1.6.5）。
 *
 * 为什么开这个页签：宿主设置页没有条件隐藏字段（x-hidden / x-when 都没有），
 * string 也一律是明文输入框，没有 password 类型。所以云端那四项从设置页 schema 里
 * 拿掉了，搬到这里 —— 开关一关，云端整块直接不渲染；Key 始终是密文，
 * 而且**后端从不把完整 Key 回传给前端**，只给「已设置 · 尾号 xxxx」。
 *
 * 配置仍然存在宿主 config.json 的 worlds."netease-play" 里（代码照旧读 cfg），
 * 写回走 ctx.persist —— 它不校验 schema，所以删掉声明之后照样能写。
 */
import {
  refreshCloud,
  cloudModelNames,
  cloudCacheState,
  cloudModelName,
  modelMode,
  modelNames,
  normalizeBase,
  CHAT_KIND,
  setCloudHint,
} from './ollama.js';

/** 只留最后四位，中间一律星号。 */
function maskKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (k.length <= 6) return '*'.repeat(k.length);
  return `${'*'.repeat(Math.min(6, k.length - 4))}${k.slice(-4)}`;
}

function source(cfg) {
  const s = String((cfg && cfg.modelSource) || 'local').trim();
  return s === 'cloud' ? 'cloud' : 'local';
}

/** 快照：给页面画第一屏。**不含 Key 明文**。 */
export function cloudPanelSnapshot(cfg) {
  const c = cfg || {};
  const key = String(c.openaiKey || '').trim();
  const localModel = String(c.chatModel || '').trim();
  return {
    ok: true,
    source: source(c),
    mode: modelMode(c), // local / cloud / none —— 配没配齐一看就知道
    cloud: {
      url: String(c.openaiUrl || '').trim(),
      keySet: Boolean(key),
      keyMask: maskKey(key),
      keyTail: key ? key.slice(-4) : '',
      model: cloudModelName(c),
      modelList: cloudModelNames(),
      state: cloudCacheState(),
    },
    local: {
      url: String(c.ollamaUrl || '').trim(),
      model: localModel,
      embed: String(c.embedModel || '').trim(),
      vram: String(c.vramMode || '').trim(),
      modelList: modelNames(CHAT_KIND),
    },
  };
}

/**
 * ctx.persist 在宿主里是同步写内存 + 落盘；测试里传的假 ctx 没有它，
 * 就退回直接改对象，至少让调用方看到新值。
 */
function persist(ctx, cfg, patch) {
  const p = ctx && typeof ctx.persist === 'function' ? ctx.persist : null;
  if (p) {
    p(patch);
    return { saved: true, how: 'persist' };
  }
  Object.assign(cfg || {}, patch);
  return { saved: false, how: 'local' };
}

/** 开关：本机 / 云端。切换不做别的副作用，云端填什么都没关系，报错由卡①②③ 自己显示。 */
export function cloudPanelSetSource(ctx, cfg, src) {
  const next = src === 'cloud' ? 'cloud' : 'local';
  persist(ctx, cfg, { modelSource: next });
  if (cfg) cfg.modelSource = next;
  return { ok: true, ...cloudPanelSnapshot(cfg) };
}

/**
 * 保存云端三项。
 *
 * Key 留空 = 不改（页面上永远显示密文，不能让人为了换个地址就把 Key 重打一遍）。
 * 地址会归一化：末尾斜杠、误抄的整条 /chat/completions、漏 /v1 都在这儿兜住。
 */
export function cloudPanelSave(ctx, cfg, a) {
  const c = cfg || {};
  const patch = {};
  const url = String((a && a.url) || '').trim();
  if (url) {
    const base = normalizeBase(url);
    if (!base) return { ok: false, error: '地址看着不像个 URL' };
    patch.openaiUrl = base;
  }
  const key = String((a && a.key) || '').trim();
  if (key) patch.openaiKey = key;
  const model = String((a && a.model) || '').trim();
  // 模型名写进 openaiModel；选了名字就把手填兜底清掉，免得两处打架
  if (model) {
    patch.openaiModel = model;
    patch.openaiModelManual = '';
  }
  if (!Object.keys(patch).length) return { ok: true, ...cloudPanelSnapshot(c) };
  persist(ctx, c, patch);
  Object.assign(c, patch);
  // 地址或 Key 变了，提示状态要跟着重算（不然后面 refreshCloud 还会按旧的缓存判）
  setCloudHint(c.openaiUrl, c.openaiKey, ctx && ctx.botDir);
  return { ok: true, saved: true, ...cloudPanelSnapshot(c) };
}

/**
 * 现读一遍模型清单。用的是页面上的草稿（还没保存也行），
 * 这样「先填地址再点读取」不会因为没保存就读不到 —— 上一版就是这么坑的。
 */
export async function cloudPanelList(ctx, cfg, a) {
  const c = cfg || {};
  const url = String((a && a.url) || '').trim() || String(c.openaiUrl || '').trim();
  const key = String((a && a.key) || '').trim() || String(c.openaiKey || '').trim();
  if (!url) return { ok: false, error: '先填接口地址', ...cloudPanelSnapshot(c) };
  if (!key) return { ok: false, error: '先填 API Key（原来的 Key 只显示尾号，想换请整条重填）', ...cloudPanelSnapshot(c) };
  const r = await refreshCloud(url, key);
  const snap = cloudPanelSnapshot(c);
  if (r && r.ok) {
    return {
      ok: true,
      read: true,
      count: r.count,
      models: cloudModelNames(),
      ...snap,
    };
  }
  return {
    ok: false,
    read: false,
    reason: r && r.reason,
    error: (r && r.error) || (r && r.reason === 'no-key' ? 'Key 是空的' : '读不到模型列表'),
    ...snap,
  };
}
