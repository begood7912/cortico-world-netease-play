/**
 * World 实例：提供点歌工具和面板数据；听满 30 秒时把「她怎么听这首」那句话用本机声音说出来。
 */
import { join } from 'node:path';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { SETTING_SCHEMA } from './settings.schema.js';
import { DEFAULT_PLAYLIST, PKG_ROOT } from './python.js';
import { OPTIONS_KIND, nameById, refresh as refreshPlaylists } from './playlists.js';
import { panelInvoke } from './panel.js';
import { startSampler, stopSampler, setAnnouncer, setWarmer, setLikeSayer, setCommentSayer, setIdleSayer, setIdleSec, setIdleRepeat, setIdleAnchor, setChainGate, idleSecs, lastPlayedAt, lastTrack } from './listening.js';
import { refresh as refreshOllama, refreshCloud, setCloudHint, cloudCfgOnDisk, cloudModelNames, EMBED_KIND, CHAT_KIND, MODEL_SOURCE_KIND, VRAM_MODE_KIND, hasModel } from './ollama.js';
import { peekTake, generateTake } from './take.js';
import { getLiked, likedSentence } from './liked.js';
import { hearCardOn, takeBodyOn, composeHear } from './cards.js';
import { peekLike, generateLike, readPersonaNote, rotateLike } from './like.js';
import { peekComment, generateComment } from './comment.js';
import { peekReply, generateReply } from './her-reply.js';
import { speak, sweepOld, stopSpeaking } from './speak.js';
import { refreshVoices } from './winvoice.js';
import { refreshVoices as refreshEdgeVoices } from './edgevoice.js';
// 安静时间（0.17.11）：窗口内只拦「出声 + 自动开口生成」，后台刷新不受影响
import { inQuietHours, quietLabel } from './quietHours.js';
import { buildIdle, bootedRecently, firstAskSec, markIdleAnswered, markIdlePlayClick, saveIdle, peekIdle, pickIdleSong, lastAskAnchor } from './idle.js';
// 接力点歌（一首接一首）：状态、剩余秒数、来源标记、歌单每日清零（0.16.58 去掉了「最多 6 首」）
import { AHEAD_SEC, SAY_AHEAD_SEC, ARM_GIVEUP_MS, CHAIN_RETRY_MS, CHAIN_RETRY_MAX, VERIFY_WAIT_MS, PROMISE_TTL_MS, peekChain, saveChain, markClosed, keyOf, sameKey, sameTrack, gateVerdict, markOrigin, setPickWait, resetChainOnStartup, chainStateOf, displayOffer, pickWaitLeft, logChainEvent, userRequestHold, chainSpeakAllowed } from './chain.js';
// 0.17.43（A8）：用户动作的统一定义 —— 以后加"什么算用户动作"只改 userAction.js
import { markUserAction, blockingUserAction, lastUserAction } from './userAction.js';
import { USER_ACTION_HOLD_MS } from './constants.js';
import { ASK_EVENT, HER_LINE_EVENT, senderKeyOf } from './events.js';
// 0.17.66：安静到点没开口的原因要落盘（`idle.skip`），别再无声失败
import { event } from './log.js';
// 「今天清空过歌单没有」—— 独立文件，chain.json 怎么重置都碰不到它（第 97 节）
import { readRecoClear, writeRecoClear, currentDayKey, isClearedToday } from './recoClear.js';
// 「AI 推荐歌单」：接力这两首落到哪张歌单里（没有就建，每天按小时清零）
import { addToRecoPlaylist, clearRecoPlaylist, ensureRecoPlaylist, RECO_PLAYLIST_NAME } from './recoPlaylist.js';
// 世界自己按播放（接力 / 换一批 / 她问「要放吗」都用它），和面板点歌是同一套
// 0.16.86（第 132 节 A8）：queue.js（自动连播 5 首）整套删掉了，接力点歌取代它
import { playSong } from './play.js';
// 第 121 节：点歌落到哪张歌单 —— 只有 1 号窗口（含接力）看那个勾，其他面板走默认歌单
import { applyPick, PANEL_NOW } from './recoPick.js';

/** 每日清零失败后的冷却：300 首全清要两三秒，失败时别每 12 秒又跑一遍（第 91 节） */
const CLEAR_FAIL_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * 第 128 节（用户口径）：「换一批」点下去以后先显示「正在为你挑选歌曲中…」，
 * **等 10 秒**再真正随机挑一首亮出来。改这一处就能调快调慢。
 */
const PICK_DELAY_MS = 10_000;
import { cdpAlive, lastAlive, findClientExe } from './client.js';
import { peekRecommend, generateRecommend } from './recommend.js';
import { peekWxReco, nextWxSong, startWxWarmup } from './wxreco.js';
// 0.17.39：来源开关（设置里那个 2 选 1）现在同时决定接力挑歌、播报话术、以及哪一路允许刷新。
import { activeSource, isHistoryActive, isWeatherActive } from './source.js';
// 0.17.36：天气只有一个来源 —— 后台每 qwInterval（15 分钟）查一次并落盘
import { startWeatherAuto } from './qweather.js';
import { readProgress } from './progress.js';
import { addWant } from './wants.js';
import { makeTools } from './tools.js';
// 读回弹：世界侧扫宿主事件库，识别桌宠气泡的回答（点叉/选项原文都落 data\answer-log.jsonl）
import { startAnswerWatch, stopAnswerWatch, setAskMode } from './answers.js';
import { isQuietForever, setQuietForever, peekQuiet, clearQuiet } from './quiet.js';

/** 用法声明（环境提示词）的落盘位置：包内 ENV_PROMPT.md。 */
const ENV_PROMPT_FILE = join(PKG_ROOT, 'ENV_PROMPT.md');

/**
 * 把一段「写给人看」的文本改成「念给人听」的文本。卡② 的歌词和卡③ 的评论都走这里。
 *
 * 1. 原文常拿空格当停顿（「我曾经跨过山和大海 也穿过人山人海」），念出来会挤成一口气 —— 换成逗号。
 * 2. 空格不一定长在干净的地方：也见过「要取你的命； 我来自河畔啊」，硬换就成了「；，」双标点，
 *    所以贴在一起的标点要再收一收。
 * 3. 结尾没有标点的补一个句号，否则下一句会黏上来（「你不知道有多自由我听着想说」）。
 */
function speechClean(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let s = text.replace(/\s+/g, '，');
  s = s.replace(/[，,]+([。；;：:！？!?、])/g, '$1');
  s = s.replace(/([。；;：:！？!?、])[，,]+/g, '$1');
  s = s.replace(/[，,]{2,}/g, '，');
  s = s.replace(/^[，,。；;：:、]+/, '');
  s = s.replace(/[，,；;：:、]+$/, '');
  if (!s) s = text;
  return /[。！？.!?]$/.test(s) ? s : `${s}。`;
}

/**
 * 设置页只放「开关 + 本机 + 播放」这类和云端无关的项。
 *
 * 云端那四项（地址 / Key / 模型 / 手填）已经搬到本世界自己的「模型」页签（0.0.1.6.5），
 * 原因有两条，都是宿主那边做不到：
 *   1. 没有 x-hidden / x-when，字段没法「按开关隐藏」。试过按 modelSource 动态换 schema
 *      （0.0.1.6.1），一保存就炸：宿主 `persist()` 提交的是整组读者的值，而页面切完下拉
 *      不会重建节点，下一次保存就把已经不声明的键一起发上去，`coerceGroupValues()`
 *      见到未声明的键整组拒绝。
 *   2. `ConfigProperty` 的 string 一律是明文输入框，没有 password 类型 —— Key 只能明着显示。
 * 自己面板里的 `ui.input({ type: 'password' })` 和条件渲染都没这些限制。
 *
 * 所以这里 `modelSource` 仍然留着（它就是用户要的那个「开关」），但云端具体填什么不在这页。
 */
/**
 * 每个布尔开关「没设置时应该是什么」。
 *
 * 宿主设置页 `readGroupValues()` 是 `out[path] = raw === true`（core/config-schema.ts:113）——
 * 没设置一律读成 false，开关画成灰的；更麻烦的是用户改这一组里任何一项，整组回存，
 * 会把这些「没设置」的 false 真的写进 config.json，行为就从「开」变成「关」。
 * 所以这份表要在启动时补齐成显式值，让「页面画什么」和「代码怎么算」一致。
 * 只补缺失（undefined / null），用户自己设过的一律不动。
 */
const BOOL_DEFAULTS = Object.fromEntries(
  Object.values(SETTING_SCHEMA).filter((s) => s.type === 'bool').map((s) => [s.key, s.default]),
);

/** 把缺失的布尔项补成显式值（0.16.47）。写不进就算了：代码里 `!== false` 仍然当开。 */
function ensureBoolDefaults(ctx) {
  if (!ctx || typeof ctx.persist !== 'function') return;
  const c = ctx.cfg || {};
  const patch = {};
  for (const [k, v] of Object.entries(BOOL_DEFAULTS)) {
    if (c[k] === undefined || c[k] === null) patch[k] = v;
  }
  const keys = Object.keys(patch);
  if (!keys.length) return;
  try {
    ctx.persist(patch);
    console.log('[netease-play] 布尔开关补齐为显式值:', keys.join(', '));
  } catch { /* 写不进就等下次 */ }
}

export class NeteasePlayWorld {
  constructor(ctx) {
    this.id = 'netease-play';
    this.ctx = ctx;
    this._tools = null;
  }

  /**
   * 环境段要用的变量。返回 null 会整段省略；这里一定要给值，
   * 否则 ENV_PROMPT.md 里的 {{...}} 会空着。
   */
  envPromptVars() {
    const c = (this.ctx && this.ctx.cfg) || {};
    const favAt = Number.isFinite(c.favThreshold) ? c.favThreshold : 2;
    const autoFav = c.autoFav !== false;
    // 配置里存的是歌单 ID，念给人听的时候换成名字
    const pid = String(c.playlist || '').trim();
    const plName = (pid && nameById(pid)) || DEFAULT_PLAYLIST;
    return {
      'song.port': String(c.cdpPort || 9229),
      'song.playlist': plName,
      'song.favrule': autoFav
        ? `同一首点满 ${favAt} 次会自动进「我喜欢的音乐」`
        : '自动加「我喜欢的音乐」现在关着，只记账不动歌单',
    };
  }

  /**
   * 第 146 节（用户口径，11-24）：宿主扩展页那一排灯。
   *   ① 正在播放 —— 有歌在放就绿（hint 报歌名·歌手），停着就灰
   *   ② 接力点歌 —— 与面板同一套文案：已停止 / 正在为你挑选歌曲中… / 我挑中了《X》
   * 宿主每 500ms 轮询一次，这里只许读内存（peekChain 有进程内缓存，lastTrack 是变量），
   * 不许碰 CDP、不许发请求。
   */
  _lamps(zh) {
    const c = (this.ctx && this.ctx.cfg) || {};
    const tr = lastTrack();
    const live = Date.now() - Number(lastPlayedAt() || 0) < 60 * 1000;
    const playLamp = (live && tr && tr.title)
      ? { label: zh ? '正在播放' : 'Now playing', state: 'online', hint: tr.artist ? `${tr.title} · ${tr.artist}` : String(tr.title) }
      : { label: zh ? '正在播放' : 'Now playing', state: 'offline', hint: (tr && tr.title) ? (zh ? `停在《${tr.title}》` : `paused on ${tr.title}`) : (zh ? '没在放歌' : 'nothing playing') };
    let chain;
    if (c.chainPick === false) {
      chain = { state: 'offline', hint: zh ? '接力点歌已关' : 'chain off' };
    } else {
      const one = chainStateOf({ chain: peekChain(), offer: displayOffer(), waitMs: pickWaitLeft() });
      if (one.kind === 'picked') chain = { state: 'online', hint: zh ? `我挑中了《${one.name}》` : `picked ${one.name}` };
      else if (one.kind === 'picking') chain = { state: 'loading', hint: zh ? '正在为你挑选歌曲中…' : 'picking…' };
      else if (one.kind === '') chain = { state: 'online', hint: zh ? '接力中，等这首快放完就挑下一首' : 'chaining, waiting for the end' };
      else chain = { state: 'offline', hint: zh ? '接力点歌已停止' : 'chain stopped' };
    }
    return [
      playLamp,
      { label: zh ? '接力点歌' : 'Chain picking', state: chain.state, hint: chain.hint },
    ];
  }

  /** 配置组 + 用法声明；面板会按 schema 自动画表单，声明会拼进系统提示词。 */
  webUi(language) {
    const zh = !language || String(language).toLowerCase().startsWith('zh');
    return {
      // 第 146 节：两颗灯（宿主扩展页标题旁那排点）
      lamps: this._lamps(zh),
      panels: [
        {
          id: 'now',
          title: zh ? '此刻' : 'Right now',
          description: zh
            ? '现在在放什么、想听清单里欠着哪几首。'
            : 'What is playing now and what is still waited on.',
        },
        {
          id: 'rank',
          title: zh ? '点歌排名' : 'Request ranking',
          description: zh
            ? '每首歌被点过几次、最常点谁，前三名单独展示。'
            : 'How many times each song was requested, top 3 highlighted.',
        },
        {
          id: 'model',
          title: zh ? '模型' : 'Models',
          description: zh
            ? '本机 / 云端二选一；选云端才出现地址、Key（密文）、模型。'
            : 'Local or cloud; endpoint, key (masked) and model appear only for cloud.',
        },
        {
          id: 'settings',
          title: zh ? '设置' : 'Settings',
          description: zh
            ? '六张折叠卡：陪听开关 / AI 设置 / 接力点歌 / 听歌设置 / 数据库设置 / 提示词。改一项存一项，立刻生效。'
            : 'Four fold-out cards: the companion switches, idle, listening, and the model side.',
        },
      ],
      invoke: (panel, method, args) => this.panelInvoke(panel, method, args),
      /**
       * 0.16.51：宿主设置页不再挂任何配置组 —— 全部搬到「设置」页签（四张折叠卡）。
       *
       * 宿主一个组只能画一张平铺卡、不能折叠（`view.ts:574`），十几项摊开太长；
       * 那边原本两块（卡片开关 6 项 + 网易云陪听 17 项）和现在的设置页完全重复，
       * 留着会两边都能改同一份 config，容易看花眼。
       *
       * 空数组是合法的：`bot.ts:764` `if (config.length) out.config = config`。
       * 配置键本身没删，`ctx.persist(patch)` 不校验 schema，设置页照样写得进去
       * （云端四项更早就走通了这条路，见 src\cloudpanel.js 开头）。
       *
       */
      config: [],
      promptDocs: [
        {
          key: 'worlds.netease-play.envPrompt',
          title: zh ? '网易云陪听 · 用法' : 'NetEase Companion · usage',
          description: zh
            ? '告诉模型什么时候点歌、自己挑的歌要不要记账、别走旧脚本。'
            : 'When to play, how to mark self-picked songs, and not to use old scripts.',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'song.port', description: zh ? '当前 CDP 端口' : 'current CDP port' },
            { name: 'song.playlist', description: zh ? '默认歌单名' : 'default playlist' },
            { name: 'song.favrule', description: zh ? '自动加喜欢的规则' : 'favourite rule' },
          ],
        },
      ],
    };
  }

  tools() {
    if (!this._tools) this._tools = makeTools(this);
    return this._tools;
  }

  /** 面板数据入口：WebUI 的 ctx.invoke(method, args) 会走到这里。 */
  async panelInvoke(panel, method, args) {
    const c = (this.ctx && this.ctx.cfg) || {};
    // 把 ctx 也递下去：卡② 要从 botDir 找 config.json 读她的人设
    return panelInvoke(c, panel, method, args, this.ctx, this);
  }

  /**
   * 0.17.56（临时探针）：fatfish 的「只当嘴」模式靠 `globalThis.__cooPetSayRaw(text)`，
   * 但当前宿主源码里找不到谁定义它 —— 先在本进程里实测：启动时、8 秒、30 秒各记一次。
   * 只读，不改任何行为；结果写 data/log/globe-probe.json，便于确认后删掉。
   */
  _probeGlobals() {
    const dir = join(PKG_ROOT, 'data', 'log');
    const write = (tag) => {
      try {
        mkdirSync(dir, { recursive: true });
        const names = Object.keys(globalThis).filter((k) => /coo|pet|say|bubble/i.test(k));
        const types = {};
        for (const k of names) {
          try { types[k] = typeof globalThis[k]; } catch { types[k] = 'throw'; }
        }
        let raw = null;
        const fn = globalThis.__cooPetSayRaw;
        if (typeof fn === 'function') {
          raw = { name: String(fn.name || ''), length: fn.length, src: String(fn).slice(0, 300) };
        }
        const data = {
          at: new Date().toISOString(), tag,
          rawSay: typeof fn,
          rawSayInfo: raw,
          cooPetSay: typeof globalThis.__cooPetSay,
          keys: names.slice(0, 80),
          types,
          processKeys: Object.keys(process).filter((k) => /coo|pet|say/i.test(k)).slice(0, 40),
        };
        writeFileSync(join(dir, 'globe-probe.json'), JSON.stringify(data, null, 2), 'utf8');
        appendFileSync(join(dir, 'globe-probe.jsonl'), JSON.stringify(data) + '\n', 'utf8');
      } catch { /* 探针失败不影响启动 */ }
    };
    write('start');
    for (const ms of [8000, 30000]) {
      const t = setTimeout(() => write(`t+${ms / 1000}s`), ms);
      if (t.unref) t.unref();
    }
  }

  async start(host) {
    // 宿主会把 WorldHost 传进来：先存着，以后要投事件时不用再去要。
    this._host = host || null;
    // 0.17.56（探针）：确认「另一个 world 的只当嘴全局」在本进程里存不存在
    this._probeGlobals();
    // 第 129 节（用户口径）：「重启以后接力点歌显示的是上一次的情况，上一次没清零。」
    // 所以启动就把上一轮收干净：面板不再显示「我挑中了《X》」/「已经接下第 N 首」，
    // 也不做任何挑歌（`closed: startup` 让 chainGate 直接早返回 = 默认已暂停）。
    // 刻意不出声 —— 「自动切歌已暂停」那句用户明确说没要求加。
    resetChainOnStartup();
    // 上次没删掉的 wav 先清一遍，别在 data\speak 里堆着。
    sweepOld();
    // 布尔开关的显式初值（没设置时设置页会画成「关」，见 BOOL_DEFAULTS 注释）。
    ensureBoolDefaults(this.ctx);
    /* 0.1.30（用户口径）：调试端口不再是设置项 —— 一律固定 9229。
       老配置里可能还留着 cdpPort（比如填过别的值），这里在内存里改成 9229，
       所有下游（CDP 探测、子脚本环境变量、面板文案）读到的就是同一个值，不用挨个改。
       不写盘：万一下次要恢复成可填，配置里那份原值还在。 */
    const cs = (this.ctx && this.ctx.cfg) || {};
    try {
      if (Number(cs.cdpPort) !== 9229) cs.cdpPort = 9229;
    } catch { /* cfg 被冻结就算了：下游每个读取点都有 `|| 9229` 兜底 */ }
    // 启动时后台刷一次歌单缓存，给面板下拉用；客户端没开就算了，不阻塞启动。
    const c = (this.ctx && this.ctx.cfg) || {};
    // 0.17.36：天气自动查询挂在这里 —— 世界一启动就每 15 分钟查一次并落盘，
    // 面板（模型页那张卡）和卡片5 都只读这一份，谁都不再单独打接口。
    startWeatherAuto(c);
    // 0.17.76（用户口径）：启动后 4 分钟才预热第一批句子，别和宿主启动抢资源。
    // 这 4 分钟里面板只显示「还没算好」，想立刻看就点「换一批」。
    startWxWarmup(c);
    // 启动时后台刷一次歌单缓存，给面板下拉用；客户端没开就算了，不阻塞启动。
    refreshPlaylists(c.cdpPort).catch(() => {});
    // Ollama 模型表同理：configOptions 是同步契约，列表必须先在后台准备好。
    refreshOllama(c.ollamaUrl).catch(() => {});
    // 0.1.06：Windows 语音同理 —— 设置页那个下拉是同步快照，启动先探一次（约 0.2 秒），
    // 否则刚开程序就打开设置页，下拉里只有「系统默认」一条。
    refreshVoices().catch(() => {});
    // 0.1.09：微软在线语音列表（318 个里的中文那批），同样要在设置页打开前就备好
    refreshEdgeVoices().catch(() => {});
    // 云端模型表：地址 + Key 都填了才去读；设置页那个下拉点开时也靠这条 hint 再刷。
    // botDir 必须记下来：x-hot 配置改完宿主只热更、不重启世界，只有从磁盘重读才拿得到新值。
    setCloudHint(c.openaiUrl, c.openaiKey, this.ctx && this.ctx.botDir);
    refreshCloud(c.openaiUrl, c.openaiKey)
      .then((r) => {
        if (!r || !r.ok) return;
        const disk = cloudCfgOnDisk();
        // 选了云端、地址和 Key 都通了，但模型名还空着 —— 直接填一个，别让人再手打一次。
        // 只认 deepseek-flash：v4-pro 单价明显高，用户说过太贵，不能替他选贵的。
        if (disk && disk.source === 'cloud' && !disk.model) {
          const names = cloudModelNames();
          if (!names.includes('deepseek-flash')) return;
          try {
            this.ctx.persist({ openaiModel: 'deepseek-flash' });
            console.log('[netease-play] 云端模型自动填: deepseek-flash');
          } catch { /* 写不进就等用户自己选 */ }
        }
      })
      .catch(() => {});
    // 听满 30 秒说一句：采样器负责判断时机，到了就回调这里。
    setAnnouncer((info) => this.sayAbout(info));
    // 0.0.1.6.23：扫宿主事件库，把他点气泡的结果（尤其点叉）落到 data\answer-log.jsonl。
    // 以前点叉对我这边是零信号，只能靠冷却兜着；认出来就把这次记成「已答」，别再谎称她还在等。
    this._answerWatch = startAnswerWatch(host, {
      onAnswer: (a) => {
        if (!a) return;
        // 0.0.1.6.28：只有「刚刚点的」才允许改变播放。补扫到的旧回答只进日志，不动手 ——
        // 否则一启动就把十分钟前那条「换另外一首」重放一遍，等于自己开始放歌。
        if (!a.fresh) return;
        // 0.0.1.6.36 用户口径：① 放 ② 一直保持安静 ③ 等一会再说；**点叉 = 一直保持安静**。
        // 「一直安静」要落盘 —— 重启以后也不能一开机又问她一遍。
        if (a.dismissed || a.intent === 'quiet') {
          setQuietForever(true, a.dismissed ? 'dismissed' : 'choice');
          markIdleAnswered();
          return;
        }
        // 「等一会再说」= 只是这一次不问，按 idleRepeatMin 冷却，过会儿还会再问
        if (a.intent === 'later') {
          markIdleAnswered();
          return;
        }
        // 「换另外一首」这条老路径不再从气泡进（0.0.1.6.36 起没有这个选项了），
        // 面板的「换一批」还走 recoRefresh，另行处理。
        if (a.intent === 'another') void this.anotherRound();
        // 0.17.65（用户口径）：点了「放《X》」= 把**点击这一刻**记进 idle.json。
        // 为什么必须记：他常常过十来分钟才回头点，原来按「她开口 + 30 秒」判，
        // 一超窗口就被当成他自己点歌（user-ask），接力白掐。锚点改成点击时刻，
        // `recentIdleOffer` 就按 clickAt 判 30 秒 —— 晚点也算接受。
        if (a.intent === 'play' && a.fresh) {
          const m = String(a.option || '').match(/《([^》]*)》/);
          const name = m ? m[1] : '';
          // 事件时间戳（扫描滞后 1~2 秒），拿不到就退回现在
          const when = a.ageMs >= 0 ? Date.now() - Number(a.ageMs) : Date.now();
          markIdlePlayClick({ at: when, name });
        }
      },
    });
    // 听满 1 分钟说喜不喜欢（卡②）：同一个采样器，另一个闸。
    setLikeSayer((info) => this.sayLike(info));
    // 听满 1 分半念评论（卡③）：第三个闸，一句一句往外走。
    setCommentSayer((info) => this.sayComment(info));
    // 没放歌且安静够久：主动问一句「要我帮你放吗」（卡① 的互动段）。
    // 两段时间都每次现取配置：改完设置要立刻生效，不存旧值。
    // 第一次开口 = 安静满 idleFirstMin 分钟；之后至少等 idleRepeatMin 分钟才再问。
    setIdleSec(() => firstAskSec((this.ctx && this.ctx.cfg) || {}));
    setIdleRepeat(() => {
      const cc = (this.ctx && this.ctx.cfg) || {};
      // 填 0（或任何非正数以外）都当「只问第一次，以后不再问」—— 0 是用户 0.0.1.6.15 加的开关
      if (cc.idleRepeatMin === 0 || cc.idleRepeatMin === '0') return 0;
      const min = Number(cc.idleRepeatMin);
      return Number.isFinite(min) && min > 0 ? min * 60 : 60 * 60;
    });
    /* 0.17.66：开口失败不再是无声的。
       以前 `sayIdle` 里任何一处抛异常，都被采样器的 `.catch(()=>{})` 吞掉：
       表现就是「安静到点了，但桌宠一声不出、也没有三个选项的窗口」，日志里一行线索都没有。
       现在到点后把「没开口的原因」落进 events.jsonl（`idle.skip`），能一眼看出卡在哪道闸。 */
    setIdleSayer(async (info) => {
      const r = await this.sayIdle(info);
      if (!r || r.ok === false) {
        event('idle.skip', {
          reason: String((r && r.reason) || 'unknown'),
          idleSec: Number(info && info.idleSec) || 0,
          bootMin: r && r.bootMin != null ? Number(r.bootMin) : null,
        });
      }
      return r;
    });
    // 0.0.1.6.29：冷却基准落盘 —— 进程内 `idleAskedAt` 一重启就归零，
    // 于是每按一次重启键就一分钟后又开口，宿主 AI 记住了「这个事件一两分钟一条」。
    setIdleAnchor(() => lastAskAnchor());
    // 接力点歌（一首接一首）：采样器到点问一声，是不是她给的歌、要不要递下一首由这里判断。
    setChainGate((info) => this.chainGate(info));
    // 换歌就重算卡①那句：每首听都是新答案，不拿上一遍的旧句糊过去。
    setWarmer(({ title, artist, gen }) => {
      const cc = (this.ctx && this.ctx.cfg) || {};
      if (!hasModel(cc)) return;
      // 0.16.44：设置里关掉的卡，换歌也不许预生成 —— 这才是「真的不算」
      const on = cc.cardsOn !== false;
      if (takeBodyOn(cc)) {
        generateTake({
          title,
          artist,
          cdpPort: cc.cdpPort,
          cfg: cc,
          gen,
        }).catch(() => { /* 失败会自己落到负缓存，面板会显示原因 */ });
      }
      // 卡②：换了歌就换一句。池子里已经存着这首歌以前算过的几条（每条引的是不同的句子），
      // 这里只做「抽签」，不再花一次模型调用 —— 用户要的就是每次听引的歌词不一样。
      // 池子空（这首歌第一次听、或缓存过期）才跑模型，一次算两条不同的句子存着备用。
      if (on && cc.cardFeel !== false) {
        const persona = readPersonaNote(this.ctx && this.ctx.botDir);
        const rotated = rotateLike(title, artist, cc, gen);
        if (!rotated) {
          generateLike({
            title,
            artist,
            cdpPort: cc.cdpPort,
            persona,
            cfg: cc,
            gen,
          }).catch(() => { /* 失败会自己落到负缓存，面板会显示原因 */ });
        }
      }
      // 卡③ 的热评只是两次 HTTP，不占模型，顺手先抓回来 ——
      // 到听满 1 分半的时候只剩合成要等（这段 211 字的合成要 10 秒）。
      if (on && cc.cardComment !== false) {
        generateComment({ title, artist, gen }).catch(() => { /* 失败照样到点再试 */ });
      }
    });
    // 听歌次数采集器：常驻，每 10 秒读一次当前曲目，换曲时结算。
    // 0.16.66：把 CDP 端口带过去 —— 采集器要用它读播放进度，播报才好按「这一遍放到哪」触发（第 94/95 节）
    startSampler({ cdpPort: c.cdpPort });
    // 0.0.1.6.34：每 6 秒探一次网易云客户端在不在，结果进缓存 —— 面板要用同步读到的值，
    // 开口/播放/接力要用的那几次会 force 重新探。
    // 0.0.1.6.35：探到「刚起来」这一下（false → true）顺手在后台把数据刷新一遍。
    // 用户口径：「启动客户端以后再重新、在后台慢慢地去读取新的数据。」
    let wasOpen = !!lastAlive().ok;
    const pingClient = async () => {
      const open = await cdpAlive(c.cdpPort, { force: true }).catch(() => false);
      if (open && !wasOpen) {
        wasOpen = true;
        // 0.0.1.6.40：客户端从「没开」变成「开了」（不管是她拉起来的还是他自己打开的）
        // → 「先安静着」这个临时开关放开。
        clearQuiet('client-up');
        // 静默刷新：不推气泡、不说话，只把榜单和推荐算好放进缓存，等下一次开口直接用
        generateRecommend(c).catch(() => { /* 刷不上就继续用旧缓存 */ });
      } else if (!open) {
        wasOpen = false;
      }
    };
    void pingClient();
    this._clientTimer = setInterval(() => { void pingClient(); }, 6000);
    if (this._clientTimer.unref) this._clientTimer.unref();
  }

  /**
   * 把「她怎么听这首」那句话用本机声音说出来。
   * 不弹气泡、不交给桌宠 —— 用户要求直接出声，走 GPT-SoVITS（9880）合成 + SoundPlayer 播。
   */
  async sayAbout({ title, artist, gen = null } = {}) {
    const c = (this.ctx && this.ctx.cfg) || {};
    if (inQuietHours(c)) return { ok: false, reason: 'quiet-hours', quiet: true };
    if (c.announce === false) return { ok: false, reason: 'off' };
    // 0.16.44：卡② 在设置里关掉了 → 连这个出声也一起停（否则它还会自己调一次模型）
    // 0.16.56：卡② 改成两个勾（sayHead / sayBody），两个都不勾就当整卡关掉。
    if (!hearCardOn(c)) return { ok: false, reason: 'card-off' };
    if (!hasModel(c)) return { ok: false, reason: 'no-model' };

    /* 0.16.58（用户口径）：设置里只留两个勾 —— 上面「顶上显示多少人喜欢」、下面「后面那段她怎么说」。
       · 上面那个勾同时管「面板那行」和「播报开头那句 XX的《XX》歌 XX人点赞」；
       · 下面那个勾管正文；关掉就只报开头、不念正文。
       两个都不勾 = 这张卡整个不工作。 */
    const bodyOn = c.sayBody !== false;
    const headOn = c.showLiked !== false;
    /* 0.16.61（用户口径）：卡② 的第三项 —— 正文和歌名谁先说。
       打开 = 先说话、再播歌名；关上（默认）= 先播歌名、再说话（跟 0.16.54 之后的行为一致）。 */
    const bodyFirst = c.sayBodyFirst === true;

    let text = '';
    if (bodyOn) {
      let take = peekTake(title, artist, c, gen);
      if (!take || !take.text) {
        const r = await generateTake({
          title,
          artist,
          cdpPort: c.cdpPort,
          cfg: c,
          gen,
        });
        if (!r.ok) return r;
        take = { text: r.text };
      }
      text = String(take.text || '').trim();
      if (!text) return { ok: false, reason: 'empty' };
    }

    // 开头那句：先说「谁唱的、多少人喜欢」，读不到人数就退回老口径（只点歌名），不编数字。
    let head = '';
    if (headOn) {
      try {
        const lk = await getLiked({ title, artist, cdpPort: c.cdpPort });
        if (lk && lk.ok && lk.label) head = likedSentence({ artist, title, label: lk.label });
      } catch { /* 读不到就不点人数，别为一行字把这次播报拖垮 */ }
      if (!head) head = `《${title}》这首歌。`;
    }

    /* 拼句顺序（0.16.61）：实现搬到 cards.js 的 composeHear —— 纯函数好自测。
       正文在前时它会补一个「。」，不然会念成「……一句正文许嵩的《幻听》，有…」黏在一起。 */
    const spoken = composeHear(head, text, bodyFirst);
    if (!spoken) return { ok: false, reason: 'empty' };
    const r = await speak({ text: spoken, url: c.ttsUrl, engine: c.ttsEngine, voice: c.ttsVoice });
    return { ...r, text, spoken, headOn, bodyOn, bodyFirst };
  }

  /**
   * 听满一分钟，把「这句歌词 + 她的感觉」用本机声音读出来（卡③）。
   * 内容取卡③已经算好的那份（没有就当场算）；不到一分钟就被切走的话
   * 采样器根本不会调到这里，所以不用再判断时长。
   *
   * 念的样子（用户 0.0.1.6.6 改的口径）：
   *   「<歌词>」，从这句歌词我感觉，<她的话>
   * —— **不念歌名**。歌名这时候屏幕上就写着，念一遍只是废话，还占掉几秒。
   */
  async sayLike({ title, artist, gen = null } = {}) {
    const c = (this.ctx && this.ctx.cfg) || {};
    if (inQuietHours(c)) return { ok: false, reason: 'quiet-hours', quiet: true };
    if (c.announce === false) return { ok: false, reason: 'off' };
    if (c.cardsOn === false || c.cardFeel === false) return { ok: false, reason: 'card-off' };
    if (!hasModel(c)) return { ok: false, reason: 'no-model' };

    let like = peekLike(title, artist, c, gen);
    if (!like || !like.feel) {
      const r = await generateLike({
        title,
        artist,
        cdpPort: c.cdpPort,
        persona: readPersonaNote(this.ctx && this.ctx.botDir),
        cfg: c,
        gen,
      });
      if (!r.ok) return r;
      like = { line: r.line, feel: r.feel, verdict: r.verdict };
    }
    const feel = String(like.feel || '').trim();
    if (!feel) return { ok: false, reason: 'empty' };
    const line = String(like.line || '').trim();

    // 歌词那头不加引号念 —— 括号引号念出来只是噪音，全靠停顿把它标出来。
    // 词里常有空格当停顿（「跨过山和大海 也穿过人山人海」），换成逗号顺气；
    // 结尾的标点收掉，因为后面要接「，从这句歌词我感觉」。
    const lineSaid = line
      ? line.replace(/\s+/g, '，').replace(/[，,]{2,}/g, '，').replace(/^[，,。；;：:、]+|[，,。；;：:、]+$/g, '')
      : '';
    const spoken = lineSaid
      ? `「${lineSaid}」，从这句歌词我感觉，${feel}`
      : feel;
    const r = await speak({ text: spoken, url: c.ttsUrl, engine: c.ttsEngine, voice: c.ttsVoice });
    return { ...r, verdict: like.verdict, line, feel, spoken };
  }

  /**
   * 听满一分半，把「别人怎么说 + 她听完怎么想」念出来（卡④）。
   *
   * 念的样式（0.1.28 用户改的口径）：
   *   <昵称>说：<热评原文>。<她的评价，自己带「我觉得 / 我认为」开头>
   * 昵称拿不到（评论没带用户名）才退回「有人说：」。
   * 开头不再点歌名；评价那句不挂「她听完说」的引子，直接接在原文后面，
   * 读起来就是「有人这么说，我觉得……」一整段。
   *
   * 原文照引，不替他概括；最长 200 字，加上评价念出来大概 25~35 秒 ——
   * 卡② 15 秒、卡③ 20 秒左右，几句连起来是一整段话，不是几个碎片。
   */
  async sayComment({ title, artist, gen = null } = {}) {
    const c = (this.ctx && this.ctx.cfg) || {};
    if (inQuietHours(c)) return { ok: false, reason: 'quiet-hours', quiet: true };
    if (c.announce === false) return { ok: false, reason: 'off' };
    if (c.cardsOn === false || c.cardComment === false) return { ok: false, reason: 'card-off' };

    let cm = peekComment(title, artist, gen);
    if (!cm || !cm.text) {
      const r = await generateComment({ title, artist, gen });
      if (!r.ok) return r;
      cm = { text: r.text, nick: r.nick };
    }
    const text = String(cm.text || '').trim();
    if (!text) return { ok: false, reason: 'empty' };

    let rp = peekReply(title, artist, c, text);
    if (!rp || !rp.text) {
      const r = await generateReply({
        title,
        artist,
        comment: text,
        persona: readPersonaNote(this.ctx && this.ctx.botDir),
        cfg: c,
      });
      if (!r.ok) return r;
      rp = { text: r.text };
    }
    const mine = String(rp.text || '').trim();
    if (!mine) return { ok: false, reason: 'empty' };

    const nick = String((cm && cm.nick) || '').replace(/\s+/g, ' ').trim();
    const who = nick ? `${nick}说：` : '有人说：';
    const full = speechClean(text);
    const spoken = `${who}${full}${mine}`;
    const r = await speak({ text: spoken, url: c.ttsUrl, engine: c.ttsEngine, voice: c.ttsVoice });
    return { ...r, comment: text, reply: mine, spoken };
  }

  /**
   * 没放歌、安静够久，主动开口问一句要不要听（卡① 的互动段）。
   *
   * 问法固定三段：「现在太安静了」→「我想听《X》[，为什么]」→「要我帮你放吗？」。
   * 中间那句「想听哪首」必须由程序挑（「今天听点什么」前三首里随机一首）：
   * 让 4B 自己挑歌它会挑还没听过的热门歌，念出来点不上，也不像她的口味。
   * 模型只写「为什么此刻想听」那半句（也可能写不出来，那就不要）。
   *
   * 提议要落盘 —— 这句是我们的 TTS 出声的，不经过宿主对话，
   * 不落盘的话用户答「放吧」时宿主的 AI 根本不知道她想听哪首（它读 `netease_quiet`）。
   */
  async sayIdle({ idleSec } = {}) {
    const c = (this.ctx && this.ctx.cfg) || {};
    // 0.17.11：安静时间里连「自动推歌」这一次模型调用都不做，直接当没这回事
    if (inQuietHours(c)) return { ok: false, reason: 'quiet-hours', quiet: true };
    if (c.selfPick === false || c.idleSay === false) return { ok: false, reason: 'off' };
    // 0.0.1.6.36：他选了「一直保持安静」（或者直接把窗口关掉）→ 就不再主动开口了，
    // 直到他自己在面板/设置里放开。这不是冷却，是停用。
    if (isQuietForever(c)) return { ok: false, reason: 'quiet-forever' };
    /* 0.17.61（用户口径）：刚开机的前 N 分钟不发 —— 开机要加载模型、算向量，1 分钟做不完，
       这时候弹出来问也是拿旧名单凑的。默认 5 分钟（`idleBootGuardMin`，0 = 不拦）。
       按整机开机时长算，不是插件进程。 */
    const bootMin = c.idleBootGuardMin == null ? 5 : Number(c.idleBootGuardMin);
    if (bootedRecently(bootMin)) return { ok: false, reason: 'boot-guard', bootMin };
    /* 0.17.66：这里原来还留着 0.17.61 的一句 `bootGuardHit(c)` —— 那个函数从来没定义过，
       一调就 ReferenceError，被采样器的 .catch 吞掉：于是安静到点后**什么也不发**，
       宿主那边自然没有「要放歌吗」三个选项的窗口。删掉，只留上面按整机 uptime 的这道闸。 */
    // 0.0.1.6.34：客户端没开就别问了 —— 问了也放不了，用户点了「放」只会收到一句
    // 「播放器那边没响应」。这是以前的漏网（安静计时照走、到点照样弹）。
    // 0.0.1.6.39（用户口径）：**只有确定要放歌时才拉起客户端**。开口问的时候不拉 ——
    // 他要是选了「先安静着」「等一会再说」或者直接点叉，客户端就白起一次、还抢焦点。
    // 所以这里只判断「客户端有没有装」，不做任何启动动作；真点了「放」由 playSong 去拉。
    if (!(await cdpAlive(c.cdpPort)) && !findClientExe(c)) return { ok: false, reason: 'player-off' };
    const r = await buildIdle({
      cfg: c,
      persona: readPersonaNote(this.ctx && this.ctx.botDir),
      idleSec,
    });
    if (!r || !r.spoken) return { ok: false, reason: 'empty' };
    // 0.0.1.6.29：saveIdle 会把 answeredAt 重置成 0，所以「他上一次答没答、多久之前答的」
    // 必须在写盘之前先捞出来，等下要塞进事件正文 —— 宿主 AI 就是靠这个判断「这次是不是瞎弹」。
    const prev = peekIdle();
    const prevAnsweredAt = prev ? Number(prev.answeredAt || 0) : 0;
    saveIdle(r);
    // 「允许她自己去找歌挑歌」打开时，她自己挑中的那首要记进「她想听什么」清单
    // （设置页原文就是这么写的）。已经在清单里的不会重复加。
    if (r.pick && r.pick.name) {
      try {
        addWant({ name: r.pick.name, artist: r.pick.artist || '', why: '她自己挑的' });
      } catch { /* 记不上不影响这一句 */ }
    }
    // 0.0.1.6.16：不再是「推一句让她念」，而是推一句话让它弹选择气泡 ——
    // 说话和弹窗都归宿主那边，我们只给「想听哪首 + 要问什么 + 选项是什么」。
    // 0.0.1.6.17：一张卡不出声，所以还要它先说一句（pet_say）再弹窗（pet_ask）。
    const pushed = await this.pushAskBubble({
      pick: r.pick || null,
      minutes: Math.round((Number(idleSec) || 0) / 60) || Number(c.idleFirstMin) || 5,
      flavor: r.flavor || '',
      flavorFrom: r.flavorFrom || '',
      weather: r.weather || '',
      // 0.17.63：给 AI 看的那句「此刻天气」是模型写的 20~60 字，不是数据串
      brief: r.brief || '',
      say: r.spoken,
      prevAnsweredAt,
    });
    if (!pushed.ok) {
      // 没有事件通道（比如脱机单测）时退回本机语音，至少别哑着
      const sr = await speak({ text: r.spoken, url: c.ttsUrl, engine: c.ttsEngine, voice: c.ttsVoice });
      return { ...sr, viaEvent: false, spoken: r.spoken, pick: r.pick || null, flavor: r.flavor || '' };
    }
    return { ok: true, viaEvent: true, asked: true, cursor: pushed.cursor, spoken: r.spoken, pick: r.pick || null, flavor: r.flavor || '' };
  }

  /**
   * 先说话、再弹「要放歌吗」的选择气泡（0.0.1.6.16 只弹窗，6.17 补上说话）。
   *
   * 宿主那边的原话：正文写成一句人话就行，别塞英文字段 —— 它不当参数读，念出来还会整句变英文。
   * 所以这里只有一句自然语言：说清「谁安静了多久、先说哪一句、弹个什么窗口、选项三个」。
   * 它收到就先 `pet_say` 念引号里那句，再 `pet_ask` 弹框；框一直挂着，不操作就不收。
   */
  async pushAskBubble({ pick, minutes, flavor, flavorFrom = '', weather = '', brief = '', say, prevAnsweredAt = 0 } = {}) {
    const host = this._host;
    if (!host || typeof host.pushEvent !== 'function') return { ok: false, reason: 'no-host' };
    const name = pick && pick.name ? `《${pick.name}》` : '点什么歌';
    const art = pick && pick.artist ? `（${pick.artist}）` : '';
    const why = flavor ? `，${flavor}` : '';
    const mins = Number(minutes) > 0 ? Math.round(Number(minutes)) : 5;
    // 名字取宿主的（重命名后立刻跟上），取不到就用「她」，不硬写死一个称呼
    const who = String((this.ctx && this.ctx.botName) || '').trim() || '她';
    const line = String(say || '').trim()
      || `现在太安静了。我想听${name}${art}${why}。要我帮你放吗？`;
    // 0.0.1.6.18：选项不再是「放 / 不放 / 换一首」这种抽象词 —— 第一项直接写歌名，
    // 一眼就知道点了会听哪首；第二项换一首；第三项不播放。
    // 0.0.1.6.20：「弹窗只给两项」开关打开时，只留「播放此刻 / 不播放」——
    // 「换另外一首」会重算推荐、还会再自动说一句，不想听那一句就把它去掉。
    // 0.0.1.6.36 用户口径（原话）：「第一个是放，第二个是一直保持安静，第三个是等一会再说；
    // 点叉的时候就是一直保持安静这个选项。」
    // 所以「换另外一首」从气泡里去掉了 —— 面板还有「换一批」按钮，那条功能没丢。
    const twoOnly = !!((this.ctx && this.ctx.cfg) || {}).askTwoOnly;
    // 问之前先记下「这次几项、点的是哪首」—— 回弹只报「第几项」，要靠这份换算成「放 / 一直安静 / 等一会」。
    setAskMode({ twoOnly, pick });
    const opt1 = pick && pick.name ? `放《${pick.name}》` : '放';
    const choices = twoOnly
      ? '两个选项，顺序是：'
        + `「${opt1}」和「先安静着」。`
        + '第一个是现在放这首；第二个是他这会儿不想被问 —— 选它之后不用再说话，'
        + '它是临时的（他下次有动作、或者重启就恢复正常）。'
      : '三个选项，顺序是：'
        + `「${opt1}」「先安静着」「等一会再说」。`
        + '第一个是现在放这首；第二个是他这会儿不想被问 —— 选它之后不用再说话，'
        + '临时生效（他下次有动作、或者重启就恢复正常）；'
        + '第三个是这次先不放、过一会儿再问。'
        // 0.0.1.6.26 的老口径仍然有效：任何一项都不该再弹第二个窗口
        + '不管他选哪一项，都不需要再弹第二个窗口，也不用调 netease_reco；'
        + '如果他把窗口直接关掉（点叉），按第二个算 —— 那边自己会记成「先安静着」。';
    // 0.0.1.6.29：正文里带上我们这边实测到的实况。
    // 起因：宿主 AI 收到这条后不去查播放器，凭记忆判断「歌还在放，说安静是撒谎」，于是整条跳过，
    // 还写了笔记「这个事件一两分钟一条，很吵，以后真在放歌就不弹」。
    // 事实是它记错了 —— 播放器当时确实是暂停的。所以把实测结果直接摆给它，别让它自己猜。
    const lastOne = lastTrack();
    const quietSec = idleSecs();
    // 刚起进程时 idleSecs 还是 0，别在正文里写「安静了 0 秒」——那句话自相矛盾
    const quietText = quietSec >= 30 ? `安静了 ${quietSec} 秒` : '刚刚停下来';
    const state = lastOne
      ? `播放器现在是停着的，停在《${lastOne.title}》${lastOne.artist ? `（${lastOne.artist}）` : ''}`
      : '播放器这会儿一首都没在放';
    let prevNote = '';
    if (Number(prevAnsweredAt) > 0) {
      const gapMin = Math.max(1, Math.round((Date.now() - Number(prevAnsweredAt)) / 60000));
      const rep = Number(((this.ctx && this.ctx.cfg) || {}).idleRepeatMin);
      const waitMin = Number.isFinite(rep) && rep > 0 ? Math.round(rep) : 60;
      prevNote = `他 ${gapMin} 分钟前选了「等一会再说」，`
        + `按设置隔 ${waitMin} 分钟才再问一遍，现在是到点了，不是这边在乱弹。`;
    }
    // 0.17.58：正文改成「陈述 + 请求」，不再用命令口吻。
    // 这条事件走的是 external（外部内容）通道，原来的「这一条照做就行 / 不要自己判断 / 唯一例外…」
    // 形状上和注入一样 —— 谁能造一条 netease-play.ask，谁就能指挥她。
    // 长期规则（必须念、必须弹窗、不许跳过、不许点界面）搬到 ENV_PROMPT.md 的「她安静时会先开口」；
    // 这里只留这一次的事实和想让她做的事。
    const text = `${who}已经 ${mins} 分钟没放歌了。`
      + `（这边实测：${state}，${quietText} —— 是真没在放，不是猜的。）`
      + prevNote
      + (flavorFrom === 'wx'
        // 0.17.61：天气源打开时，那句是「天气 + 突然想到一首歌」，前半句的事实也一并给她，
        // 免得她把天气换成别的说法、或把两句拆成两件事。
        // 0.17.63（用户口径）：这句事实改成模型按天气写的 20~60 字（`brief`），不再塞「雾，4.4 度…」的数据串。
        ? `（前半句说的是此刻的天气：${brief || weather || '（今天的天气）'}。后半句是她突然想到的那一首。两句要连着一句说完，不要把天气改写成别的。）`
        : '')
      + `她这会儿想说的是：「${line}」`
      + `这边想请她把这句话说出来，然后弹一个选择题窗口：标题「要放歌吗？」，${choices}`
      + '（这句和这个窗口是同一件事，别只做一半；什么情况可以跳过、界面能不能碰，'
      + '都写在环境提示词的「她安静时会先开口」一节。）'
      + '除了引号里那一句，这段说明不用念。';
    try {
      const ev = await host.pushEvent({
        // 0.17.58：type/trigger/tags 取自 events.js 的声明（与 describe.events 同一份）；
        // trigger 由 debounce 改 flush —— 合批会压 2.5~15 秒，和「说完就弹窗」的语义打架。
        type: ASK_EVENT.type,
        ts: new Date().toISOString(),
        source: String((this.ctx && this.ctx.id) || 'netease-play'),
        origin: 'external',
        tags: ASK_EVENT.tags,
        senderKey: senderKeyOf(ASK_EVENT, (pick && (pick.id || pick.name)) || ''),
        text,
        meta: { kind: 'idle-ask', pick: pick || null },
      }, { trigger: ASK_EVENT.trigger });
      return { ok: true, cursor: ev && ev.cursor };
    } catch (e) {
      return { ok: false, reason: 'push-failed', error: String((e && e.message) || e) };
    }
  }

  /**
   * 把她要说的一句话交给宿主事件通道：事件进上下文 → deepseek 那一轮会回话 → 宿主合成语音。
   * 文本前面加一句旁白，免得模型把它当成用户发言来「回答」。
   */
  async pushHerLine(text, meta = {}) {
    const host = this._host;
    if (!host || typeof host.pushEvent !== 'function') return { ok: false, reason: 'no-host' };
    const say = String(text || '').trim();
    if (!say) return { ok: false, reason: 'empty' };
    const kind = String((meta && meta.kind) || '').trim() || 'line';
    try {
      const ev = await host.pushEvent({
        // 0.17.58：原来是 type:'netease-her-line' + trigger:'interrupt'。
        // interrupt 会取消当前模型轮、丢掉尚未开始的工具调用 —— 一句「我挑中了《X》」不该有这种权限；
        // 改 flush（立即投递，不动在途轮）。senderKey 带 kind，同一类播报不再并成一条。
        type: HER_LINE_EVENT.type,
        ts: new Date().toISOString(),
        source: String((this.ctx && this.ctx.id) || 'netease-play'),
        origin: 'external',
        tags: HER_LINE_EVENT.tags,
        senderKey: senderKeyOf(HER_LINE_EVENT, kind),
        text: `（这是她自己要说的一句话，原样念出来就行，不用回答它，也不要复述这行括号。）${say}`,
        meta: { ...meta, kind },
      }, { trigger: HER_LINE_EVENT.trigger });
      return { ok: true, cursor: ev && ev.cursor };
    } catch (e) {
      return { ok: false, reason: 'push-failed', error: String((e && e.message) || e) };
    }
  }

  /**
   * 面板确认条按了「是 / 否」（30 秒不按等于否，倒计时在前端走）。
   *
   * 0.16.86（第 132 节 A8）：原来这里会开一轮「自动连播 5 首」的队列 —— 直接放第一首，
   * 后面几首由 chainGate 一首一首接。队列那套和接力点歌是同一件事的两套实现，已整条删掉。
   * 现在：只放她刚提议的那一首、打上 her-offer，后面交给接力自然地往下接。
   * 「否」→ 什么也不说（她已经问过了，不该再补一句）。
   */
  async answerIdle(yes) {
    const c = (this.ctx && this.ctx.cfg) || {};
    markIdleAnswered();
    if (!yes) return { ok: true, yes: false };

    const idle = peekIdle();
    const pick = idle && idle.pick && idle.pick.name ? idle.pick : null;
    if (!pick) return { ok: false, reason: 'no-pick' };

    // 0.16.58：这是「她推荐、他答应了」那条路 → 打上 her-offer，接力才准接
    markOrigin('her-offer', pick);
    // 0.17.60（A 方案同款漏项）：歌单也要走「此刻页」那套规则 ——
    // 勾了「接力点歌歌单」就落「AI 推荐歌单」，以前这里传原始配置，一律落默认歌单。
    const r = await playSong(applyPick(c, PANEL_NOW), pick, 'auto');
    await this.pushHerLine(`那我就先放《${pick.name}》了，唱完我接着挑。`, { kind: 'queue-start', pick });
    return { ok: true, yes: true, played: !!(r && r.ok), message: (r && r.message) || '' };
  }


  /**
   * 气泡里点了「换另外一首」：自己重算一批，**直接挑一首放上**，只报一句「现在给你播放《X》」。
   *
   * 0.0.1.6.26 → 48 节：只报歌名、不再弹窗；
   * 0.0.1.6.27（用户口径）：干脆连「让他挑」都省了 —— 换一批之后随便推荐一首、直接放，
   * 然后说「现在我给你播放《X》，你看看喜不喜欢」。
   */
  async anotherRound() {
    markIdleAnswered();
    const c = (this.ctx && this.ctx.cfg) || {};
    const r = await generateRecommend(c);
    const items = (r && r.ok ? (r.items || []) : []).slice(0, 5)
      .filter((x) => x && x.name)
      .map((x) => ({ name: String(x.name), artist: String(x.artist || ''), id: String(x.id || '') }));
    if (!items.length) {
      await this.pushHerLine('我这边一时算不出新的一批，你先随便挑一首吧。', { kind: 'reco-empty' });
      return { ok: false, reason: (r && r.reason) || 'empty' };
    }
    // 「随便推荐一首」= 从新一批里**随机**取一首（第 125 节：原来死取 `items[0]`，
    // 每次换一批都放同一首，跟没换一样）
    const pick = items[Math.floor(Math.random() * items.length)];
    // 0.16.58：换一批之后放的是**她推的**这首 → 打 her-offer，允许接力顺着往下接
    markOrigin('her-offer', pick);
    const res = await playSong(c, pick, 'auto');
    const played = !!(res && res.ok);
    const off = !!(res && res.reason === 'player-off');
    // 0.17.20（用户口径）：后面那句「你看看喜不喜欢」删掉，只留「现在为你播放…」。
    // 歌手从播放结果里取（搜出来的正式歌手名），取不到才退回原来给的那位。
    const by = String((res && res.artist) || pick.artist || '').trim();
    await this.pushHerLine(
      played
        ? (by
          ? `现在为你播放${by}的《${pick.name}》。`
          : `现在为你播放《${pick.name}》。`)
        : off
          ? `我想给你放《${pick.name}》，可网易云没开，你先把它打开吧。`
          : `我想给你放《${pick.name}》，播放器那边没响应。`,
      { kind: 'reco-play', pick },
    );
    return { ok: played, played: pick.name, message: (res && res.message) || '' };
  }

  /**
   * 「重新推荐」：面板按钮和 AI 工具都走这里。
   *
   * 第 124 节（用户口径）：**只换一批候选，绝不关接力**。
   * 所以这里不碰 `chain.json` 的接力状态（不 markClosed、不 clearChain、不改 base/origin）——
   * 面板上点「换一批」时，正在跑的接力该怎么接还怎么接，
   * 新一批候选只是给 `pickIdleSong()` 换了池子。
   *
   * 第 128 节（用户口径）：点了以后**先显示「正在为你挑选歌曲中…」**，
   * 等 10 秒再真正随机挑一首亮出来 —— 不立刻亮。
   * 实现就是写一个 10 秒的「先别挑」截止时间（`setPickWait`），
   * 顺便把旧预告清掉，免得面板还挂着上一批那首。
   */
  async recoRefresh() {
    const c = (this.ctx && this.ctx.cfg) || {};
    // 0.17.39：来源不是「听歌历史」时，这张卡的「换一批」不生效（面板按钮也已禁用）。
    if (!isHistoryActive(c)) {
      return { ok: false, reason: 'inactive', count: 0, items: [] };
    }
    setPickWait(PICK_DELAY_MS);
    const r = await generateRecommend(c);
    const ok = !!(r && r.ok);
    return {
      ok,
      count: ok ? (r.items || []).length : 0,
      reason: ok ? '' : (r && r.reason) || 'fail',
      items: ok ? (r.items || []).slice(0, 5).map((x) => ({ name: x.name, artist: x.artist })) : [],
    };
  }

  /**
   * 「重算但别让人等」（0.0.1.6.31）。
   *
   * 起因：`netease_reco` 的 refresh 以前是同步等 `generateRecommend` ——
   * 冷态向量化 330 首要 15 秒，宿主的工具调用等不住，AI 就自己上手去点界面了。
   * 现在工具立刻返回，算完由她自己报歌名（跟 6.26 的口径一致：换一批只报歌名）。
   */
  startRecoRefresh() {
    const c0 = (this.ctx && this.ctx.cfg) || {};
    // 0.17.39：来源不是历史 → 不排队、不算（工具那边会改走天气路的排队）。
    if (!isHistoryActive(c0)) return { busy: false, reason: 'inactive' };
    if (this._recoJob) return { busy: true };
    const c = (this.ctx && this.ctx.cfg) || {};
    this._recoJob = generateRecommend(c)
      .then(async (r) => {
        if (!r || !r.ok) return;
        const names = (r.items || []).filter((x) => x && x.name).map((x) => `《${x.name}》`).join('、');
        if (!names) return;
        await this.pushHerLine(`我换了一批：${names}。你想听哪首，或者直接点一个都行。`, { kind: 'reco-batch' });
      })
      .catch(() => { /* 算不出来就算了，面板会显示原因 */ })
      .finally(() => { this._recoJob = null; });
    return { busy: false };
  }

  /**
   * 接力点歌（一首接一首）—— 采样器每 3 秒问一次，这里决定要不要递下一首。
   *
   * 0.16.58 重写，用户逐条给的口径：
   *   - **只有「她推给他、他接受了」才准接**（`chain.json` 里 `origin === 'her-offer'`）。
   *     他自己叫她放歌（`netease_play` 工具）、程序自动放的、他在客户端自己点的，一律不接 —— 这是他明确要的，
   *     也是原来那堆误触发的根子：以前只比歌名，不记「这首是谁让放的」。
   *   - **没有「最多 6 首」**，一直往下接。
   *   - 递出一首**立刻刷新推荐**，下一轮就从刷新后的新推荐里读（第一次点的时候不刷新）。
   *   - 播报先出口，播放失败**必须兜底**：撤回那首、告诉她没放成、别让面板还挂着「下一首播放」。
   *   - 勾了「接力点歌歌单」时，接力的歌落进「AI 推荐歌单」；每天按设定小时**懒清零**
   *     （到点没开电脑就不管，下一次接力触发时先清再跑）。
   *
   * 到点判断靠 `py\progress.js` 读页面进度条（SMTC 没有进度）。剩 `AHEAD_SEC`（5 秒）时才动作。
   */
  /**
   * 0.17.39（用户口径）：递完一首之后**只刷新当前来源**。
   *
   * 以前两处都无条件 `generateRecommend()`：选了「按天气」时，每递一首仍然要重算一次
   * 历史推荐（约 300 条向量，是整个插件最贵的一环），而那份结果根本没人看。
   * 天气模式不刷任何东西 —— 它的名单自己按 `weather-cache.json` 的版本走。
   */
  _refreshChainSource(cfg) {
    if (!isHistoryActive(cfg)) return;
    generateRecommend(cfg).catch(() => { /* 失败会落到负缓存，面板下一轮显示原因 */ });
  }

  /**
   * 0.17.33：接力挑下一首 —— 来源二选一（用户口径：点一个，另一个自动关）。
   *   chainSource = 'reco'（默认）→ 卡①「今天听点什么」那份推荐；
   *   chainSource = 'wx'         → 卡片5「按天气听点什么」算出来的名单（取第一名，被排除就顺位）。
   * 天气这路没名单（没查到 / 模型不在 / 池子空）→ 退回推荐，别让接力断在这里。
   * 返回里带 `src`，播报那一句靠它决定要不要垫天气话。
   */
  async pickNext(c, { exclude = [] } = {}) {
    // 0.17.39：来源只认 source.js 的翻译，别处不再写 c.chainSource === 'wx'
    const src = activeSource(c) === 'weather' ? 'wx' : 'reco';
    if (src === 'wx') {
      /* 0.1.19（007，用户口径）：天气这一路是「一句话配一首歌」。
         这一步就是消耗下一句：取这句 → 算它那首 → 歌和句都从候选里划掉 → 写进列表。
         100 首的向量在本轮开轮时已经算好，所以这里只剩 20 毫秒左右；
         句子和歌是同一份（pickNext 返回的 line 就是这首歌配的那句）。 */
      try {
        const p = await nextWxSong(c, { exclude });
        if (p) return p;
      } catch { /* 下面统一退回推荐 */ }
      let snap = null;
      try { snap = peekWxReco(c, { kick: false }); } catch { snap = null; }
      logChainEvent({ ev: 'wx-fallback', why: String((snap && (snap.reason || snap.error)) || 'no-wx-list') });
    }
    const q = await pickIdleSong(c, { exclude });
    return q ? { ...q, src: 'reco' } : null;
  }

  async chainGate({ title, artist, id: playingId = '' } = {}) {
    const c = (this.ctx && this.ctx.cfg) || {};
    const name = String(title || '').trim();
    // 0.17.46：播放条里的歌曲 id（没有就空串，比较时自动退回名字）
    const nameId = String(playingId || '').trim();
    if (!name) return { ok: false, reason: 'no-title' };

    // 0.16.86（第 132 节 A8）：原来这里先判「自动连播队列」，那段已经整条删掉（queue.js 也没了）——
    // 接力点歌本来就是「一首接一首」，不需要再挂一套 5 首的清单。
    if (c.chainPick === false) return { ok: false, reason: 'off' };
    // 0.0.1.6.34：客户端没开时接力毫无意义（读不到进度、也放不了下一首），直接不动作
    if (!(await cdpAlive(c.cdpPort))) return { ok: false, reason: 'player-off' };

    // ② 来源判定（0.16.58）：只有「她推给他、他接受了」这一轮才准接。
    // 0.16.65：来源不再靠歌名反推 —— 从 1 号窗口（此刻页）点的就是她的这条线，
    // 见 src\panel.js 的 playTrack()。这里只管「装填 → 落地 → 盯进度」。
    let st = peekChain();
    const k = keyOf(name);
    // 第 146 节：本轮是否「播报过、还没投递」—— 播报过就不许再换歌
    let forceNow = false;

    // 0.16.67（第 99 节）：这一轮已经收场（切歌 / 装填被切走 / 不是她的歌）→ 直接返回。
    // 收场只做一次：以前同一个「切歌」事件每 12 秒被重判一次 not-hers，每次都把整份状态倒空。
    if (st && st.closed) {
      return { ok: false, reason: 'closed', why: String(st.closed.reason || '') };
    }

    // 0.17.18（方案 B，A 的保险）：他点歌的请求还在飞（30 秒内）→ 一律不动。
    // 不管 `next.said` 有没有、承诺多新，都不许在这段时间把歌投出去盖掉他点的。
    if (userRequestHold(st)) {
      return { ok: false, reason: 'user-request' };
    }

    /* 0.17.43（A8）：用户刚有动作（点歌 / 手动切歌 / 换来源）→ 接力静默。
       以前只有 chain.json 里的 user-ask / closed 能挡，覆盖不到"动作了但状态还没写"的间隙；
       现在统一由 userAction.js 记，以后要加新类型只改那里。 */
    if (blockingUserAction(USER_ACTION_HOLD_MS)) {
      return { ok: false, reason: 'user-action', kind: lastUserAction().kind };
    }

    // 装填中：他点的这首还没落到播放条上（快路径 1.4 秒、慢路径 5~10 秒）。
    // **这一段不算切歌** —— 她刚把歌递出去、客户端还在切，播放条上仍是上一首。
    // 顺手把「现在播放条上是哪首」记下来，落地以后才有基准去判切歌。
    if (st && st.origin === 'her-offer' && st.pending) {
      if (sameTrack(st.pending.name, st.pending.id, name, nameId)) {
        // 落地了 —— 记一笔，后面按 base 正常盯进度
        st = saveChain({ pending: null, lastSeen: name, lastSeenId: nameId });
      } else if (Date.now() - Number(st.pending.at || 0) >= ARM_GIVEUP_MS) {
        // 60 秒兜底（读不到标题、客户端没动静的情况）→ 收掉这一轮
        markClosed('arming-giveup');
        return { ok: false, reason: 'arming-giveup' };
      } else {
        // 还在切歌途中，播放条上还是上一首 —— 只记基准，不判、不清
        if (!sameTrack(String(st.lastSeen || ''), st.lastSeenId, name, nameId)) st = saveChain({ lastSeen: name, lastSeenId: nameId });
        return { ok: false, reason: 'arming' };
      }
    }

    // 0.16.86（第 134 节 A1/A2，用户口径，已确认可行）：刚递完一首 → 30 秒核对窗口。
    // 现场起因：提前 10 秒挑好，慢路径切歌要 5~10 秒；这几秒里网易云客户端自己把歌单切到下一首，
    // 采样看到歌名变了就判成「你换了歌」→ 接力标停止；随后慢路径跑好又把歌切回目标歌。
    // 现在：放成功那一刻起 30 秒内**不判切歌、不递歌**（顺手锁住递歌），到点才核对当前放的是不是它。
      const verify = st && st.verify;
      if (verify && verify.name) {
      const elapsed = Date.now() - Number(verify.at || 0);
      if (elapsed < VERIFY_WAIT_MS) {
        // 窗口内：只记基准，别的都不做 —— 递歌也被这一层挡在门外
        if (!sameTrack(String(st.lastSeen || ''), st.lastSeenId, name, nameId)) st = saveChain({ lastSeen: name, lastSeenId: nameId });
        return {
          ok: false,
          reason: 'verifying',
          target: verify.name,
          in: Math.max(1, Math.round((VERIFY_WAIT_MS - elapsed) / 1000)),
        };
      }
      if (sameTrack(verify.name, verify.id, name, nameId)) {
        // 目标歌确实在放 → 核对通过，清掉标记，接着按 base 正常跑
        st = saveChain({ verify: null, lastSeen: name, lastSeenId: nameId });
      } else {
        // 到点还不在目标歌上 → 这才是真被他切走了
        saveChain({ verify: null, next: null, nextAt: 0 });
        // 手动换歌了：还在合成/播的那句「即将播放」一起撤掉，别念了又不换
        stopSpeaking();
        // 0.17.43（A8）：手动换歌 = 用户动作，记一条，闸门静默 45 秒
        markUserAction('switch', name);
        markClosed('verified-switched');
        await this.chainStopNotice(c, '你换了歌');
        return { ok: false, reason: 'verified-switched', target: verify.name, now: name };
      }
    }
      // 0.16.67（第 99 节）：**还没播报时切歌就停止**（第 146 节起：播报了就不换）。
    // 判据不再是「歌名和 base 比不相等」，而是「上一次采样看到的是哪首、这一次变成了什么」。
    // 第 146 节（用户口径，11-24）：「以播报为准，确定了播报内容，接力点歌就不再更换了」。
    // 播报一旦出口（next.said），那首歌就定了 —— 不再重挑、不再作废、也不按「他换歌」收场。
    const promised = !!(st && st.next && st.next.name && st.next.said
      && Date.now() - Number(st.nextAt || 0) < PROMISE_TTL_MS);
    // 承诺的那首已经在放了（客户端自己切过去 / 上次投递已落地）→ 记成已投，别重复放
    if (promised && sameTrack(st.next.name, st.next.id, name, nameId)) {
      const cnt = (Number(st.count) || 0) + 1;
      saveChain({
        next: null, nextAt: 0,
        base: { name: st.next.name, artist: st.next.artist || '', id: String(st.next.id || '') },
        count: cnt, offeredBaseKey: '', offer: null, fail: null,
        verify: { name: st.next.name, artist: st.next.artist || '', id: String(st.next.id || ''), at: Date.now() },
        lastSeen: name, lastSeenId: nameId,
      });
      logChainEvent({ ev: 'delivered-already', name: st.next.name, count: cnt });
      return { ok: true, count: cnt, offer: st.next, played: true, left: null, reason: 'already-playing' };
    }
    const prevSeen = String((st && st.lastSeen) || '');
    const prevSeenId = String((st && st.lastSeenId) || '');
    if (prevSeen && !sameTrack(prevSeen, prevSeenId, name, nameId)) {
      const herName = (st && st.base && st.base.name) || '';
      const onHer = herName ? sameTrack(herName, st.base && st.base.id, name, nameId) : false;
      if (!onHer) {
        if (promised) {
          // 播报过了 → 不关闸、不作废；把这一次「歌换了」当作投递时机，下面直接放它
          logChainEvent({ ev: 'switch-after-announce', from: prevSeen, to: name, next: st.next.name });
          st = saveChain({ lastSeen: name, lastSeenId: nameId });
          forceNow = true;
        } else {
          // 还没播报（离结尾还远）→ 他真想换歌，这一轮到此为止
          saveChain({ next: null, nextAt: 0 });
          stopSpeaking();
          markUserAction('switch', name);
          markClosed('switched');
          // 第 118 节（用户口径）：收场不能是静默的 —— 给他一句「自动切歌已暂停」
          await this.chainStopNotice(c, '你换了歌');
          return { ok: false, reason: 'switched', from: prevSeen, to: name };
        }
      }
      st = saveChain({ lastSeen: name, lastSeenId: nameId });
    } else if (st && !prevSeen) {
      // 第一次采样：只记基准
      st = saveChain({ lastSeen: name, lastSeenId: nameId });
    }
    // 0.16.64：判定抽成 `chain.gateVerdict()` 纯函数（可自测），这里只按结论走。
    // 第 146 节：forceNow（播报过、歌被换掉）时不再判来源 —— base 已经对不上，再判只会把承诺收掉
    const verdict = forceNow ? '' : gateVerdict(st, name, Date.now(), nameId);
    if (verdict) {
      // not-hers 现在也只「收场」，不再 clearChain() —— 那会把「今天已清空」的章一起抹掉（第 97 节）
      if (verdict === 'not-hers') {
        stopSpeaking();
        markUserAction('switch', name);
        markClosed('not-hers');
        // 第 118 节：同样是「他切走了」，同样要给反馈，别让他以为接力还在跑
        await this.chainStopNotice(c, '放的已经不是那首了');
      }
      return { ok: false, reason: verdict };
    }

    // ③ 歌单每日清零（懒清零：到点没开电脑就不管，下一次接力触发时先清再跑）
    //    清完把当前这首补回去，别留空歌单（第 91 节）
    await this.dailyClearReco(c, { name, artist });

    const prog = await readProgress({ cdpPort: c.cdpPort, fresh: true });
    const progOk = !!(prog && prog.ok && Number.isFinite(prog.d) && Number.isFinite(prog.left));
    // 第 146 节：forceNow = 播报过的那首已经不能再等（当前这首被换掉/放完了）→ 不看进度，直接投
    if (!progOk && !forceNow) {
      return { ok: false, reason: 'no-progress', error: (prog && prog.error) || '' };
    }
    // 第 112 节：剩 SAY_AHEAD_SEC（20 秒）才开始动作 —— 20~5 秒只播报，5 秒以内才真放。
    // 以前这里是 AHEAD_SEC（5 秒），播报和切歌挤在同一刻，TTS 还没说完歌就放完了。
    if (!forceNow && progOk && prog.left > SAY_AHEAD_SEC) return { ok: false, reason: 'early', left: Math.round(prog.left) };

    // 0.16.66（第 93 节）：上一次递歌失败了 → 隔 20 秒重试一次，一首最多 3 次。
    // 以前失败一次就收工等这首放完，而这首根本没被换掉，等于要空等一整遍（最长四五分钟），
    // 从外面看就是「接力断了」。这里把「下次什么时候再试」写进返回值，也让状态可见。
    const failAt = Number(st.fail && st.fail.at) || 0;
    const failCount = Number(st.fail && st.fail.count) || 0;
    if (failAt && failCount >= CHAIN_RETRY_MAX) {
      return { ok: false, reason: 'retry-giveup', fail: st.fail, tries: failCount };
    }
    if (failAt && Date.now() - failAt < CHAIN_RETRY_MS) {
      return {
        ok: false,
        reason: 'retry-wait',
        fail: st.fail,
        in: Math.max(1, Math.round((CHAIN_RETRY_MS - (Date.now() - failAt)) / 1000)),
      };
    }

    // ③-A 播报窗口（剩 SAY_AHEAD_SEC ~ AHEAD_SEC 秒）：**只挑一次、只播一次**
    if (!forceNow && progOk && prog.left > AHEAD_SEC) {
      let picked = st.next;
      // 60 秒还没放掉 → 作废重挑（中途暂停、拖了进度条会走到这里）
      // 第 146 节：已播报（承诺）的那首不按 60 秒作废，只在 PROMISE_TTL_MS 之后放掉
      if (picked && !picked.said && Date.now() - Number(st.nextAt || 0) >= ARM_GIVEUP_MS) picked = null;
      if (picked && picked.said && Date.now() - Number(st.nextAt || 0) >= PROMISE_TTL_MS) picked = null;
      if (picked) {
        // 已经挑好、已经播过 —— 每 3 秒一次的采样到这里就返回，别重复播
        return { ok: false, reason: 'announced', next: picked.name, left: Math.round(prog.left) };
      }
      const p = await this.pickNext(c, { exclude: [name, st.base.name, st.offer && st.offer.name] });
      if (!p) return { ok: false, reason: 'no-next' };
      const cand = { name: p.name, artist: p.artist || '', id: p.id || '', src: p.src || '' };
      // 只写 next / offer。**绝不能在这里写 offeredBaseKey** —— gateVerdict 见到它就会
      // 一直返回 'offered'，3 秒后每次采样都在上面那层被挡回去，永远进不了切歌窗口。
      saveChain({ next: { ...cand, said: false }, nextAt: Date.now(), offer: p });
      // 第 117 节（用户口径）：**播报是「发出去就完事」** —— 不 await、不关心成败。
      // TTS 合成要时间，而且随 CPU 占用时快时慢：在这里 await 等于把采样器整整卡住几秒，
      // 切歌窗口就这么被吞掉（第 117 节现场就是这么死的）。
      // 插件这边只对「切歌」负责，播报慢了、失败了都不影响。
      this.sayChain({ next: p, left: prog.left }).catch(() => {});
      saveChain({ next: { ...cand, said: true } });
      // 第 146 节：播报 = 承诺，从这一刻起这首就定了（记一行，事后能还原）
      logChainEvent({ ev: 'announced', name: p.name, artist: p.artist || '', left: Math.round(prog.left), base: name });
      // 0.17.39：只有「听歌历史」是当前来源时才递后刷推荐；天气模式不许顺带重算另一路。
      this._refreshChainSource(c);
      return {
        ok: false,
        reason: 'announced',
        next: p.name,
        spoken: '',
        left: Math.round(prog.left),
      };
    }

    // ③-B 切歌窗口（剩 AHEAD_SEC 秒以内）：放已经挑好的那首，不再挑、不再播
    // 第 146 节：已经播报出去的那首一直有效（PROMISE_TTL_MS 内），不按 60 秒作废
    const nextTtl = st.next && st.next.said ? PROMISE_TTL_MS : ARM_GIVEUP_MS;
    let next = st.next && Date.now() - Number(st.nextAt || 0) < nextTtl ? st.next : null;
    if (!next && !forceNow) {
      // 没赶上播报窗口（一进来就剩 5 秒 / 拖了进度 / next 过期）→ 现挑现播，但也不能静默
      const p = await this.pickNext(c, { exclude: [name, st.base.name, st.offer && st.offer.name] });
      if (!p) return { ok: false, reason: 'no-next' };
      next = { name: p.name, artist: p.artist || '', id: p.id || '', src: p.src || '', said: false };
    }

    if (!next) {
      // 承诺的那首不见了（理论上不会发生）→ 收场，别把 null 递下去
      markClosed('promise-lost');
      return { ok: false, reason: 'promise-lost' };
    }
    const nextCount = (Number(st.count) || 0) + 1;
    // 先把「已经为哪一首递过」按上，避免 3 秒后采样器又进来递第二遍
    saveChain({ offer: next, count: nextCount, offeredBaseKey: k, next: null, nextAt: 0 });

    // ④ 播报：提前那次已经出口了就直接放；没出口（才赶上切歌窗口）就**顺手发一句**再放。
    // 第 117 节：这里同样不 await —— 补播报若阻塞 3~4 秒，歌就放到尾了，等于白等。
    // 发出去立刻往下走放歌，两件事并行。
    if (!next.said) this.sayChain({ next, left: prog.left }).catch(() => { /* 播报失败不管，只对切歌负责 */ });

    // ⑤ 递出去之后立刻刷新推荐（用户口径：第一次点不刷，推送以后立即刷新，再重新读）
    //    0.17.39：只有历史来源才刷；天气模式下这一句会把最贵的一环（300 条向量）白烧一次。
    if (!next.said) this._refreshChainSource(c);

    logChainEvent({
      ev: 'deliver', name: next.name, artist: next.artist || '', count: nextCount,
      by: forceNow ? 'after-announce' : (next.said ? 'window' : 'late'),
      left: progOk ? Math.round(prog.left) : null, said: !!next.said,
    });
    // ⑥ 真的放起来
    // 第 121 节（用户口径）：接力这条和 1 号窗口点歌**是同一个东西** ——
    // 同样按 1 号窗口算、同样看那个勾。原来这里传的是原始配置，`playlist` 是空串 →
    // 快路径把歌加进默认歌单（小菱的歌单），⑧ 步又加进 AI 推荐歌单，一张歌被塞进两张。
    const played = await playSong(applyPick(c, PANEL_NOW), next, 'auto');

    if (!played || !played.ok) {
      // 播报已经出口了，放失败 → 撤掉那首、面板别挂着「下一首播放《X》」，并告诉她一声
      const why = (played && played.message) || '放不了';
      logChainEvent({ ev: 'fail', name: next.name, why, tries: failCount + 1 });
      saveChain({
        offer: null,
        offeredBaseKey: '',
        // 0.16.66（第 93 节）：记一次失败 + 次数，20 秒后由上面的 retry-wait 再试
        fail: { name: next.name, why, at: Date.now(), count: failCount + 1 },
      });
      /* 0.17.43（A7）：同一句「没放上」以前走两条声道 —— `pushHerLine`（宿主事件，宿主 AI 再回话）
         和本机 `speak`（TTS）。用户实际听到过两次。现在只走一条：
           安静时间 → 两条都不出声（面板照样显示）；
           否则先本机 TTS，TTS 不可用/失败才退回宿主事件。
         0.16.66 的口径不变：放失败必须让他听见，不能变成静默的假播报。 */
      if (!inQuietHours(c)) {
        const sayText = failCount + 1 >= CHAIN_RETRY_MAX
          ? `《${next.name}》没放上，这首先跳过。`
          : `《${next.name}》没放上，我一会儿再试。`;
        const sr = await speak({ text: sayText, url: c.ttsUrl, engine: c.ttsEngine, voice: c.ttsVoice }).catch(() => null);
        if (!sr || sr.ok === false) {
          // 0.17.58：「别自己去点界面」这句命令从正文里去掉 —— 它本来就写在 ENV_PROMPT.md 的「不要做」里，
          // 外部内容通道只说她这句话本身。
          await this.pushHerLine(`没放上《${next.name}》——${why}。`, { kind: 'chain-fail' });
        }
      }

      return {
        ok: false,
        reason: 'play-failed',
        offer: next,
        // 第 117 节：播报不再等待结果，所以这里没有「说了什么」可回填
        spoken: '',
        message: why,
        left: Math.round(prog.left),
      };
    }

    // ⑦ 放成了 → 基准换成新这首，下一轮才能顺着往下接
    saveChain({
      base: { name: next.name, artist: next.artist || '', id: String(next.id || '') },
      // 第 147 节：放成功就把它搬进 base，offer 必须清掉 —— 留着的话 displayOffer()
      // 永远先给 offer，面板一直挂「我挑中了《这首已经放着的歌》」，推荐刷新后的新预告显示不出来。
      offer: null,
      verify: { name: next.name, artist: next.artist || '', id: String(next.id || ''), at: Date.now() },
      count: nextCount,
      offeredBaseKey: '',
      fail: null,
    });

    // 第 146 节：播报 → 投递 → 成功，这个事件到这儿才算完
    logChainEvent({ ev: 'delivered', name: next.name, artist: next.artist || '', count: nextCount });

    // 0.1.19（007）：天气模式放成这首，**不在这里划掉** —— 这首在「选它的那一刻」就已经
    // 从候选里消耗掉了（列表里它是"本轮已投递"）。这里再 drop 等于 10 秒后把已投的记录删掉。

    // ⑧ 第 121 节：这一步**删掉**了。
    // 目标歌单已经在 ⑥ 之前定死（`applyPick(c, PANEL_NOW)`），快路径的 del+add、
    // 慢路径的 addplay 都会把歌放进那张歌单 —— 这里再 add 一遍是往同一张加第二次。
    // （`dailyClearReco()` 清完补回当前那首仍然用它，那是另一件事，见下面 :1423。）

    return {
      ok: true,
      count: nextCount,
      offer: next,
      left: Math.round(prog.left),
      spoken: '',
      played: true,
    };
  }

  /**
   * 「AI 推荐歌单」每天清零一次 —— 懒清零。
   * 用户口径：到点时电脑没开、也没在听歌，那就不管；只要过了那个时间，
   * **第二次触发 AI 接力的时候**就直接清零，清完再往下走。
   *
   * 0.16.66（第 91 节）两处修正：
   * ① 以前不管清空成不成功都记账 —— 网易云那边一步没走通（限流、歌单被改锁），
   *    照样盖当天的章，这一整天就再也不清了。现在只认 `ok`。
   * ② 清零是整张清，会把「他今天刚点进去的那首」一起清掉，于是歌单从 1 首变 0 首，
   *    而这一轮挑的歌又因为第 90 节那个字段错配没放上也没加回来 —— 歌单就一直空着。
   *    现在清完把**当前正在放的这首**补回去，至少不会出现空歌单。
   */
  async dailyClearReco(c, keep) {
    if (c.chainClearDaily === false) return { ok: false, reason: 'off' };
    // 清空本身要两三秒（300 首要按批删），失败了每 12 秒触发一次太亏 —— 失败后冷却 5 分钟
    const now = Date.now();
    if (this._clearFailAt && now - this._clearFailAt < CLEAR_FAIL_COOLDOWN_MS) {
      return { ok: false, reason: 'retry-wait' };
    }
    const hour = Number.isFinite(Number(c.chainClearHour)) ? Number(c.chainClearHour) : 6;

    // 0.16.67（第 97 节）：**先读「今天是否已清空」这个字段，再决定要不要清。**
    // 读到 cleared=1 且日期就是今天这一轮 → 直接返回，连 clearRecoPlaylist() 都不发。
    // 这个章现在存在 data\reco-clear.json 里，chain.json 怎么被重置都不影响它。
    let rec = null;
    try {
      rec = await readRecoClear();
    } catch {
      rec = null;
    }
    if (isClearedToday(rec, hour)) return { ok: false, reason: 'done', day: String(rec.day || '') };

    try {
      const r = await clearRecoPlaylist();
      if (!r || !r.ok) {
        this._clearFailAt = now;
        return { ok: false, reason: 'clear-failed', message: (r && r.message) || '清空失败', playlist: RECO_PLAYLIST_NAME };
      }
      this._clearFailAt = 0;
      // 只有真清成功才记作 1（以前不管成败都盖章 → 一次限流这一整天就再也不清了）
      await writeRecoClear({
        day: currentDayKey(hour),
        cleared: 1,
        hour,
        at: new Date().toISOString(),
        removed: (r && r.removed) || 0,
        kept: (keep && keep.name) || '',
      });
      if (keep && keep.name) {
        addToRecoPlaylist([{ name: keep.name, artist: keep.artist || '', id: keep.id }])
          .catch(() => { /* 补不回去也不影响这一轮 */ });
      }
      return { ok: true, removed: (r && r.removed) || 0, kept: (keep && keep.name) || '', playlist: RECO_PLAYLIST_NAME };
    } catch (e) {
      this._clearFailAt = now;
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * 第 118 节 → 第 131 节改写：接力被停掉的**状态标记**不再走「她开口」这条通道。
   *
   * 来龙去脉：118.5 用户说「自动切歌已暂停这个播报我没有要求加呀」——
   * 要的是「能看见状态」，不是念出来。后来实测发现连面板都没显示出来，
   * 因为这里写的是 `pushHerLine`（事件通道 → 宿主 AI 回话），根本不在「接力点歌」那一块。
   *
   * 现在改由 `panel.js` 的 `chainState` 直接投影：`closed` 写下去，
   * 面板就显示「接力点歌已停止」。所以这个函数不再需要，也不该再走事件通道出声。
   */
  async chainStopNotice() {
    // 留个空壳只为兼容旧调用点：真状态由 chain.js 的 chainStateOf() 从 closed 字段读出来
    return { ok: false, reason: 'moved-to-panel-state' };
  }

  /**
   * 到点只说一句「即将播放《X》，歌手」，说完直接放（0.0.1.6.22 的口径）。
   * 不念「还剩多少秒」—— 那是机器的说法。
   *
   * 第 127 节（用户口径）：
   *   - 台词从「下一首播放《X》」改成「即将播放」
   *   - 演唱者放到前面：「即将播放张宇的《趁早》。」
   *   - 没有歌手名就只念歌名，别念成「即将播放的《X》」
   */
  async sayChain({ next, left } = {}) {
    const c = (this.ctx && this.ctx.cfg) || {};
    if (!next || !next.name) return { ok: false, reason: 'empty' };
    const who = String(next.artist || '').trim();
    let spoken = who
      ? `即将播放${who}的《${next.name}》。`
      : `即将播放《${next.name}》。`;
    // 0.17.33：这一首是按天气挑的 → 播报前面垫上模型按天气写的那句（卡片5 状态栏同一句）。
    // 挑歌来源是 reco 的不垫，仍是原来那一句。
    // 0.17.39：再加一道来源校验 —— 开关已经切回历史时，不许再念旧天气那句。
    if (String(next.src || '') === 'wx' && isWeatherActive(c)) {
      /* 0.1.19（007）：播报垫的是**这首歌配的那句**（一句配一首），next.line 由挑歌时带回；
         取不到才退回 state.line。 */
      const own = String(next.line || '').trim();
      let snap = null;
      try { snap = peekWxReco(c, { kick: false }); } catch { snap = null; }
      const tail = own || (snap && snap.ok ? String(snap.line || snap.weather || '').trim() : '');
      if (tail) spoken = `${tail}${/[。！？!?，,]$/.test(tail) ? '' : '。'}${spoken}`;
    }
    // 0.16.89（第 142 节）：这一声有开关（chainSpeak，默认开）。关掉只少一句声音，
    // 挑歌 / 递歌 / 面板显示全不变 —— 调用点本来就 .catch() 不看结果，直接返回就行。
    if (c.chainSpeak === false) return { ok: false, reason: 'muted', spoken, left: Number(left) || 0 };
    // 0.17.11：安静时间不出声；挑歌、递歌、面板照样走，只是没这一句（先判这条，安静优先）
    if (inQuietHours(c)) return { ok: false, reason: 'quiet-hours', quiet: true, spoken, left: Number(left) || 0 };
    // 0.17.19：出口前再判一次接力状态（跟面板那一块共用 `chainStateOf`）。
    // 已经停止 / 收场 / 来源不是 her-offer / 要念的那首已经被撤掉 → 这句不出声。
    if (!chainSpeakAllowed(peekChain(), next.name)) {
      return { ok: false, reason: 'chain-stopped', spoken, left: Number(left) || 0 };
    }
    const sr = await speak({ text: spoken, url: c.ttsUrl, engine: c.ttsEngine, voice: c.ttsVoice });
    // 合成途中被用户打点歌打断（stopSpeaking 已把代次改掉）→ 如实报 canceled
    if (sr && sr.reason === 'cancelled') {
      return { ok: false, reason: 'cancelled', spoken, left: Number(left) || 0 };
    }
    return { ...sr, spoken, left: Number(left) || 0 };
  }

  async stop() {
    stopAnswerWatch();
    if (this._clientTimer) {
      clearInterval(this._clientTimer);
      this._clientTimer = null;
    }
    await stopSampler();
    // 没有常驻连接要断
  }
}
