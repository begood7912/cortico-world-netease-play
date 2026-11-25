/**
 * 接力点歌（一首接一首）—— 0.16.58 重构。
 *
 * 用户这一轮的口径（逐条）：
 *   ① 接力点歌要单独一张设置卡（设置页那摊，不在这里）；
 *   ② 取消写死的「最多 6 首」，面板也不再显示 /6；
 *   ③ **只有「她推给他、他接受了」这条路才准接** —— 他自己叫她放歌、程序自动放的，一律不接；
 *   ④ 递出一首之后要**立刻刷新推荐**，再从新推荐里读下一首（第一次点的时候不刷新）；
 *   ⑤ 推荐刷新挂上去的「下一首」**不能冒充「接力进行中」** —— 原来 `syncOffer` 写
 *      `base:null / count:1 / offeredBaseKey:""`，把「同一首不放完不重复递」这道闸彻底放开，
 *      结果用户自己点的歌只要撞上推荐那首，她就当成「他接了我推的」立刻接话（用户实听发现的 bug）。
 *
 * 所以这里把两种「下一首」分开存：
 *   offer    = **接力真正递出去的那一首**（她开口报过「下一首播放《X》」，等你/等它放完）
 *   preview  = **推荐刷新后挂在面板上的那首**（只是显示，不代表这一轮在接力）
 * `syncOffer()` 从此只碰 preview，绝不动 base / count / offeredBaseKey。
 *
 * 来源标记（`origin`，配合 `base`）—— 这是「谁能触发接力」的唯一依据（0.16.65 口径）：
 *   'her-offer'  从 1 号窗口（此刻页 `now`，推荐那一页）点的歌 / 答应了她「放吧」→ 准接
 *   'user-ask'   他自己叫她放歌（「放几首歌」）、或从别的页（点歌排名）随手点的 → 不准接
 *   ''           没有标记（他在客户端自己点的、或已经是上一轮的了）→ 不准接
 *
 * 0.16.65：起点靠「从哪一页点的」，不靠歌名反查。点下去那一刻还会挂一个 `pending`
 * （「等他点的这首真的落到播放条上」），这期间接力闸只返回 `arming`、什么都不清；
 * 观测到播放条换成那首就算落地，之后才按 base 盯进度、换歌才作废 —— 起点和终点各用一套判据。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { state } from './store.js';
import { event } from './log.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AHEAD_SEC, SAY_AHEAD_SEC, VERIFY_WAIT_MS, PROMISE_TTL_MS } from './constants.js';

// 这四个数已搬到 constants.js（与 SAMPLE_MS 并排），这里再导出一次，保持旧调用点不变。
export { AHEAD_SEC, SAY_AHEAD_SEC, VERIFY_WAIT_MS, PROMISE_TTL_MS };

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = state('chain.json');

/**
 * 剩这么多秒就递下一首。
 * 用户 0.0.1.6.11 的口径：不要提前 35 秒，贴到剩 5 秒。
 * 第 117 节（用户口径「提前 5 秒切、不等歌放完就切，就能偷懒绕过这个坑」）：
 * **5 → 10**。理由不是「更早更好听」，是 5 秒在这个采样节奏下根本抓不住：
 *   · 采样每 3 秒问一次闸（listening.js 的 CHAIN_GATE_MS），5 秒的窗口只有 1~2 次机会，
 *     一次 `no-progress` / 一次 TTS 阻塞就能整段跳过；
 *   · 一次快路径实测 1.9~2.2 秒，5 秒窗口里只剩 2.8 秒余量，几乎零容错。
 * 10 秒的窗口有 3~4 次机会，且放歌一定落在「这首还在放」的时候 ——
 * 不会撞上「这首自己放完了、客户端自动跳下一首」那一刻（那一跳会被判成「他切走了」，
 * 已经播报好的候选一起被清掉，第 117 节现场就是死在这里）。
 * 代价是每首的结尾会被掐掉约 10 秒，这是用户明确接受的。
 */

/**
 * 提前多少秒「播报下一首」。
 *
 * 第 112 节：原来播报和切歌挤在同一刻（都在剩 5 秒），而 TTS 合成 + 播放本身要 2~4 秒 ——
 * 话还没说完歌就放完了。所以拆成两段：先播报，再切歌。
 *
 * 第 117 节：切歌点从 5 秒提到 10 秒（采样 3 秒一次，5 秒窗口抓不住）。
 *
 * 第 124 节（用户口径）：「这句歌曲放满前 30 秒之内挑一首歌，然后送播报。」
 * 播报窗口 **20 → 30 秒**。这样即使某一轮采样迟到、或者他手动拖了进度条，
 * 也有整整 20 秒（30~10）可以挑歌 + 播报，不用贴着结尾赶。
 *   剩 SAY_AHEAD_SEC（30 秒）→ 先挑好下一首 + 播报「下一首《X》」
 *   剩 AHEAD_SEC（10 秒）    → 直接放已经挑好的那首，不再挑、不再播
 */

/**
 * 他点了歌之后的宽限期（毫秒）。
 * 0.16.64：点歌那一趟快路径 1.4 秒、慢路径 5~10 秒，这期间客户端播放条上还是上一首。
 * 接力闸如果在这几秒里拿旧标题去比 base，就会判成 not-hers 并把整轮状态清掉 ——
 * 一次误清之后 origin 变空，后面每次都 no-origin，接力再也接不上（用户实测的现场就是这样）。
 * 15 秒覆盖慢路径还留余量；过了这段时间还是不符，那才是真的换歌了。
 */
export const BASE_WARM_MS = 15 * 1000;
/**
 * 「装填中」最多等多久（毫秒）。
 * 0.16.65：点歌到播放条真的换过来，快路径 1.4 秒、慢路径 5~10 秒；机器卡一下可能更久。
 * 等不到就放掉这一轮 —— 不能让一个 pending 一直挂着把接力闸卡死。
 */
export const ARM_GIVEUP_MS = 60 * 1000;
/**
 * 递歌失败后隔多久再试一次（毫秒），以及最多试几次（第 93 节）。
 * 以前失败了就写个 `fail` 收工，下一次要等这一首放完 —— 而这首根本没被换掉，
 * 等的其实是它的剩余时间（最长能空四到五分钟，用户看到的就是「接力断了」）。
 * 现在：20 秒后重试，一首最多试 3 次，还不成就放掉，别刷个没完。
 */
export const CHAIN_RETRY_MS = 20 * 1000;
export const CHAIN_RETRY_MAX = 3;

/**
 * 0.16.86（第 134 节 A1/A2，用户口径，已验证可行）：
 * 刚递完一首，等这么久再核对「现在放的是不是它」。
 * 这 30 秒里既不判切歌、也不递歌 —— 起点是 `playSong` 返回 ok 的那一刻，不是播报那一下。
 */

/**
 * 第 146 节（用户口径，11-24）：「以播报为准，确定了播报内容，接力点歌就不再更换了，
 * 播报和接力记作一个事件。」
 *
 * 播报出口那一刻（`next.said = true`）那首歌就定死：不再重挑、不再作废、不再判「他换歌」；
 * 这首自然放完 / 客户端自己接下一首 / 他手动换掉，一律当成「该投了」，直接把这一首放出来。
 * 这个时长只是兜底上限（中途暂停、拖进度条会拖很久），5 分钟内一直有效，超了才作废重挑。
 */

const TTL_MS = 90 * 60 * 1000;
const PREVIEW_STALE_MS = 20 * 60 * 1000;

/**
 * 歌名归一化 —— 比「同一首」时用。
 *
 * 0.16.63 修的是这里：原来只 `trim().toLowerCase()`，而客户端播放条的标题常带后缀
 * （「好想好想（电视剧《情深深雨濛濛》片尾曲）」），`chain.base` 里存的却是干净歌名，
 * 两个一比你永远不相等 → `chainGate` 判成 `not-hers` → `clearChain()` 把 origin/base 全清掉，
 * 于是后面每次都 `no-origin`，接力一首也接不上。用户实测就是这么没的。
 *
 * 现在把括号里的内容（中英文圆括号、方括号、书名号、尖括号）整段丢掉，
 * 再去掉所有空白；清理后如果什么都不剩，退回原文（有些歌名本来就整段在括号里）。
 */
/**
 * 括号里的内容整段丢掉。
 * 开括号只认 （ ( 【 [；《》**不算闭合符** —— 它们常常嵌在「（电视剧《…》片尾曲）」里面，
 * 早先把 `》` 当闭合符，结果只吃到「（电视剧《…》」，留下半个「片尾曲）」。
 */
const DROP_BRACKETS = /[（(【\[][^）)】\]]*[）)】\]]/g;
const norm = (s) => {
  const t = String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return '';
  const c = t.replace(DROP_BRACKETS, '');
  return c || t;
};

/**
 * 两个歌名是不是同一首。
 * 先归一化，再允许「一方包含另一方」——
 * 播放条上常把歌手一起拼进来（「好想好想古巨基」），只靠相等会漏。
 */
export function sameKey(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
/**
 * 0.17.46：判断「是不是同一首」—— **优先按歌曲 id**，两边都没有 id 才退回名字。
 *
 * 为什么：名字判断只能靠 `sameKey` 去括号 + 包含匹配，翻唱/同名/Live/播放条拼歌手
 * 都可能猜错；而播放条里就带着 `s_cid`（实测与搜索接口一致）。id 是权威值。
 * 兼容：老 `chain.json` 里没 id，这里自动退回名字，不会崩。
 */
export function sameTrack(nameA, idA, nameB, idB) {
  const a = String(idA || '').trim();
  const b = String(idB || '').trim();
  if (a && b) return a === b;
  return sameKey(nameA, nameB);
}

/**
 * 接力闸的判定 —— 纯函数，方便自测（原来埋在 world.js 里，出了问题只能靠猜）。
 * 返回空串 = 这一轮可以接；否则是拒绝原因，含义和原来一致：
 *   'no-origin'  这一轮没起点（用户没点过歌）
 *   'user-ask'   他自己叫她放的，不许顺着接
 *   'warming'    刚点完歌、客户端还没切过来（**不清状态**，等下一轮采样）
 *   'not-hers'   真的换了歌 / 不是她推的那首（调用方要 clearChain）
 *   'offered'    这首已经递过、还没放完，不重复递
 */
export function gateVerdict(st, playingName, now = Date.now(), playingId = '') {
  if (!st || !st.origin) return 'no-origin';
  if (st.origin !== 'her-offer') return 'user-ask';
  // 还在装填（等他点的那首落下来）→ 什么都不判，也不清
  if (st.pending && !sameTrack(st.pending.name, st.pending.id, playingName, playingId)) {
    return now - Number(st.pending.at || 0) >= ARM_GIVEUP_MS ? 'arming-giveup' : 'arming';
  }
  const base = st.base && st.base.name;
  if (!base || !norm(base)) return 'not-hers';
  if (!sameTrack(base, st.base.id, playingName, playingId)) {
    if (now - Number(st.baseAt || 0) < BASE_WARM_MS) return 'warming';
    return 'not-hers';
  }
  if (st.offeredBaseKey && sameTrack(st.offeredBaseKey, st.offeredBaseId, playingName, playingId)) return 'offered';
  return '';
}

let cache = null;

function readRaw() {
  if (cache) return cache;
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    cache = j && typeof j === 'object' ? j : {};
  } catch {
    cache = {};
  }
  return cache;
}

function writeRaw(obj) {
  cache = obj;
  try {
    writeFileSync(FILE, JSON.stringify(obj), 'utf8');
  } catch { /* 写不了不影响这一轮，下次再试 */ }
}

const blank = () => ({
  at: Date.now(), origin: '', base: null, count: 0, offer: null, offeredBaseKey: '', offeredBaseId: '',
  // 0.17.33：这一轮是从哪张卡起手的（'reco' 卡① / 'wx' 卡片5），只用于播报那句垫什么，
  // 挑歌来源仍看设置里的 chainSource（用户口径：自动接力按开关走）。
  src: '',
  // 0.16.64：`baseAt` 只在 markOrigin 那一刻写，同步推荐（syncOffer）不会碰它。
  // chainGate 用它判断「他刚点完歌多久」—— 刚点完那几秒客户端还没切过来，
  // 播放条上还是上一首，这时候绝不能判成 not-hers 把整轮清掉。
  baseAt: 0,
  preview: null, previewAt: 0, armed: null, dailyKey: '',
  // 0.16.65：等他点的这首真的落到播放条上（见 markOrigin）。null = 已经落地或没在等
  pending: null,
  // 0.16.67（第 99 节）：上一次采样看到播放条上是哪首 —— 「切歌」就是拿它和这一次比。
  // 0.17.46：同时记 id；能按 id 比就不再靠名字猜。
  lastSeen: '', lastSeenId: '',
  // 0.16.67（第 99 节）：这一轮已经收场 { reason, at }。收过就不再挑歌、不再写盘。
  closed: null,
  // 第 112 节：提前挑好的下一首 { name, artist, id, said }。
  // said=true 表示「下一首《X》」已经播报过 —— 播报窗口 20 秒里每 3 秒采样都会进来，
  // 靠这个字段保证只挑一次、只播一次；切歌那一刻直接拿它去放。
  next: null,
  nextAt: 0,
  // 第 128 节（用户口径）：「换一批」点下去以后先显示「正在为你挑选歌曲中…」，
  // 等 10 秒再真正随机挑一首。这个字段是「到几点之前先别挑」。
  pickWaitUntil: 0,
  // 0.16.86（第 134 节 A1/A2）：刚递完一首的核对窗口 { name, artist, at }。
  // 窗口内不判切歌、不递歌；到点拿播放条上的歌和 name 比一次，再决定接力要不要继续。
  // 0.17.18（A+B）：他刚开口点歌的那一刻就写一个时间戳。
  // `beginUserTakeover()` 立即落这个戳，接力闸见到它就整轮短路，
  // 不必等 `playSongs` 跑完（快路径 1.4 秒、慢路径 5~10 秒，这段正是承诺抢跑的窗口）。
  userAskAt: 0,
});

/** 90 分钟内有效的那条接力状态，没有返回 null。 */
export function peekChain() {
  const c = readRaw();
  if (!c || !c.at) return null;
  if (Date.now() - Number(c.at) > TTL_MS) return null;
  return c;
}

/**
 * 合并写（patch）。以前是整个覆盖，任何一个分支写一次就把别的字段抹掉，
 * 现在是「只改我关心的那几个」。
 */
export function saveChain(patch = {}) {
  const cur = readRaw() || {};
  const next = { ...blank(), ...cur, at: Date.now(), ...patch };
  // 显式传 null 的字段保留 null（比如清掉 offer），只有 undefined 才回落到旧值
  for (const k of Object.keys(patch)) if (patch[k] === undefined) next[k] = cur[k];
  writeRaw(next);
  return next;
}

/**
 * 收掉「接力这一轮」的状态：用户点了别的歌、或者一轮到头。
 *
 * 0.16.67（第 97 节）：不再 `writeRaw({})` 整份倒空。
 * 以前那一版会把 `dailyKey`（「今天已清空歌单」的章）和 `preview`（面板上的下一首预告）
 * 一起抹掉 —— 章一丢，下一次接力又判「今天没清」，于是同一张歌单一天被清好几次；
 * 再叠上第 99 节的 `lastSeen` / `closed`，这里只清「这一轮」的东西，别碰全局的。
 */
export function clearChain() {
  const c = readRaw() || {};
  const keep = {
    dailyKey: c.dailyKey,        // 老格式兼容（清零记账已搬到 data\reco-clear.json）
    preview: c.preview,          // 面板「下一首播放《X》」预告不能用一次清空就没
    previewAt: c.previewAt,
    lastSeen: c.lastSeen,
    closed: c.closed,
  };
  writeRaw({ ...blank(), ...keep });
}

/**
 * 这一轮到此为止（第 99 节）：切歌 / 装填被切走 / 不是她的歌 —— 只收一次。
 *
 * 和 `clearChain()` 的区别：本函数**保留 `origin` / `base`**（他要是切回她那首，
 * 还能接着往下接），只把 `closed` 标上；`chainGate` 一进来看到 `closed` 就直接返回，
 * 不再每 12 秒重判一次、也不再写盘。
 */
export function markClosed(reason) {
  logChainEvent({ ev: 'closed', reason: String(reason || '') });
  return saveChain({ closed: { reason: String(reason || ''), at: Date.now() } });
}

/**
 * 0.17.39（用户口径）：换了「接力按哪张卡挑」→ 旧来源的承诺和预告一律作废。
 *
 * 为什么必须清：
 *   - `next` 是**上一来源**挑好、甚至已经播报出去的那首；跨来源继续投递等于
 *     「播报按天气念的，放出来的却是历史推荐那首」；
 *   - `preview` 是面板上「我挑中了《X》」的来源，不清就会挂一首新来源根本不会放的歌。
 *
 * 只清这四个字段，不动 origin/base：如果他此刻正在听她推的那首，这一轮还能接着跑。
 * 已经播报过（`next.said`）的则收场 —— 承诺不能跨来源生效。
 */
export function clearSourceState() {
  const st = peekChain();
  if (!st) return null;                       // 没有活着的这一轮，什么都不用清
  const promised = !!(st.next && st.next.name && st.next.said);
  saveChain({
    next: null,
    nextAt: 0,
    offer: null,
    offeredBaseKey: '',
    preview: null,
    previewAt: 0,
  });
  if (promised) markClosed('source-changed');
  logChainEvent({ ev: 'source-changed', base: (st.base && st.base.name) || '', promised });
  return peekChain();
}

/**
 * 第 146 节：接力事件日志 —— 现在统一写 `data\log\events.jsonl`（0.16.97 起）。
 * （旧文件 `data\chain-events.jsonl` 已冻结，只作历史留档，别再往里写。）
 *
 * 用户口径「播报和接力记作一个事件」：一次播报会有 `announced` → `deliver` → `delivered`/`fail`，
 * 或者 `announced` 之后紧跟 `switch-after-announce`（播报过、歌被换掉 → 直接投）。
 * 0.16.92 那次「《异乡人》播报了却没放上」，只看 `chain.json` 根本看不出来，只能靠这几行还原。
 */
export function logChainEvent(evt = {}) {
  // 0.16.97：改由 log.js 统一写（data/log/events.jsonl，信封 {at,type,…}）。
  // 原来调用点全是 `{ev:'announced',…}`，这里翻成 type 'chain.announced'，调用点一行没改。
  const { ev, ...fields } = evt;
  event(`chain.${ev || 'note'}`, fields);
}

/**
 * 第 129 节（用户口径）：「重启以后接力点歌显示的是上一次的情况，上一次没清零。」
 *
 * 所以每次启动先把上一轮的接力状态整个收干净：
 *   base / count / offer / preview / next / lastSeen / pending 全部清掉，
 *   面板上「我挑中了《X》」「已经接下第 N 首」一律不显示 ——
 *   等他真的从 1 号窗口点一首歌，`markOrigin()` 才开新一轮（那边会把 `closed` 清掉）。
 *
 * 标一个 `closed: {reason:'startup'}` 是故意的：`chainGate` 一进来就早返回，
 * 等于「默认已暂停」——不做任何挑歌、不播报、不写盘。
 *
 * **刻意不出声**：用户明确说过「自动切歌已暂停」这句他没有要求加，所以这里不写面板提示、
 * 更不调用 `speak()`。
 */
export function resetChainOnStartup() {
  const c = readRaw() || {};
  const keep = {
    // 「今天清空过歌单」的章不能因为重启重来一次
    dailyKey: c.dailyKey,
  };
  return writeRaw({ ...blank(), ...keep, closed: { reason: 'startup', at: Date.now() } });
}

/**
 * 第 131 节 + 第 133 节（用户口径）：接力点歌那块**先判断「在不在运行」，再做三态投影**。
 *
 * 用户 133 原话：「首先这个判断要在最前 —— 软件启动以后，卡片开始读取的时候，
 * 首先就要判断现在接力点歌的情况。接力点歌如果没有在运行，就要显示『接力点歌已停止』；
 * 如果在运行，才会出现『正在为你挑选歌曲中』和『我挑中了什么什么』这两种形式。」
 *
 * 所以第一层就是 `active`：这一轮接力到底在不在跑。
 *
 *   active = origin 是 her-offer（从 1 号窗口点的她那条线）+ 有 base + 没被收场（closed 为空）
 *
 * 不在跑 → 一律 `stopped`（「接力点歌已停止」）。
 * 这也顺带把「重启后显示什么」定死了：启动清零写了 `closed: startup`，
 * 于是 active=false → 面板乖乖显示「接力点歌已停止」，不会再去猜。
 *
 * 在跑 → 才细分成：
 *   picking → 「正在为你挑选歌曲中…」   （刚点了换一批，那 10 秒里）
 *   picked  → 「我挑中了《X》」          （已经挑出来一首：接力真递的，或推荐预告）
 *
 * 判定顺序固定：**没在跑 > 正在挑 > 挑出来了**。谁在前谁说话，不会两头抢
 * （前一版让前端拿一堆字段自己拼条件，拼错过两次：v99 没显示「挑选中」、
 * 手动切歌没显示「已停止」）。
 */
export function chainStateOf({ chain, offer, waitMs, now } = {}) {
  const st = chain || {};
  const base = st.base && st.base.name ? String(st.base.name) : '';
  // ① 第一层：在不在跑
  const active = String(st.origin || '') === 'her-offer' && !!base && !st.closed;
  if (!active) return { kind: 'stopped' };
  // ② 在跑，且已经挑出来一首 → 「我挑中了《X》」。
  //    **这一层必须排在「正在挑」前面**（0.16.86，第 132 节 A7）：剩 30 秒时点「换一批」，
  //    冷却期一进来就显示「正在挑选中」，会把刚刚已经报过的那首盖住；他要看的是已经挑中的那首，
  //    等真换了一批、`setPickWait` 把 preview 清掉之后，才回到「挑选中」。
  const of = offer;
  if (of && of.name) {
    return {
      kind: 'picked',
      name: String(of.name),
      count: Number(st.count) || 0,
      idle: of.kind === 'preview',
      origin: String(st.origin || ''),
      baseName: base,
    };
  }
  // ③ 在跑，且刚点了「换一批」→ 这 10 秒里只显示挑选中
  if (Number(waitMs) > 0) return { kind: 'picking' };
  // ④ 在跑，但还没挑出东西（刚点歌、离结尾还远）→ 这块先不占地方
  return { kind: '' };
}

/**
 * 第 128 节：「换一批」点下去以后，先别挑。
 *
 * 用户口径：「点了以后先显示『正在为你挑选歌曲中』，等 10 秒以后再挑中什么什么歌曲。」
 * 所以这里只写一个「到几点之前先别挑」的截止时间，顺手把旧预告清掉 ——
 * 不清的话面板会挂着上一批的第一首，看着像已经挑好了。
 */
export function setPickWait(ms) {
  const until = Date.now() + Math.max(0, Number(ms) || 0);
  return saveChain({ pickWaitUntil: until, preview: null, previewAt: 0 });
}

/** 还差多少毫秒才允许挑（0 = 现在就可以挑）。 */
export function pickWaitLeft() {
  const c = readRaw() || {};
  const until = Number(c.pickWaitUntil || 0);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

/**
 * 标记「这一轮是从哪首歌、什么来源开始的」。
 * 只有 origin === 'her-offer' 的才允许接力。
 *
 * 0.16.65：her-offer 时同时写一个 `pending`（「等他点的这首真的落到播放条上」）。
 * 起点不再靠歌名反推 —— 从哪一页点的就算哪一套，见 src\panel.js 的 playTrack()。
 * pending 到 base 之间这段叫「装填中」，接力闸只会返回 arming，绝不清状态。
 */
export function markOrigin(origin, song, src) {
  const o = String(origin || '');
  if (!o) return saveChain({ origin: '', base: null, count: 0, offer: null, offeredBaseKey: '', armed: null, baseAt: 0, pending: null, closed: null, lastSeen: '', next: null, nextAt: 0, userAskAt: 0, src: '' });
  const nm = song && song.name ? String(song.name) : '';
  return saveChain({
    origin: o,
    src: String(src === 'wx' ? 'wx' : src === 'reco' ? 'reco' : ''),
    base: nm ? { name: nm, artist: String(song.artist || ''), id: String(song.id || '') } : null,
    count: 0,
    offer: null,
    offeredBaseKey: '',
    // 0.16.66：换一轮就把上一轮留下的失败记录清掉 —— 否则 `fail.count` 会一直带着，
    // 前一首都失败三次了，新的一首刚点上来就直接判「不再重试」。
    fail: null,
    // 0.16.67（第 99 节）：新的一轮开张 —— 上一轮「切歌收场」的标记清掉，
    // 否则刚点完歌就被上一条 closed 挡住。
    // 注意 `lastSeen` 这里**不动**：它记的是「上一次采样播放条上是哪首」，
    // 点歌那一刻播放条上还是上一首，这时候写新歌名会让第一次采样就误判成一次切歌。
    closed: null,
    // 记下「他这一刻点了这首」—— 之后几秒客户端还没切过来，接力闸靠它别误清
    baseAt: Date.now(),
    // 只有她这条线要等落地；他自己叫她放的不接力，不用挂 pending
    pending: o === 'her-offer' && nm ? { name: nm, artist: String(song.artist || ''), id: String(song.id || ''), at: Date.now() } : null,
    armed: null,
    // 第 112 节：新一轮开张 —— 上一轮提前挑好的那首一定作废（否则会在别人的歌上放它）
    next: null,
    nextAt: 0,
    // 0.16.86：上一轮「刚递完、还在核对」的窗口也一起清掉
    verify: null,
    // 新一轮是她这条线 → 撤掉用户点歌的抢占戳，别让它把接力挡 30 秒
    userAskAt: o === 'her-offer' ? 0 : Date.now(),
  });
}

/**
 * 0.17.18（方案 A）：**他开口点歌的那一刻**就把这一轮接力掐掉，不等 `playSongs` 返回。
 *
 * 现场（11-24 08:11）：他在聊天里叫《被遗忘的时光》，`netease_play` 走慢路径要 5~10 秒；
 * 这期间上一轮 `her-offer` 还带着「已播报」的承诺，结果 08:11:23 先把她推的《在你的身边》投了出去，
 * 08:11:48 才把 `user-ask` 写上 —— 晚了 25 秒，听着就是「我点了歌，接力还在接」。
 *
 * 所以这里只做一件事：立刻写 `origin: user-ask` + `closed: user-ask`，清掉 `next`。
 * 闸一进来看到 `closed` 就早返回，承诺的投递权当场作废。
 * 等 `playSongs` 成功后再照旧 `markOrigin('user-ask', 第一首)`，那一轮才有 base。
 */
export function beginUserTakeover() {
  logChainEvent({ ev: 'user-takeover' });
  return saveChain({
    origin: 'user-ask',
    base: null,
    count: 0,
    offer: null,
    offeredBaseKey: '',
    armed: null,
    pending: null,
    next: null,
    nextAt: 0,
    verify: null,
    fail: null,
    closed: { reason: 'user-ask', at: Date.now() },
    userAskAt: Date.now(),
  });
}

/**
 * 0.17.19：这一声「即将播放《X》」还该不该出口 —— 直接复用接力自己的状态判断。
 * 面板那块用 `chainStateOf()` 判「在跑 / 停止」，播报这里也用同一份判据，不另立一套：
 *   · `chainStateOf` 判成 stopped（没起点、已收场、启动清零）→ 不念；
 *   · 来源不是 her-offer → 不念；
 *   · 要念的那首跟当前登记的 `next` 对不上（已经被换掉/撤掉）→ 不念。
 */
export function chainSpeakAllowed(st, name) {
  if (!st) return false;
  const s = String(name || '').trim();
  const stt = chainStateOf({ chain: st, offer: st.offer, waitMs: pickWaitLeft() });
  if (stt.kind === 'stopped') return false;
  if (String(st.origin || '') !== 'her-offer') return false;
  if (st.closed) return false;
  if (st.next && st.next.name && s && !sameKey(st.next.name, s)) return false;
  return true;
}

/**
 * 0.17.18（方案 B）：用户点歌请求还在飞的时候，任何「播报即承诺」都不许生效。
 * 这是 A 的保险：万一 `beginUserTakeover()` 没跑到（旧状态、异常路径），
 * 只要这个戳还热着，闸也不会把承诺的那首投出去盖掉他点的歌。
 */
export const USER_ASK_HOLD_MS = 30 * 1000;
export function userRequestHold(st, now = Date.now()) {
  const at = Number(st && st.userAskAt) || 0;
  return !!at && now - at < USER_ASK_HOLD_MS;
}

/** 现在这一轮还能不能接（调用方再自己比对歌名）。 */
export function chainAllowed() {
  const c = peekChain();
  if (!c) return false;
  return c.origin === 'her-offer';
}

/**
 * 推荐刷新以后，把面板上「下一首播放《X》」跟着换掉（0.0.1.6.33，0.16.58 改成只碰 preview）。
 * 不这么做它会一直挂着上一次真放歌时的旧歌（用户实测《捕风》挂了一上午）。
 *
 * 0.16.61（用户第 12 条）：从「永远取 items[0]」改成**从候选里挑一首不撞名的**。
 * 他点了推荐里第一首《富士山下》，而这里死取 items[0]，于是「下一首」还是《富士山下》——
 * 看着像接力没换过歌。现在传一批候选 + 一批要排除的歌名（正在放的、他刚点的/她刚推的那首），
 * 挑第一个不在排除名单里的；一个都挑不出来（推荐只有一首且就是这首）就**把预告撤掉**，不硬挂。
 *
 * 关键：**只写 preview**，绝不动 base / count / offeredBaseKey ——
 * 让「刷推荐」这件事跟「接力进行中」彻底分开。
 */
export function syncOffer(pick, opts = {}) {
  // 第 128 节：刚点了「换一批」，还在那 10 秒里 → 先不挑、不显示。
  // 面板这时会显示「正在为你挑选歌曲中…」（由 pickWaitLeft() 驱动）。
  if (pickWaitLeft() > 0) {
    const c0 = readRaw() || {};
    if (c0.preview) return saveChain({ preview: null, previewAt: 0 });
    return c0;
  }
  const list = Array.isArray(pick) ? pick : [pick];
  const ex = (Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude || ''])
    .map(norm)
    .filter(Boolean);
  // 第 125 节（用户口径：「你把这个选择从这 5 首里面随机选一个出来」）：
  // 原来这里是「挑第一个不撞名的」→ 面板上每次都显示推荐池的第一首，
  // 看着像「换一批根本没换」。改成在排除之后随机挑一首。
  //
  // 但**不能真随机** —— 这个函数每次面板刷新都会跑，纯随机会让「下一首播放《X》」
  // 每几秒跳一次。所以用「这一批推荐的时间戳」当种子：
  // 同一批候选永远挑到同一首，换一批才换一首。
  const pool = list.filter((x) => {
    if (!x) return false;
    const nm = String(x.name || '').trim();
    return nm && !ex.includes(norm(nm));   // 正在放的 / 他刚点的那首，跳过
  });
  let cand = null;
  if (pool.length) {
    const seed = Math.floor(Number(opts.seed || 0));
    // 取模的坑：推荐批次时间戳的毫秒位常常凑整，直接 `seed % n` 会老落在同一个位置。
    // 用「秒数 + 毫秒」再取模，分布就够了（同一批仍然稳定）。
    const i = seed > 0
      ? (Math.floor(seed / 1000) + (seed % 1000)) % pool.length
      : Math.floor(Math.random() * pool.length);
    cand = pool[i];
  }
  const c = readRaw() || {};
  const name = String((cand && cand.name) || '').trim();
  if (!name) {
    // 没得挂（候选全撞名）→ 把预告撤掉，别留着上一首在那儿充当「下一首」
    if (c.preview) return saveChain({ preview: null, previewAt: 0 });
    return c;
  }
  const cur = c.preview;
  const curAge = cur ? Date.now() - Number(c.previewAt || c.at || 0) : Infinity;
  if (cur && norm(cur.name) === norm(name) && curAge < PREVIEW_STALE_MS) return c;
  const next = {
    ...blank(),
    ...c,
    at: c.at || Date.now(),
    preview: {
      name,
      artist: String((cand && cand.artist) || ''),
      id: String((cand && cand.id) || ''),
      at: Date.now(),
    },
    previewAt: Date.now(),
  };
  writeRaw(next);
  return next;
}

/**
 * 面板该显示的那首「下一首」：**接力真在跑**的时候才显示递出去那首，
 * 否则一律当「推荐预告」显示。
 *
 * 0.16.58：这里多卡了一道 `origin === 'her-offer' && base` —— 盘上那些老格式残留
 * （`base:null` + `offer` 有值，正是用户听到误播的那份状态）不能再装成「接力进行中」。
 */
export function displayOffer() {
  const c = peekChain();
  if (!c) return null;
  const live = c.origin === 'her-offer' && !!(c.base && c.base.name);
  if (live && c.offer && c.offer.name) return { ...c.offer, kind: 'chain' };
  if (c.preview && c.preview.name && Date.now() - Number(c.previewAt || 0) < PREVIEW_STALE_MS) {
    return { ...c.preview, kind: 'preview' };
  }
  return null;
}

/** 这首是不是她递过来的那首。 */
export function isOffered(title) {
  const c = peekChain();
  return !!(c && c.offer && norm(c.offer.name) === norm(title));
}

/** 「今天（按 hour 点切日）清过歌单了吗」—— 过了就返回 true，该清了。 */
export function needsDailyClear(hour) {
  const c = readRaw() || {};
  const h = Math.min(23, Math.max(0, Number(hour) || 0));
  const now = new Date();
  // 切日点：今天 h 点之前算「昨天」那一轮
  const mark = now.getHours() < h ? new Date(now.getTime() - 24 * 3600 * 1000) : now;
  const key = `${mark.getFullYear()}-${String(mark.getMonth() + 1).padStart(2, '0')}-${String(mark.getDate()).padStart(2, '0')}-${String(h).padStart(2, '0')}`;
  return String(c.dailyKey || '') !== key ? key : '';
}

/** 记下「今天这一轮已经清过了」。 */
export function markDailyClear(key) {
  return saveChain({ dailyKey: String(key || '') });
}

export const PATHS = { FILE, AHEAD_SEC, SAY_AHEAD_SEC };
export { norm as keyOf };
