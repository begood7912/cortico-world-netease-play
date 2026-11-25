/**
 * 听歌次数采集器（常驻）。
 *
 * 和「点歌次数」是两码事：
 *   点歌 = 老大开口点了哪首（`notes\点歌次数.json`）
 *   听歌 = 网易云实际放到哪首、听了多久（这里，`data\listening.jsonl`）
 *
 * 采样：每 10 秒读一次当前曲目（0.17.52 起走 track.js：CDP + 详情接口，PowerShell 只兜底）。
 *
 * 落盘方式（2026-11-22 改过一版）：
 *   原来只在「换曲 / 停止」时结算，结果面板数字十几分钟不动，看着像坏了。
 *   现在**每次采样都把这一段的增量写一行**，同一段共享同一个 `at`（段开始时间），
 *   面板那边按 `at` 合并 → 时长相加、次数按段算。落盘最多晚 10 秒。
 *
 * 几个必须守住的细节：
 *   - 单次读不到不算换曲。要连续 3 次（约 30 秒）读不到才关段 ——
 *     否则窗口标题一闪空，同一首歌就会被劈成两段、记成两次（这个坑踩过了）。
 *   - 暂停不清段：暂停半小时再继续，仍算同一次收听（暂停期间不累计时长）。
 *   - 单曲循环会被 SEG_MAX_SEC 切开：听满 5 分钟开新段，等于又听了一遍。
 *   - 每次间隔按 3×采样周期封顶：机器休眠回来时间戳会跳很远，不封顶会凭空多记几小时。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { state, ensureDir, STATE_DIR } from './store.js';
import { join } from 'node:path';
import { PKG_ROOT } from './python.js';
// 0.17.52（B3）：当前曲目统一走 track.js（CDP + 详情接口），PowerShell 只做兜底
import { currentTrack } from './track.js';
// 0.16.66（第 94/95 节）：播报时机改成看「这一遍放到哪」，得读一次播放进度
import { readProgress } from './progress.js';
import { clearQuiet } from './quiet.js';
// 0.17.4：听歌流水也记歌曲 id —— 账本本来就按 id 记，流水只有歌名/歌手，排名页对不上号
import { cachedId, resolveId } from './songid.js';
import { external } from './log.js';

const FILE = state('listening.jsonl');

import {
  SAMPLE_MS, IDLE_MS, MISS_TO_CLOSE, MIN_SEC, SEG_MAX_SEC, REWIND_SEC,
  SAY_AFTER_SEC, LIKE_AFTER_SEC, COMMENT_AFTER_SEC, CONFIRM_MS,
  GATE_WIN_SEC, IDLE_MIN_SEC, IDLE_REPEAT_DEFAULT_SEC,
} from './constants.js';

/** 单次间隔的上限：机器休眠回来时间戳会跳很远，不封顶会凭空多记几小时。 */
const MAX_GAP = Math.max(SAMPLE_MS * 6, 60_000);

/** 当前这一段：同一首歌、同一段开始时间。 */
let seg = null;              // { title, artist, key, startAt, sec, t0, lastT, checking, said, likeChecking, liked, commentChecking, commentSaid }
/** 采样器要读播放进度（CDP 端口），由 World 启动时传进来（第 94/95 节）。没传就只按听歌时长算。 */
let samplerPort = null;
let timer = null;
let lastTickAt = 0;
let misses = 0;
let flushing = false;
let announcer = null;
let warmer = null;
let likeSayer = null;
let commentSayer = null;
let idleSayer = null;
let idleSecGetter = null;
let idleRepeatGetter = null;
/** 注入「上一次开口/作答的时刻」的取值函数 —— 冷却是配置项，得活过重启（0.0.1.6.29）。 */
let idleAnchorGetter = null;
let chainGate = null;
/** 接力点歌：听满这么久才开始问「快放完了吗」（太早去读进度没意义）。 */
const CHAIN_AFTER_SEC = 10;
/**
 * 同一首最多每 3 秒问一次闸 —— 闸里面会起子进程读进度，不能每跳都问。
 * 从 12 秒降到 3 秒（0.0.1.6.11）：递歌窗口从「剩 35 秒」收窄到「剩 5 秒」，
 * 窗口比 12 秒的节流短，不加密就会整首漏过去。
 */
const CHAIN_GATE_MS = 3_000;
/** 不在播放状态是从什么时候开始的（毫秒）。在放歌就清成 null。 */
let idleSince = null;
/** 上一次提过的时刻。 */
let idleAskedAt = 0;
/** 最近一次「真在播放」的时刻 —— 面板/工具要看「安静多久了」时用得上。 */
let lastLiveAt = 0;

/**
 * 注册「没放歌且安静够久，主动问一句要不要听」的回调（卡① 的互动段）。
 * 阈值由 getIdleSec() 每次现取：这是配置项，用户在设置页改完要立刻生效，不能存一份旧的。
 */
export function setIdleSayer(fn) {
  idleSayer = typeof fn === 'function' ? fn : null;
}

/** 注入「安静多少秒才开口」的取值函数。返回 0 表示关掉。 */
export function setIdleSec(fn) {
  idleSecGetter = typeof fn === 'function' ? fn : null;
}

/** 注入「开过一次口之后，隔多少秒才允许再开口」的取值函数。返回 0 用默认（1 小时）。 */
export function setIdleRepeat(fn) {
  idleRepeatGetter = typeof fn === 'function' ? fn : null;
}

/**
 * 注册「上一次开口/作答时刻」的取值函数（返回毫秒，0 = 没记录）。
 * 采样器重启时拿它把 `idleAskedAt` 补回来，不然一重启冷却就归零、一分钟又开口一次。
 */
export function setIdleAnchor(fn) {
  idleAnchorGetter = typeof fn === 'function' ? fn : null;
}

/**
 * 注册「接力点歌」的闸（卡① 的第二段互动）。
 * 采样器只管到点问一声「这首放的是她给的歌吗」，判断、读进度、挑下一首全在 world 里。
 * 这样采集器不用知道她给过谁什么，也不会因为读进度失败而影响记时。
 */
export function setChainGate(fn) {
  chainGate = typeof fn === 'function' ? fn : null;
}

function idleSecNow() {
  if (!idleSecGetter) return 0;
  try {
    const n = Number(idleSecGetter());
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n >= IDLE_MIN_SEC ? n : IDLE_MIN_SEC;
  } catch {
    return 0;
  }
}

/**
 * 两次开口之间至少隔多少秒。返回 0 = 只问第一次，以后都不再问（设置项填 0，用户 0.0.1.6.15）。
 */
function idleRepeatSecNow() {
  if (!idleRepeatGetter) return IDLE_REPEAT_DEFAULT_SEC;
  try {
    const n = Number(idleRepeatGetter());
    if (!Number.isFinite(n)) return IDLE_REPEAT_DEFAULT_SEC;
    if (n <= 0) return 0;
    return Math.max(IDLE_MIN_SEC, n);
  } catch {
    return IDLE_REPEAT_DEFAULT_SEC;
  }
}

/** 安静了多久（秒）。没在放歌时才算得出来，在放歌返回 0。 */
export function idleSecs() {
  if (idleSince == null) return 0;
  return Math.max(0, Math.round((Date.now() - idleSince) / 1000));
}

/** 最近一次「真在播放」的时刻（毫秒）。没放过返回 0。 */
export function lastPlayedAt() {
  return lastLiveAt;
}

/** 0.17.54：这一「遍」的世代号 —— 换歌 / 重播都会 +1，卡②③④ 靠它判断要不要重算。
    5 分钟切段（SEG_MAX_SEC）不算新的一遍，gen 不变。 */
let playGen = 0;

/** 当前这一遍的世代号（没在放时是上一遍的值）。 */
export function trackGen() {
  return playGen;
}

/** 最近一段在放的曲目（停了也还留着，用来跟宿主说「上次停在哪首」）。 */
export function lastTrack() {
  return seg ? { title: seg.title, artist: seg.artist, id: seg.id || '', gen: Number(seg.gen) || playGen } : null;
}

/**
 * 把盘上的「上次开口/作答」补进进程内冷却基准（0.0.1.6.29 加的）。
 *
 * 0.0.1.6.41 起**不再恢复** —— 用户实测后明确要的是：
 * 「重启以后，默认的一分钟计时不存在」是 bug，重启就该从 0 重新计时，满 `idleFirstMin` 分钟就问。
 * 6.29 那时恢复基准，是为了治「反复按重启键 → 一分钟又问一次」；现在这个「毛病」正是用户要的行为，
 * 所以这里保留函数（world.js 还在调），但不再往回填 `idleAskedAt`。
 */
function restoreIdleAnchor() {
  /* no-op：重启后冷却从 0 算起，见上面那段。 */
}

/**
 * 注册「换歌了就重算那句」的回调（World.start 时注入）。
 * 采集器只负责发现换歌这件事，重算交给 world.js —— 它才知道模型怎么配。
 */
export function setWarmer(fn) {
  warmer = typeof fn === 'function' ? fn : null;
}

/**
 * 注册「听满 30 秒说一句」的回调（World.start 时注入）。
 * 这里只负责判断时机，说什么、怎么说由 world.js 决定 —— 采集器不该知道桌宠的事。
 */
export function setAnnouncer(fn) {
  announcer = typeof fn === 'function' ? fn : null;
}

/**
 * 注册「听满一分钟说喜不喜欢」的回调（卡② 用）。
 * 和上面那个分开：一个是听感，一个是判断，时间点也不同（30 秒 / 60 秒）。
 */
export function setLikeSayer(fn) {
  likeSayer = typeof fn === 'function' ? fn : null;
}

/**
 * 注册「听满一分半念一条评论」的回调（卡③ 用）。
 * 三个闸分开走：30 秒听感、60 秒喜不喜欢、90 秒念评论 —— 一句一句往外蹦，不挤在一起。
 */
export function setCommentSayer(fn) {
  commentSayer = typeof fn === 'function' ? fn : null;
}

const keyOf = (title, artist) => `${title}|${artist}`.toLowerCase();

async function append(rec) {
  try {
    ensureDir(STATE_DIR);
    await appendFile(FILE, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch {
    /* 写盘失败不该影响播放本身 */
  }
}

/** 把这一段的增量写一行。同一段的所有行 at 相同，读取时合并。 */
async function emit(seconds) {
  if (!seg) return;
  const n = Math.round(seconds);
  if (n <= 0) return;
  await append({
    t: seg.title,
    a: seg.artist,
    id: seg.id || '',
    at: new Date(seg.startAt).toISOString(),
    sec: n,
    ok: true,
  });
  seg.sec += seconds;
}

/**
 * 没在放歌时的计时与「主动问一句」。
 *
 * 几个刻意的处理：
 *   - 在放歌就清掉起点（idleSince = null），安静从「刚停下」那一刻算起；
 *   - `gap > MAX_GAP`（机器休眠/采样断过）时重新计时 —— 否则合盖一夜回来，
 *     第一次采样就会立刻说「现在太安静了」，那是在骂人；
 *   - 提过一次后重算起点，并且冷却 `idleRepeatSecNow()`（默认 1 小时，可配）。
 */
function checkIdle(t, gap, live) {
  if (live) {
    idleSince = null;
    return;
  }
  // 重启后的第一次判定：把盘上的冷却基准补回来（0.0.1.6.29）
  restoreIdleAnchor();
  // 在放歌又停了：从停的那一刻重新计时，别拿刚才的起点接着算
  if (idleSince == null || gap > MAX_GAP) idleSince = t;
  const want = idleSecNow();
  if (!idleSayer || want <= 0) return;
  const sec = (t - idleSince) / 1000;
  if (sec < want) return;
  // 两次开口的间隔（用户口径：发一次就不管它，等够时间再问第二次）
  // 间隔设成 0 = 只问第一次，往后一律不问
  if (idleAskedAt) {
    const repeatSec = idleRepeatSecNow();
    if (repeatSec <= 0) return;
    if (t - idleAskedAt < repeatSec * 1000) return;
  }
  idleAskedAt = t;
  idleSince = t;
  const snapSec = Math.round(sec);
  // 不 await：生成 + 合成要三四秒，等它就把采样循环堵住了。
  Promise.resolve()
    .then(() => idleSayer({ idleSec: snapSec }))
    .catch(() => { /* 说不出来就算了，下一轮再来 */ });
}

async function tick() {
  if (flushing) return;
  flushing = true;
  try {
    const t = Date.now();
    let gap = lastTickAt ? t - lastTickAt : 0;
    if (gap > MAX_GAP) gap = SAMPLE_MS;    // 休眠/卡顿回来的大跳，按一次采样算
    lastTickAt = t;

    let tr = null;
    try {
      tr = await currentTrack({ cdpPort: samplerPort, fresh: true });
    } catch {
      tr = null;
    }

    const title = String((tr && tr.title) || '').trim();
    // 「在放」= 有曲目 且 状态是 playing。客户端没开、暂停、放完了都算没在放。
    const live = !!(title && tr && tr.playing === true);
    if (live) lastLiveAt = t;
    // 0.0.1.6.40：SMTC 真的看到网易云在放歌了 → 「先安静着」这个临时开关立刻放开。
    // 用户口径：「如果检测到网易云在播的东西，就自动放开。」
    if (live) clearQuiet('smtc-playing');
    checkIdle(t, gap, live);

    if (!title) {
      // 一次读不到很常见（切歌间隙、窗口标题闪空、客户端刚开）。
      // 连吃 3 次才认定真的没在放，才把段关掉。
      misses += 1;
      if (misses >= MISS_TO_CLOSE) seg = null;
      return;
    }
    misses = 0;

    const artist = (tr && tr.artist ? String(tr.artist) : '').trim();
    const key = keyOf(title, artist);

    // 0.16.66（第 94/95 节）：顺手读一次「这一遍放到哪」。
    // 以前播报只按「这一段听了多久」算，而同一首不切歌的时候那个数字永远不会回到 0 ——
    // 单曲循环第二遍起就彻底静音（94）；它跟实际播放位置也对不上，于是会出现
    // 「歌都放到两分多钟了才念那句 30 秒」的错位（95）。进度读不到就退回旧口径。
    let pt = null;
    let pd = 0;
    let pid = '';
    let pplaying = false;
    if (samplerPort != null) {
      try {
        const p = await readProgress({ cdpPort: samplerPort });
        if (p && p.ok && Number.isFinite(p.t)) pt = Math.max(0, Number(p.t));
        if (p && p.ok && Number.isFinite(p.d) && p.d > 0) pd = Number(p.d);
        // 0.17.46：播放条里的歌曲 id + 在播状态（同一次 CDP 调用带回来的）
        if (p && p.id) pid = String(p.id);
        if (p && typeof p.playing === 'boolean') pplaying = p.playing;
      } catch {
        /* 读不到就当没有，按听歌时长算 */
      }
    }

    const keyChanged = !seg || seg.key !== key;
    // 同一首、进度往回跳 → 又放了一遍（单曲循环重播、或他拖回开头）。这一遍必须重新算。
    const rewound = !!(seg && !keyChanged && pt != null && seg.lastT != null && pt < seg.lastT - REWIND_SEC);

    if (keyChanged || rewound) {
      // 换曲 / 重播 = 新的一遍：世代号 +1（同一首歌重放，gen 也会变）
      playGen += 1;
      // 换曲 / 重放：开一段新的，播报和互动那几个「说过了」标记全部归零
      seg = { title, artist, key, startAt: t, sec: 0, t0: pt, lastT: pt, d: pd, id: (tr && tr.id) || pid || cachedId(title, artist), playing: pplaying, gen: playGen };
      // 本地没有 id 就后台查一次（不阻塞采样；查不到只是这一首没有 id）
      if (!seg.id) {
        const wantKey = seg.key;
        const durationMs = seg.d ? seg.d * 1000 : 0;
        resolveId(title, artist, { durationMs, timeoutMs: 5000 })
          .then((sid) => { if (sid && seg && seg.key === wantKey && !seg.id) seg.id = sid; })
          .catch(() => { /* 查不到不影响记时 */ });
      }
      // 换歌就重算卡①那句 —— 上一首的答案不能拿来给这一首用。
      if (warmer) {
        try { warmer({ title, artist, gen: playGen }); } catch { /* 重算失败不影响记时 */ }
      }
    } else if (seg && pt != null) {
      // 同一遍里接着往前走。t0 是这一遍（这一段）的进度起点，没有就补上。
      if (seg.t0 == null) seg.t0 = pt;
      seg.lastT = pt;
      // 0.17.46：换歌瞬间 id 可能晚一拍才读到，补上；playing 每跳刷新
      if (pid && !seg.id) seg.id = pid;
      seg.playing = pplaying;
    }

    // 暂停期间不累计时长，但段不关 —— 接着播还是同一次
    if (!tr || tr.playing !== true) return;

    await emit(gap / 1000);

    // 播报/互动的闸统一看「这一遍放到哪」：
    //   读得到进度 → 用 pt 减掉这一遍的起点（t0），落在 阈值 ~ 阈值+25 秒 才开口；
    //     段起点本来就已经越过这个阈值（中途接进来 / 重启时这首已在 1:26）→ 这一遍跳过不念，
    //     而不是拖到两分多钟才开口（第 95 节）。
    //   读不到进度 → 退回「听了多久」（老口径），至少不会完全不响。
    const bandBase = seg && Number.isFinite(seg.t0) ? seg.t0 : 0;
    const inBand = (snapSec) => {
      if (pt != null) {
        if (bandBase > snapSec) return false;
        const pos = pt - bandBase;
        return pos >= snapSec && pos <= snapSec + GATE_WIN_SEC;
      }
      return seg ? seg.sec >= snapSec : false;
    };

    // 这一遍放到 30 秒处说一句：先挂个「待说」，4 秒后再确认一次还在放同一首才真说。
    // 不马上说是因为切歌常常就发生在这一刻，提前开口会变成给上一首送别。
    if (announcer && seg && !seg.said && !seg.checking && inBand(SAY_AFTER_SEC)) {
      seg.checking = true;
      const snap = { key: seg.key, title: seg.title, artist: seg.artist, gen: seg.gen || playGen };
      setTimeout(() => void confirmSay(snap), CONFIRM_MS);
    }

    // 这一遍放到一分钟说喜不喜欢（卡②）。
    // 不到一分钟就切走 → 进度到不了 60 那一带，这句自然就不读了。
    if (likeSayer && seg && !seg.liked && !seg.likeChecking && inBand(LIKE_AFTER_SEC)) {
      seg.likeChecking = true;
      const snap2 = { key: seg.key, title: seg.title, artist: seg.artist, gen: seg.gen || playGen };
      setTimeout(() => void confirmLike(snap2), CONFIRM_MS);
    }

    // 这一遍放到一分半念评论（卡③）。
    // 不到一分半就切走 → 够不到 90，这条自然就不念了。
    if (commentSayer && seg && !seg.commentSaid && !seg.commentChecking && inBand(COMMENT_AFTER_SEC)) {
      seg.commentChecking = true;
      const snap3 = { key: seg.key, title: seg.title, artist: seg.artist, gen: seg.gen || playGen };
      setTimeout(() => void confirmComment(snap3), CONFIRM_MS);
    }

    // 接力点歌：听满 10 秒后每 12 秒问一次外部闸（world 里判断「是不是她给的歌」，
    // 是的话再去读播放进度 —— 读进度要起一次子进程，所以先在 gate 里挡掉大部分调用）。
    if (chainGate && seg && seg.sec >= CHAIN_AFTER_SEC) {
      if (t - (seg.chainAt || 0) >= CHAIN_GATE_MS) {
        seg.chainAt = t;
        const snap4 = { title: seg.title, artist: seg.artist, id: seg.id || '', playing: pplaying || live, sec: seg.sec };
        Promise.resolve()
          .then(() => chainGate(snap4))
          .catch(() => { /* 接力出错不影响记时 */ });
      }
    }

    // 超长一首（>5 分钟）：听满 5 分钟就切一段，只为统计上算成第二次收听。
    // 0.16.66：播报/互动的标记跟着段一起带过去 —— 不能因为切段就把三句全重新念一遍；
    // 进度基准 t0 也保持不变，新段里的 pos 继续往前算。
    if (seg && seg.sec >= SEG_MAX_SEC) {
      seg = {
        ...seg,
        startAt: t,
        sec: 0,
      };
    }
  } catch (e) {
    /* 0.17.53：采样器出错不能让整条链静默断掉 —— 记一条现场，下一跳继续。
       教训：B3 换变量时漏了一处 `now`，每跳都抛 ReferenceError，
       结果听歌流水不写、接力闸不进，面板看起来像"没判切歌"。 */
    try { external('listening', 'tick', { ok: false, error: String((e && e.message) || e).slice(0, 300) }); } catch { /* 日志失败不影响下一跳 */ }
  } finally {
    flushing = false;
    schedule();
  }
}

/** 4 秒后确认：还在放同一首才说喜不喜欢。切走了就静默放弃，这一首不再提。 */
async function confirmLike(snap) {
  if (!likeSayer) return;
  let now = null;
  try {
    now = await currentTrack({ cdpPort: samplerPort, fresh: true });
  } catch {
    now = null;
  }
  if (!now || now.playing !== true) return;
  const k = keyOf(String(now.title || '').trim(), String(now.artist || '').trim());
  if (k !== snap.key) return;
  // 同一首歌重放也算新的一遍：旧那一遍的确认不能拿去说新一遍
  if (snap.gen != null && Number(snap.gen) !== playGen) return;
  if (!seg || seg.key !== snap.key) return;
  seg.liked = true;
  try {
    await likeSayer({ title: snap.title, artist: snap.artist, gen: snap.gen });
  } catch {
    /* 说失败不影响记时 */
  }
}

async function confirmSay(snap) {
  if (!announcer) return;
  let now = null;
  try {
    now = await currentTrack({ cdpPort: samplerPort, fresh: true });
  } catch {
    now = null;
  }
  if (!now || now.playing !== true) return;
  const k = keyOf(String(now.title || '').trim(), String(now.artist || '').trim());
  if (k !== snap.key) return;
  // 同一首歌重放也算新的一遍
  if (snap.gen != null && Number(snap.gen) !== playGen) return;
  // 段被换掉了（换曲 / 单曲循环开了新段），这句话就没意义了
  if (!seg || seg.key !== snap.key) return;
  seg.said = true;
  try {
    await announcer({ title: snap.title, artist: snap.artist, gen: snap.gen });
  } catch {
    /* 说失败不影响记时 */
  }
}

/** 4 秒后确认：还在放同一首才念评论。切走了就这条不念了。 */
async function confirmComment(snap) {
  if (!commentSayer) return;
  let now = null;
  try {
    now = await currentTrack({ cdpPort: samplerPort, fresh: true });
  } catch {
    now = null;
  }
  if (!now || now.playing !== true) return;
  const k = keyOf(String(now.title || '').trim(), String(now.artist || '').trim());
  if (k !== snap.key) return;
  // 同一首歌重放也算新的一遍
  if (snap.gen != null && Number(snap.gen) !== playGen) return;
  if (!seg || seg.key !== snap.key) return;
  seg.commentSaid = true;
  try {
    await commentSayer({ title: snap.title, artist: snap.artist, gen: snap.gen });
  } catch {
    /* 说失败不影响记时 */
  }
}

function schedule() {
  if (timer === null) return;
  timer = setTimeout(() => void tick(), misses >= 3 ? IDLE_MS : SAMPLE_MS);
}

/** 起采样器（幂等）。World 启动时调。opts.cdpPort = 读播放进度用的 CDP 端口（第 94/95 节）。 */
/**
 * 0.17.45（C2）：端口热更。
 * 采样器只在 `startSampler()` 那一刻收一次端口，以前改设置里的 `cdpPort` 要重启才生效 ——
 * 三张卡的到点判断、接力读进度就一直打在旧端口上。这里只换变量，下一次 tick 就用新端口。
 */
export function setSamplerPort(port) {
  const n = Number(port);
  samplerPort = Number.isFinite(n) && n > 0 ? n : null;
  return samplerPort;
}

export function startSampler(opts = {}) {
  if (opts && opts.cdpPort != null) samplerPort = Number(opts.cdpPort) || null;
  if (timer !== null) return;
  restoreIdleAnchor();
  /* 0.16.43（用户实测根因）：重启后第一次开口的「一分钟」必须从**世界启动那一刻**算。
     以前第一次 tick 要等 SAMPLE_MS（10 秒），而探针本身还要一两秒 —— 计时起点被推后十几秒，
     再加上生成那句 + TTS，「设 1 分钟」实际要 1 分 40 秒才出声（data/idle.json 里 `idleSec: 82` 就是这么来的）。
     现在：启动即记安静起点，并且 300 毫秒后就采样一次（真在放歌会立刻把起点清掉，不影响正常判定）。 */
  if (idleSince == null) idleSince = Date.now();
  timer = setTimeout(() => void tick(), 300);
}

/** 停采样器。增量已经实时落盘，这里不用补写。 */
export async function stopSampler() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  seg = null;
  lastTickAt = 0;
  misses = 0;
  idleSince = null;
  idleAskedAt = 0;
}

/**
 * 读听歌流水并汇总。
 * 同一段（at 相同）的多行合并成一条：时长相加，算一次收听。
 * 听满 MIN_SEC 才算一次，不够的那段既不计次数也不计时长（切歌一闪而过的噪音）。
 */
/**
 * 0.17.43（B7）：5 秒内存缓存。
 * 「点歌排名」页每 5 秒轮询一次，每次都把 `listening.jsonl`（700+KB）整份解析一遍 ——
 * 纯读、不调模型，但很吃 CPU。5 秒内复用同一份结果；采样器写盘后最多晚 5 秒看到，
 * 面板本来就是 5 秒刷一次，感知不到。
 */
let listensCache = { at: 0, data: null };

export async function readListens() {
  if (listensCache.data && Date.now() - listensCache.at < 5000) return listensCache.data;
  const data = await readListensRaw();
  listensCache = { at: Date.now(), data };
  return data;
}

async function readListensRaw() {
  let text = '';
  try {
    text = await readFile(FILE, 'utf8');
  } catch {
    return { ok: true, exists: false, items: [], totalListens: 0, totalSec: 0, rawSegments: 0 };
  }

  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (!r || !r.t) continue;
      rows.push({
        title: String(r.t),
        artist: String(r.a || ''),
        id: String(r.id || ''),
        at: String(r.at || ''),
        sec: Number(r.sec) || 0,
      });
    } catch {
      /* 半行 / 坏行跳过 */
    }
  }

  // 同一段合并
  const segMap = new Map();
  for (const it of rows) {
    const k = `${keyOf(it.title, it.artist)}#${it.at}`;
    const cell = segMap.get(k);
    if (cell) {
      cell.sec += it.sec;
      // 同一段里越靠后的行越可能已经查到 id（段刚开时可能还没查到）
      if (!cell.id && it.id) cell.id = it.id;
    } else segMap.set(k, { title: it.title, artist: it.artist, id: it.id, at: it.at, sec: it.sec });
  }

  // 按曲目汇总，只收听过瘾的段
  const bySong = new Map();
  let totalListens = 0;
  let totalSec = 0;
  for (const s of segMap.values()) {
    if (s.sec < MIN_SEC) continue;
    totalListens += 1;
    totalSec += s.sec;
    const k = keyOf(s.title, s.artist);
    const cell = bySong.get(k);
    if (cell) {
      cell.listens += 1;
      cell.sec += s.sec;
      if (!cell.id && s.id) cell.id = s.id;
      if (s.at > cell.lastAt) cell.lastAt = s.at;
    } else {
      bySong.set(k, { title: s.title, artist: s.artist, id: s.id || '', listens: 1, sec: s.sec, lastAt: s.at });
    }
  }

  const out = [...bySong.values()].sort((a, b) => b.listens - a.listens || b.sec - a.sec);
  return {
    ok: true,
    exists: true,
    items: out,
    totalListens,
    totalSec,
    rawSegments: segMap.size,
  };
}

export const PATHS = { FILE, MIN_SEC, SAMPLE_MS, SEG_MAX_SEC };
