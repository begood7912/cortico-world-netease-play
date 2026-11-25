/**
 * 总控制说明（0.16.96）。
 *
 * 这张表是整个插件的第一道判断：任何一次调用，先查这里，确认它属于「内部」还是
 * 「要对端」，再去执行。内部块只碰本机内存与 data；对端块必须经过 adapters，
 * 由 adapters 负责超时、重试与信封，业务层只看 {ok, data, error}。
 *
 * 原来的写法是「谁需要谁去 import」——结果是 world.js 同时连着 CDP、模型、TTS、
 * 宿主四类对端，改一处不知道会惊动谁。现在改成「先查表、再路由」：
 *
 *   route('cards')  → { kind: 'mixed', endpoints: ['model', 'voice'], block: ... }
 *   route('chain')  → { kind: 'internal', endpoints: [] }
 *   isEndpoint('voice') → true
 *
 * 表分四层十八块（见说明书第八章 8.4）。status 为 planned 的是重构目标、
 * 目前还没有独立文件；current 的 entry 是当下真实存在的文件。
 *
 * 维护规矩：
 *   1. 新增能力先在这张表登记，再写代码；没登记的能力不允许被调用。
 *   2. 一个块只能声明一次；entry 里的文件必须真实存在（lint 会查）。
 *   3. kind 只有三种：internal（纯内部）、endpoint（纯对端）、mixed（两者都有）。
 *   4. affects 只允许用下面 AFFECTS 里列出的名字，禁止自造。
 */

/** 影响面：一块改动可能波及的七个方面。字符串即文档矩阵的列名。 */
export const AFFECTS = ['panel', 'settings', 'chain', 'cards', 'reco', 'account', 'voice'];

/** 五个对端。id 即 route() 返回的 endpoints 元素，adapters 目录按 id 一一对应。 */
export const ENDPOINTS = {
  host: { label: '宿主', via: 'World API 6：工具声明、灯轮询、用法文档', timeoutMs: 0 },
  netease: { label: '网易云', via: 'CDP 9229 + 单曲详情接口 + Python 账号写', timeoutMs: 3000 },
  model: { label: '模型', via: '本机 Ollama 11434 或 OpenAI 兼容云端', timeoutMs: 45000 },
  voice: { label: '语音', via: 'GPT-SoVITS 9880 → wav → 播放', timeoutMs: 8000 },
  proc: { label: '子进程', via: 'py / ps1 脚本，一次一条，串行', timeoutMs: 15000 },
};

/**
 * 十八块的总表。
 * entry：当前真实文件（可多个）；status=planned 时为空数组。
 * note：一句话职责，和说明书里的模块表一一对应。
 */
export const MANIFEST = [
  // L1 接口层
  { id: 'index', layer: 'L1', status: 'current', kind: 'internal', entry: ['index.js', 'world.js', 'events.js'], affects: ['panel', 'settings', 'chain', 'cards', 'reco', 'account', 'voice'], note: '包入口与装配；events.js 是事件自描述的唯一真源（推送与 describe 共用）' },
  { id: 'tools', layer: 'L1', status: 'current', kind: 'internal', entry: ['tools.js'], affects: ['chain', 'account'], note: '四个工具的声明与结果格式化' },
  { id: 'panel', layer: 'L1', status: 'current', kind: 'internal', entry: ['panel.js'], affects: ['panel'], note: '面板四个页签的快照，只读' },

  // L2 业务层
  { id: 'chain', layer: 'L2', status: 'current', kind: 'internal', entry: ['chain.js'], affects: ['panel', 'chain', 'cards', 'voice'], note: '接力状态机与事件' },
  { id: 'listen', layer: 'L2', status: 'current', kind: 'internal', entry: ['listening.js'], affects: ['panel', 'chain', 'cards'], note: '采样节拍、30/60/90 触发、安静判定' },
  { id: 'cards', layer: 'L2', status: 'current', kind: 'mixed', endpoints: ['model', 'voice'], entry: ['cards.js', 'take.js', 'like.js', 'comment.js', 'her-reply.js', 'liked.js', 'lyric.js'], affects: ['panel', 'cards', 'voice'], note: '三张卡的生成、赞数、歌词、出声' },
  { id: 'reco', layer: 'L2', status: 'current', kind: 'mixed', endpoints: ['netease', 'model'], entry: ['recommend.js', 'chart.js', 'charts.js', 'qweather.js', 'wxreco.js'], affects: ['panel', 'reco'], note: '候选合并、打分、缓存与榜单目录；天气实况与「按天气挑歌」（卡片5）' },
  { id: 'idle', layer: 'L2', status: 'current', kind: 'mixed', endpoints: ['model', 'voice', 'netease'], entry: ['idle.js', 'wants.js', 'quiet.js', 'answers.js'], affects: ['panel', 'cards', 'voice'], note: '安静提议、想听清单、气泡回弹' },

  // L3 服务层（对端全部在这一层，业务层不许直接连）
  { id: 'netease', layer: 'L3', status: 'current', kind: 'endpoint', endpoints: ['netease'], entry: ['client.js', 'playlists.js', 'recoPlaylist.js', 'recoClear.js', 'songid.js'], affects: ['account', 'reco'], note: '客户端在不在、歌单读写、每天清零、歌曲 id 解析（账本/流水/排名页统一按 id 记）' },
  { id: 'play', layer: 'L3', status: 'current', kind: 'endpoint', endpoints: ['netease'], entry: ['play.js', 'fastplay.js', 'recoPick.js'], affects: ['chain', 'account'], note: '快慢路径放歌、落哪张歌单' },
  { id: 'py', layer: 'L3', status: 'current', kind: 'endpoint', endpoints: ['proc'], entry: ['python.js', 'proc.js', 'nowplaying.js', 'progress.js'], affects: ['chain', 'account', 'voice'], note: '子进程统一外壳（proc.js 参数表）与 SMTC 读取' },
  { id: 'model', layer: 'L3', status: 'current', kind: 'endpoint', endpoints: ['model'], entry: ['ollama.js', 'embed.js', 'cloudpanel.js'], affects: ['cards', 'reco'], note: '本机与云端模型、显存模式、向量' },
  { id: 'voice', layer: 'L3', status: 'current', kind: 'endpoint', endpoints: ['voice'], entry: ['speak.js', 'winvoice.js', 'edgevoice.js'], affects: ['cards', 'voice'], note: 'TTS 合成、分段、校验、播放（0.1.02 起多一条 Windows 自带语音，0.1.09 起多一条微软在线神经语音）' },
  { id: 'store', layer: 'L3', status: 'current', kind: 'internal', entry: ['store.js'], affects: ['panel', 'chain', 'cards', 'reco'], note: 'data 路径唯一出处：state / cache / log 三类，文件名不变，只收口路径' },

  // L4 基础层
  { id: 'constants', layer: 'L4', status: 'current', kind: 'internal', entry: ['constants.js'], affects: AFFECTS.slice(), note: '全部数值常量；采样 10 秒与切歌 10 秒并排放' },
  { id: 'source', layer: 'L4', status: 'current', kind: 'internal', entry: ['source.js'], affects: ['chain', 'reco', 'cards'], note: '推荐来源的唯一真源：接力挑歌、播报话术、刷新门控都走 activeSource()' },
  { id: 'userAction', layer: 'L4', status: 'current', kind: 'internal', entry: ['userAction.js'], affects: ['chain', 'panel'], note: '用户动作统一入口：点歌/切歌/换来源 → 接力自动停止；以后加判断只改这里' },
  { id: 'track', layer: 'L3', status: 'current', kind: 'mixed', endpoints: ['netease'], entry: ['track.js'], affects: ['chain', 'cards', 'panel', 'account'], note: '当前曲目的唯一入口：CDP 取 id/在播 + 详情接口取歌名/歌手，PowerShell 只兜底' },
  { id: 'schema', layer: 'L4', status: 'current', kind: 'internal', entry: ['settingspanel.js', 'prompts.js', 'settings.schema.js', 'quietHours.js'], affects: ['settings'], note: '40+ 个键的类型、默认值、白名单；安静时间的窗口判定' },
  { id: 'strings', layer: 'L4', status: 'current', kind: 'internal', entry: ['strings.js'], affects: ['panel', 'settings'], note: '全部说明文字，一张表 + 固定 ID（已收设置页 30 项 · 60 个 ID）' },
  { id: 'log', layer: 'L4', status: 'current', kind: 'internal', entry: ['log.js'], affects: ['panel', 'chain', 'cards', 'reco'], note: '事件统一信封 {at, type, ...}（data/log/events.jsonl）；对端失败另走 data/log/external.log' },
];

const BY_ID = new Map(MANIFEST.map((b) => [b.id, b]));

/** 查一块。返回表里那一条，找不到给 null。 */
export function cap(id) {
  return BY_ID.get(String(id || '')) || null;
}

/** 路由：一次调用该走哪里。业务代码只认这个返回值。 */
export function route(id) {
  const b = cap(id);
  if (!b) return { ok: false, id, error: `未登记的块：${id}` };
  const endpoints = b.kind === 'internal' ? [] : (b.endpoints || []);
  return {
    ok: true,
    id: b.id,
    kind: b.kind,
    endpoints,
    external: endpoints.length > 0,
    entry: b.entry,
    affects: b.affects,
    note: b.note,
  };
}

/** 这块要不要出网/起进程。 */
export function isExternal(id) {
  const b = cap(id);
  return !!b && b.kind !== 'internal' && (b.endpoints || []).length > 0;
}

/** 两个分栏：内部块 / 对端块，给「返回时直接引用对端」的场景用。 */
export function manifestSummary() {
  const internal = [];
  const external = [];
  for (const b of MANIFEST) {
    if (b.kind === 'internal') internal.push({ id: b.id, kind: 'internal', entry: b.entry, status: b.status });
    else external.push({ id: b.id, kind: b.kind, endpoints: b.endpoints, entry: b.entry, status: b.status });
  }
  return { internal, external, endpoints: Object.keys(ENDPOINTS) };
}

/** 某块允许被谁调用：内部块禁止连对端，对端块只许业务层经 adapters 调。 */
export function assertRoutable(id) {
  const b = cap(id);
  if (!b) throw new Error(`未登记的块：${id}`);
  if (b.kind === 'internal') {
    for (const f of b.entry) {
      if (f === 'world.js') continue; // 门面暂代，拆分后移除
      // 内部块不允许出现 adapters 目录下的文件
      if (String(f).startsWith('adapters/')) throw new Error(`内部块 ${id} 引用了对端文件 ${f}`);
    }
  }
  return b;
}
