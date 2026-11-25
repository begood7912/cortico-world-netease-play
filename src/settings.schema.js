/**
 * 设置项的唯一定义（0.16.96）。
 *
 * 以前同一个默认值写在三处：index.js 的 defaults()（宿主设置页用）、settingspanel.js 的
 * DEFAULTS（自己那一页用）、world.js 的 BOOL_DEFAULTS（运行时的兜底）。三处靠注释约定一致，
 * 改一处漏两处是迟早的事。这里收成一份：类型、默认值、范围、归属分组、影响的块、说明文字 ID。
 *
 * 用法：
 *   DEFAULTS      —— 全部键的默认值（对象）
 *   SETTING_KEYS  —— 可写白名单，顺序仍是「布尔 → 数字 → 文本」
 *   RANGES        —— 数字键的上下限
 *   PROMPT_KEYS   —— 六段提示词
 *
 * 说明文字不在这里写死，只存 ID（set.<键>.title / set.<键>.desc），
 * 等 strings 那一块建好后由它出文字；现在前端仍然读自己那份文案，两边不冲突。
 *
 * 注意 amount：index.js 的宿主设置页仍保留自己的一份 defaults，其中 vramMode 是 'auto'，
 * 这里按实际使用的一页取 'eco'。合并那两处之前必须先定哪个为准（已知差异，未擅自改）。
 */
import { DEFAULT_CHART_IDS } from './charts.js';

const t = (key) => ({ titleId: `set.${key}.title`, descId: `set.${key}.desc` });

/** 一条：type 只认 bool / int / str / text；group 用于设置页分组；affects 用 manifest 的七面。 */
const def = (key, type, def_, extra = {}) => [key, { key, type, default: def_, ...t(key), ...extra }];

export const SETTING_SCHEMA = Object.fromEntries([
  // 陪听（accompany）
  // 0.17.43（D4）：下面两个是**历史键**，设置页已无入口，只在老配置/代码判断里保留：
  //   cardHear —— 0.16.44 那版的卡② 单开关，cards.js 仍尊重它（关过的人升级后不该自己又开口）
  //   sayHead  —— 0.16.56 拆出来的，已不参与任何判断，纯兼容
  // 想彻底删要同时改 cards.js 的判定和存量 config，别只删这里。
  def('cardsOn', 'bool', true, { group: 'accompany', affects: ['cards', 'voice'] }),
  def('cardHear', 'bool', true, { group: 'accompany', affects: ['cards'] }),
  def('cardFeel', 'bool', true, { group: 'accompany', affects: ['cards'] }),
  def('cardComment', 'bool', true, { group: 'accompany', affects: ['cards'] }),
  def('cardsPreview', 'bool', true, { group: 'accompany', affects: ['cards'] }),
  def('showLiked', 'bool', true, { group: 'accompany', affects: ['cards', 'panel'] }),
  def('sayHead', 'bool', true, { group: 'accompany', affects: ['cards', 'voice'] }),
  def('sayBody', 'bool', true, { group: 'accompany', affects: ['cards', 'voice'] }),
  def('sayBodyFirst', 'bool', false, { group: 'accompany', affects: ['cards', 'voice'] }),
  def('announce', 'bool', true, { group: 'accompany', affects: ['cards', 'voice'] }),
  // 安静时间（0.17.11）：这段时间一句都不出声，自动推歌也不触发；后台刷新照常
  def('quietStart', 'str', '23:00', { group: 'accompany', affects: ['cards', 'voice', 'chain'] }),
  def('quietEnd', 'str', '07:00', { group: 'accompany', affects: ['cards', 'voice', 'chain'] }),
  def('quietOn', 'bool', false, { group: 'accompany', affects: ['cards', 'voice', 'chain'] }),

  // 接力与此刻（chain）
  def('selfPick', 'bool', true, { group: 'chain', affects: ['cards', 'panel'] }),
  def('idleFirstMin', 'int', 5, { group: 'chain', range: [1, 240], affects: ['cards', 'panel'] }),
  // 0.17.61（用户口径）：刚开机那阵子不发安静提示 —— 模型和向量还没算完（1 分钟不够）。0 = 不拦。
  def('idleBootGuardMin', 'int', 5, { group: 'chain', range: [0, 60], affects: ['cards', 'panel'] }),
  def('idleRepeatMin', 'int', 60, { group: 'chain', range: [0, 1440], affects: ['cards', 'panel'] }),
  def('askTwoOnly', 'bool', false, { group: 'chain', affects: ['cards', 'panel'] }),
  def('chainPick', 'bool', true, { group: 'chain', affects: ['chain', 'panel'] }),
  def('chainSpeak', 'bool', true, { group: 'chain', affects: ['chain', 'voice'] }),
  // 0.17.33：接力挑歌的来源二选一 —— 'reco' = 卡①「今天听点什么」，'wx' = 卡片5「按天气听点什么」
  def('chainSource', 'str', 'reco', { group: 'chain', affects: ['chain', 'panel'] }),
  def('chainPlaylist', 'bool', false, { group: 'chain', affects: ['account', 'chain'] }),
  def('chainClearDaily', 'bool', true, { group: 'chain', affects: ['account'] }),
  def('chainClearHour', 'int', 6, { group: 'chain', range: [0, 23], affects: ['account'] }),
  // AI 设置（0.17.2）：随机播放请求 → 用 AI 推荐 + 自动开启接力
  def('aiRandomChain', 'bool', true, { group: 'ai', affects: ['chain', 'reco', 'cards'] }),
  // 0.17.10：发给 AI 的前置语句（netease_play 的工具说明：怎么挑歌、放好以后怎么说）。
  // 留空 = 用 tools.js 里那份默认，一个字都不改。
  def('aiPlayPrompt', 'str', '', { group: 'ai', affects: ['cards', 'chain'] }),
  def('chainCharts', 'str', DEFAULT_CHART_IDS.join(','), { group: 'chain', affects: ['reco', 'chain'] }),

  // 听歌（music）
  def('playlist', 'str', '', { group: 'music', affects: ['account', 'chain'] }),
  def('autoFav', 'bool', true, { group: 'music', affects: ['account'] }),
  def('favThreshold', 'int', 2, { group: 'music', range: [2, 20], affects: ['account'] }),
  def('allowRestart', 'bool', false, { group: 'music', affects: ['account'] }),
  def('cdpPort', 'int', 9229, { group: 'music', range: [1, 65535], affects: ['account', 'chain'] }),
  def('clientExe', 'str', '', { group: 'music', affects: ['account'] }),

  // 模型与语音（store）
  def('modelSource', 'str', 'local', { group: 'store', affects: ['cards', 'reco'] }),
  def('ollamaUrl', 'str', 'http://127.0.0.1:11434', { group: 'store', affects: ['cards', 'reco'] }),
  def('embedModel', 'str', '', { group: 'store', affects: ['reco'] }),
  def('vramMode', 'str', 'eco', { group: 'store', affects: ['cards', 'reco'] }),
  def('chatModel', 'str', '', { group: 'store', affects: ['cards'] }),
  def('ttsUrl', 'str', 'http://127.0.0.1:9880', { group: 'store', affects: ['voice'] }),
  /* 0.1.02（用户口径）：出声不再只有 GPT-SoVITS 一条路。'gpt' = 本机 HTTP 服务（原行为），
     'windows' = 系统自带 System.Speech（不要任何服务，音质看装没装中文语音包）。
     ttsVoice 两条路共用：gpt 那路是服务端 voice 名，windows 那路是 SAPI 语音名；空 = 各自默认。 */
  def('ttsEngine', 'str', 'gpt', { group: 'store', affects: ['voice'] }),
  def('ttsVoice', 'str', '', { group: 'store', affects: ['voice'] }),

  // 天气（0.17.25）：照「实时天气」配置页搬进来的几项，落在 worlds."netease-play" 里
  /* 0.17.68（用户口径）：这两个原来是「我这台机器填的值」被当成了默认 —— 发布出去等于把
     私人天气域名、常住城市一起发出去。默认必须是空的，由使用者自己填。 */
  def('qwApiHost', 'str', '', { group: 'store', affects: ['panel'] }),
  def('qwApiKey', 'str', '', { group: 'store', affects: ['panel'] }),
  def('qwInterval', 'int', 15, { group: 'store', range: [1, 240], affects: ['panel'] }),
  def('qwAlign', 'bool', false, { group: 'store', affects: ['panel'] }),
  def('qwAdmin', 'str', '', { group: 'store', affects: ['panel'] }),
  def('qwCountryCode', 'str', '', { group: 'store', affects: ['panel'] }),
  def('qwCity', 'str', '', { group: 'store', affects: ['panel'] }),

  // 提示词六段
  def('promptHearHead', 'text', '', { group: 'prompt', affects: ['cards'] }),
  def('promptHearTail', 'text', '', { group: 'prompt', affects: ['cards'] }),
  def('promptFeelHead', 'text', '', { group: 'prompt', affects: ['cards'] }),
  def('promptFeelTail', 'text', '', { group: 'prompt', affects: ['cards'] }),
  def('promptCommentHead', 'text', '', { group: 'prompt', affects: ['cards'] }),
  def('promptCommentTail', 'text', '', { group: 'prompt', affects: ['cards'] }),
]);

/** 全部键的默认值。 */
export const DEFAULTS = Object.fromEntries(
  Object.values(SETTING_SCHEMA).map((s) => [s.key, s.default]),
);

const keysOf = (...types) => Object.values(SETTING_SCHEMA).filter((s) => types.includes(s.type)).map((s) => s.key);

export const BOOL_KEYS = keysOf('bool');
export const INT_KEYS = keysOf('int');
export const PROMPT_KEYS = keysOf('text');
export const STR_KEYS = [...keysOf('str'), ...PROMPT_KEYS];

/** 数字键的上下限，与旧表逐项一致。 */
export const RANGES = Object.fromEntries(
  Object.values(SETTING_SCHEMA).filter((s) => s.type === 'int').map((s) => [s.key, s.range]),
);

/** 可写白名单：布尔 → 数字 → 文本，顺序与旧版一致（快照顺序不影响行为，只是好对照）。 */
export const SETTING_KEYS = [...BOOL_KEYS, ...INT_KEYS, ...STR_KEYS];

/** 某几块会影响哪些键 —— 与 manifest 的 AFFECTS 互为镜像，用于「改开关动了哪儿」的反查。 */
export function keysAffecting(face) {
  return Object.values(SETTING_SCHEMA).filter((s) => s.affects.includes(face)).map((s) => s.key);
}

/** 自检：键名唯一、范围只出现在数字项、影响面合法。返回问题数组（空 = 通过）。 */
export function lintSchema(allowedFaces = []) {
  const problems = [];
  const seen = new Set();
  for (const s of Object.values(SETTING_SCHEMA)) {
    if (seen.has(s.key)) problems.push(`重复的键：${s.key}`);
    seen.add(s.key);
    if (s.type === 'int' && !Array.isArray(s.range)) problems.push(`${s.key} 是数字项却没有范围`);
    if (s.type !== 'int' && s.range) problems.push(`${s.key} 不是数字项却带了范围`);
    if (!s.titleId || !s.descId) problems.push(`${s.key} 缺少文字 ID`);
    if (allowedFaces.length) {
      for (const f of s.affects) if (!allowedFaces.includes(f)) problems.push(`${s.key} 的影响面未定义：${f}`);
    }
  }
  if (SETTING_KEYS.length !== Object.keys(SETTING_SCHEMA).length) problems.push('白名单数量与定义数量不一致');
  return problems;
}


