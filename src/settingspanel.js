/**
 * 「设置」页签的后端（0.16.50）。
 *
 * 为什么再开一页：宿主设置页一个配置组只能画成一张平铺卡，不能折叠、不能分组收起，
 * 十几项摊开太长。宿主本身有折叠卡原语（ui.foldSheet），但那只有 world 自己的面板能用。
 * 所以把全部开关搬到自己的一页里，按四张折叠卡分组（用户口径：陪听开关 / 此刻设置 /
 * 听歌设置 / 数据库设置），宿主设置页那份先留着不动，确认这页能做起来再拆掉旧的那块。
 *
 * 写回：ctx.persist(patch) —— 宿主直接写 worlds."netease-play" 并落盘，不校验 schema，
 * 所以键在设置页 schema 里删掉之后照样写得进去（和 cloudpanel.js 同一套打法）。
 * 注意 persist 只写不读：写完要自己 Object.assign(cfg, patch)，否则本进程还按旧值跑
 * （云端的 setCloudHint 也是同一个道理）。
 */
import { options as playlistOptions, nameById } from './playlists.js';
import { modelNames, EMBED_KIND, CHAT_KIND } from './ollama.js';
import { promptDefaults } from './prompts.js';
import { chartOptions, chartNames, joinChartIds, parseChartIds, MAX_CHARTS } from './charts.js';
import { invalidateRecommend } from './recommend.js';
// 0.17.39：换「接力按哪张卡挑」= 换来源 —— 旧承诺作废、两路缓存都作废
import { clearSourceState } from './chain.js';
import { invalidateWxReco } from './wxreco.js';
// 0.17.43（A8）：换来源也算用户动作
import { markUserAction } from './userAction.js';
import { voicesCached, refreshVoices } from './winvoice.js';
import * as edgevoice from './edgevoice.js';
import { DEFAULT_PLAY_PROMPT } from './tools.js';
import fs from 'node:fs';
import path from 'node:path';

import { SETTING_SCHEMA, DEFAULTS, BOOL_KEYS, INT_KEYS, STR_KEYS, PROMPT_KEYS, RANGES, SETTING_KEYS } from './settings.schema.js';
import { texts as allTexts } from './strings.js';
import { cachePath } from './store.js';
// 0.17.43（C4）：设置页要能看见/切换「她现在保持安静」这个临时状态
import { peekQuiet } from './quiet.js';
// 0.17.45（C2）：端口改了立刻让采样器跟上
import { setSamplerPort } from './listening.js';

/**
 * 0.17.43（C5）：提示词一改，三张卡的缓存句子立刻作废。
 * 以前句子缓存 12 小时，用户改完提示词看不到变化，以为"设了没反应"。
 * 只删这三个文件，不动账本/流水。
 */
const PROMPT_CACHE_FILES = ['her-take.json', 'her-like.json', 'her-reply.json'];
function invalidatePromptCaches() {
  for (const name of PROMPT_CACHE_FILES) {
    try { fs.unlinkSync(cachePath(name)); } catch { /* 不存在也无所谓 */ }
  }
}

/**
 * 默认值、白名单、范围全部来自 settings.schema.js —— 这里是唯一来源。
 * 以前三处各写一份（index / 这里 / world），改一处漏两处；现在这里只负责按类型规整。
 */
const normBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * 0.17.22：设置页「扩展信息」卡要的那几行 —— 全部从本包的 package.json 读，
 * 不另写一份常量，免得版本号改一处漏一处。读一次就缓存。
 * 对应宿主扩展页那张卡：标题 / 包名@版本 / 简介 / 作者 / 已安装版本 / 安装位置 / 最新版本。
 */
let aboutCache = null;
export function aboutInfo(ctx) {
  if (aboutCache) return aboutCache;
  try {
    const dir = String((ctx && ctx.packageDir) || '');
    if (!dir) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const c = pkg.cortico || {};
    aboutCache = {
      displayName: String(c.displayName || pkg.name || ''),
      name: String(pkg.name || ''),
      version: String(pkg.version || ''),
      description: String(pkg.description || ''),
      author: typeof pkg.author === 'string' ? pkg.author : String((pkg.author && pkg.author.name) || ''),
      dir,
      repository: String((pkg.repository && pkg.repository.url) || ''),
      homepage: String(pkg.homepage || ''),
      bugs: String((pkg.bugs && pkg.bugs.url) || ''),
    };
    return aboutCache;
  } catch {
    return null;
  }
}

/**
 * 快照：全部设置值 + 下拉选项。
 *
 * `known` 标出这一项在 config.json 里到底有没有显式写过 —— 直觉上「没设置」和「设成关」
 * 长得一样，出问题时这行字能省一顿排查（0.16.47 那次五个灰开关就是这么找出来的）。
 */
export function settingsSnapshot(cfg, language, ctx) {
  const c = cfg || {};
  const values = {};
  const known = {};
  for (const k of SETTING_KEYS) {
    const raw = c[k];
    if (k === 'chainCharts') {
      // 存进去的可能是乱序、带空格、混了已下线榜 id 的串 —— 一律规整后再给前端
      values[k] = raw == null || raw === '' ? DEFAULTS[k] : joinChartIds(raw);
    } else if (k === 'playlist' || k === 'clientExe' || k === 'embedModel' || k === 'chatModel') {
      values[k] = raw == null ? DEFAULTS[k] : String(raw);
    } else if (BOOL_KEYS.includes(k)) {
      values[k] = raw == null ? DEFAULTS[k] : normBool(raw);
    } else if (INT_KEYS.includes(k)) {
      const n = Number(raw);
      values[k] = Number.isFinite(n) && raw != null && raw !== '' ? n : DEFAULTS[k];
    } else {
      values[k] = raw == null || raw === '' ? DEFAULTS[k] : String(raw);
    }
    known[k] = raw != null;
  }
  // 0.17.25：API Key 不回传明文 —— 前端只显示「已设置」占位，留空即不改。
  values.qwApiKey = '';
  /* 0.1.04：语音下拉的数据源。缓存过期就在后台探一次（不 await），
     下一次刷新面板时列表就齐了。0.1.09：微软在线语音那张表同理。 */
  void refreshVoices();
  void edgevoice.refreshVoices();
  /* 在线语音没有「空 = 系统默认」这一说，空值直接落到晓晓，免得下拉显示空白 */
  if (values.ttsEngine === 'edge') values.ttsVoice = edgevoice.pickVoice(values.ttsVoice);

  return {
    ok: true,
    values,
    known,
    playlistName: nameById(values.playlist) || '',
    // 0.16.60：勾的榜名字（摘要/面板显示用，别让前端自己再查一遍目录）
    chainChartNames: chartNames(parseChartIds(values.chainCharts)),
    chainChartMax: MAX_CHARTS,
    options: settingsOptions(language, c),
    // 0.16.52：六段提示词的默认文案 —— 前端拿它当输入框占位符，也给「还原默认」用
    promptDefaults: promptDefaults(),
    // 0.16.96：全部说明文字按 ID 给一份（前端优先用它，缺失时回退自己那份文案）
    texts: allTexts(language),
    // 0.17.10：发给 AI 的前置语句默认版（「AI 设置」里那个大文本框的占位符）
    aiPlayPromptDefault: DEFAULT_PLAY_PROMPT,
    // 0.17.22：设置页「扩展信息」卡的数据（宿主扩展页那张卡的同样几行）
    about: aboutInfo(ctx),
    // 0.17.25：天气卡片（主机 / 密钥是否配好 / 间隔 / 地点）
    weather: weatherSnapshot(c),
    // 0.17.43（C4）：临时「保持安静」的状态（不落盘，重启即恢复）
    quiet: peekQuiet(c),
  };
}

/* 0.1.07（用户口径）：语音引擎登记表。加一路新引擎 = 在数组里加一项，
   设置页的下拉、音色候选、落库校验全都自动跟上，不用再改三处。 */
const TTS_ENGINES = [
  {
    value: 'gpt',
    label: 'GPT-SoVITS',
    needsUrl: true,
    // 这一路只有「随语音包配置」一个音色，设置页不必画音色框
    pickable: false,
    voices: (_c, zh) => [
      { value: '', label: zh ? '随大肥鱼全能语音包配置' : 'Follows the 大肥鱼 voice pack' },
    ],
    // GPT 那路一律用服务端默认音色（0.1.05 口径），填什么都不算数
    pick: () => '',
  },
  {
    value: 'windows',
    label: 'Windows TTS',
    needsUrl: false,
    // 系统语音是枚举出来的，一定有得选；缓存还没热也照画，别让框忽隐忽现
    pickable: true,
    voices: (_c, zh) => [{ value: '', label: zh ? '系统默认' : 'System default' }].concat(
      voicesCached().voices.map((v) => ({ value: v.name, label: `${v.name}（${v.culture || '?'}）` })),
    ),
    // 只认系统里真装了的那些；写歪了（或那套语音被卸载）就当「系统默认」。列表没探到不拦。
    pick: (v) => {
      const known = voicesCached().voices.map((x) => x.name);
      return v && known.length && !known.includes(v) ? '' : v;
    },
  },
  {
    // 0.1.09（用户口径：「xiaoxiao 那些」）：微软在线神经语音，免费、不用 Key，
    // 但句子要走网，且本机得装 python 的 edge-tts（`pip install edge-tts`）。
    value: 'edge',
    label: '微软在线语音',
    needsUrl: false,
    pickable: true,
    voices: (_c, zh) => edgevoice.zhVoiceOptions(zh),
    pick: (v) => edgevoice.pickVoice(v),
  },
];

/** 拿当前引擎那一项；值不认识就落到第一项（GPT-SoVITS）。 */
function engineOf(value) {
  return TTS_ENGINES.find((e) => e.value === value) || TTS_ENGINES[0];
}

/** 下拉数据。歌单与模型表都是同步缓存（面板首屏不能等了再画）。 */
export function settingsOptions(language, cfg) {
  const zh = !language || String(language).toLowerCase().startsWith('zh');
  const c = cfg || {};
  const eng = engineOf(c.ttsEngine);
  return {
    playlist: playlistOptions(),
    /* 0.16.60：榜单多选。不分「一个 / 三个下拉」，就一组选项，前端按 group 画成
       主力榜 / 曲风 / 黑胶VIP / 实时 / 外部 / 平台合作 / 车友 七段。 */
    chainCharts: chartOptions(),
    modelSource: [
      { value: 'local', label: zh ? '本机 Ollama' : 'Local Ollama' },
      { value: 'cloud', label: zh ? '云端（OpenAI 兼容）' : 'Cloud (OpenAI compatible)' },
    ],
    vramMode: [
      { value: 'auto', label: zh ? '自动' : 'Auto' },
      { value: 'eco', label: zh ? '省显存' : 'Save VRAM' },
      { value: 'cpu', label: zh ? '纯 CPU' : 'CPU only' },
    ],
    embedModel: modelNames(EMBED_KIND).map((m) => ({ value: m, label: m })),
    chatModel: modelNames(CHAT_KIND).map((m) => ({ value: m, label: m })),
    /* 0.1.07（用户口径）：语音引擎做成一张登记表 —— 以后接新引擎就往下加一项，
       引擎下拉和它后面那个音色下拉都是从这里长出来的。
       value 是落库值；label 是按钮上的字；needsUrl 决定这一路要不要填地址；
       voices() 给音色下拉；pick() 把写歪的值收回合法范围。 */
    ttsEngine: TTS_ENGINES.map((e) => ({ value: e.value, label: e.label })),
    ttsVoice: eng.voices(c, zh),
    // 0.1.08：引擎这一路要不要填地址 / 要不要画音色框 —— 前端据此决定画不画
    ttsUrlNeeded: eng.needsUrl,
    ttsVoicePickable: eng.pickable === true,
  };
}

/**
 * 0.17.39（用户口径）：「接力按哪张卡挑」这个 2 选 1 是**来源总开关**。
 * 换的一瞬间要做三件事，否则用户看到的是「切了没反应」或「面板说 A、放出来 B」：
 *   ① 旧来源挑好/已播报的那一首作废（`clearSourceState`，含面板上的预告）
 *   ② 两路缓存的时间戳都清掉 —— 新来源下一次快照立刻重算，切回来也是新的
 *   ③ 只清时间戳、不主动算：另一路的刷新由 source.js 的门控彻底停掉
 */
function applySourceSwitch(value) {
  try { clearSourceState(); } catch { /* 没有活着的接力，没什么可清 */ }
  invalidateRecommend();
  invalidateWxReco();
  markUserAction('source', value === 'wx' ? '按天气' : '按听歌历史');
  console.log('[netease-play] 推荐来源切换为:', value === 'wx' ? '按天气' : '按听歌历史');
}

/**
 * 写一项。返回新快照，前端拿它重画摘要。
 *
 * 类型按左边这张表规整：布尔只认 true/false，数字夹到上下限，字符串 trim。
 * 规整后再落盘 —— 传个 "abc" 进 cdpPort 不能变成 NaN 存进 config.json。
 */
export function settingsSet(ctx, cfg, a) {
  const c = cfg || {};
  const key = String((a && a.key) || '').trim();
  if (!SETTING_KEYS.includes(key)) return { ok: false, error: `不认识的设置项：${key || '(空)'}` };

  let value;
  if (BOOL_KEYS.includes(key)) {
    value = normBool(a.value);
  } else if (INT_KEYS.includes(key)) {
    const n = Number(a.value);
    // 展开放在前面:snapshot 自带 ok:true,写在后面会把 ok:false 盖掉（自测抓到的）
    if (!Number.isFinite(n)) return { ...settingsSnapshot(c), ok: false, error: '这里要填数字' };
    const [lo, hi] = RANGES[key];
    value = Math.min(hi, Math.max(lo, Math.round(n)));
  } else {
    value = String(a.value ?? '').trim();
    if (key === 'modelSource') value = value === 'cloud' ? 'cloud' : 'local';
    // 0.17.33：接力来源二选一，只认这两个；写歪了一律当「今天听点什么」
    if (key === 'chainSource') value = value === 'wx' ? 'wx' : 'reco';
    if (key === 'vramMode') value = ['auto', 'eco', 'cpu'].includes(value) ? value : 'eco';
    /* 0.1.07：音色按「当前那一路引擎」校验，各引擎的规则写在登记表里。 */
    if (key === 'ttsVoice') value = engineOf(c.ttsEngine).pick(value);
    if (key === 'ttsEngine') value = TTS_ENGINES.some((e) => e.value === value) ? value : 'gpt';
    // 0.16.60：多选榜传上来的是数组或逗号串，统一规整成「合法、去重、封顶」的逗号串
    if (key === 'chainCharts') value = joinChartIds(value);
    // 提示词手滑贴进来几万字也没意义，留个上限（正常一段也就几十上百字）
    if (PROMPT_KEYS.includes(key) && value.length > 4000) value = value.slice(0, 4000);
  }

  const patch = { [key]: value };
  /* 0.17.62（用户口径）：天气源时「安静多少分钟后开口」最少 5 分钟。
     两个入口都堵：直接填 1~4 → 顶到 5；刚切到天气源、原来的值小于 5 → 顺便写回 5。
     宿主设置页和自家面板都走这里，所以两边行为一致。 */
  if (key === 'idleFirstMin' && c.chainSource === 'wx' && Number(value) < 5) patch[key] = 5;
  if (key === 'chainSource' && value === 'wx' && !(Number(c.idleFirstMin) >= 5)) patch.idleFirstMin = 5;
  const before = c[key];
  const p = ctx && typeof ctx.persist === 'function' ? ctx.persist : null;
  if (p) {
    p(patch);
  }
  Object.assign(c, patch);
  // 0.16.60：换榜就把上一批推荐作废 —— 否则 30 分钟里还在用旧榜那批歌，像是设了没反应
  if (key === 'chainCharts') invalidateRecommend();
  // 0.17.39：换来源 → 收掉旧承诺、两路缓存都作废（见 applySourceSwitch）
  if (key === 'chainSource' && before !== value) applySourceSwitch(value);
  // 0.17.43（C5）：改提示词 → 立刻清掉三张卡的缓存句子
  if (key.startsWith('prompt')) invalidatePromptCaches();
  // 0.17.45（C2）：端口热更 —— 采样器下一 tick 用新端口
  if (key === 'cdpPort') setSamplerPort(value);
  return { ok: true, saved: true, ...settingsSnapshot(c) };
}

/**
 * 一次改多项（总闸关掉时顺手把三个子项一起写，省三次往返）。
 * 任一键不合法就整批不动 —— 半套写进去比不写更难查。
 */
export function settingsSetMany(ctx, cfg, list) {
  const c = cfg || {};
  const patch = {};
  for (const item of Array.isArray(list) ? list : []) {
    const key = String((item && item.key) || '').trim();
    if (!SETTING_KEYS.includes(key)) return { ok: false, error: `不认识的设置项：${key}` };
    if (BOOL_KEYS.includes(key)) patch[key] = normBool(item.value);
    else if (INT_KEYS.includes(key)) {
      const n = Number(item.value);
      if (!Number.isFinite(n)) return { ok: false, error: `「${key}」要填数字` };
      const [lo, hi] = RANGES[key];
      patch[key] = Math.min(hi, Math.max(lo, Math.round(n)));
    } else {
      let v = String(item.value ?? '').trim();
      if (PROMPT_KEYS.includes(key) && v.length > 4000) v = v.slice(0, 4000);
      if (key === 'chainCharts') v = joinChartIds(v);
      if (key === 'chainSource') v = v === 'wx' ? 'wx' : 'reco';
      patch[key] = v;
    }
  }
  if (!Object.keys(patch).length) return { ok: true, ...settingsSnapshot(c) };
  // 0.17.62：批量写里切到天气源，也把第一次开口顶到 5 分钟
  if (patch.chainSource === 'wx' && !(Number(patch.idleFirstMin ?? c.idleFirstMin) >= 5)) patch.idleFirstMin = 5;
  if (patch.idleFirstMin != null && (patch.chainSource ?? c.chainSource) === 'wx' && Number(patch.idleFirstMin) < 5) patch.idleFirstMin = 5;
  const beforeSource = c.chainSource;
  const p = ctx && typeof ctx.persist === 'function' ? ctx.persist : null;
  if (p) p(patch);
  Object.assign(c, patch);
  if ('chainCharts' in patch) invalidateRecommend();
  if ('chainSource' in patch && patch.chainSource !== beforeSource) applySourceSwitch(patch.chainSource);
  if (Object.keys(patch).some((k) => k.startsWith('prompt'))) invalidatePromptCaches();
  if ('cdpPort' in patch) setSamplerPort(patch.cdpPort);
  return { ok: true, saved: true, ...settingsSnapshot(c) };
}

/** 0.17.25：天气那几项（模型页「配置」卡用）。密钥只给「是否配好」和尾号，不给明文。 */
export function weatherSnapshot(cfg) {
  const c = cfg || {};
  const key = String(c.qwApiKey || '').trim();
  return {
    // 0.17.68：不再用我的域名/城市当占位 —— 没填就是空，面板显示空输入框
    host: String(c.qwApiHost || '').trim(),
    keySet: Boolean(key),
    keyMask: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
    interval: Number.isFinite(Number(c.qwInterval)) ? Number(c.qwInterval) : 15,
    align: c.qwAlign === true,
    admin: String(c.qwAdmin || '').trim(),
    countryCode: String(c.qwCountryCode || '').trim(),
    city: String(c.qwCity || '').trim(),
  };
}
