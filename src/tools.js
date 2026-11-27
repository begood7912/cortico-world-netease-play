/**
 * 四个工具：
 *   netease_play    — 点歌（搜歌 + 排到歌单最前 + 从第一首连播 + 记次数）
 *   netease_ledger  — 查点歌次数账本
 *   netease_quiet   — 查她现在静着说了什么 / 递过来的下一首
 *   netease_reco    — 看推荐（今天听点什么），要换一批就 refresh=true
 *
 * 描述刻意写短：工具声明每轮都进上下文，每个字都要反复付钱。
 */
import { playSongs, readLedger } from './python.js';
import { refresh as refreshPlaylists } from './playlists.js';
import { describeIdle, markIdleAnswered, peekIdle, recentIdleOffer } from './idle.js';
import { peekChain, markOrigin, beginUserTakeover, sameKey } from './chain.js';
import { stopSpeaking } from './speak.js';
import { peekRecommend } from './recommend.js';
// 0.17.39：来源开关 —— 工具读的、刷的必须是当前生效的那一路
import { isWeatherActive } from './source.js';
import { peekWxReco, rerollWxPick, peekNextWx } from './wxreco.js';
// 0.17.43（A8）：用户点歌 = 用户动作，接力静默（chainGate 用同一个判断）
import { markUserAction } from './userAction.js';
import { idleSecs } from './listening.js';
// 0.17.52（B3）：当前曲目走 track.js（CDP 优先，PowerShell 只兜底）
import { currentTrack } from './track.js';
import { clearQuiet } from './quiet.js';
import { cdpAlive, ensureClient } from './client.js';
// 0.17.60（A 方案）：接受她的提议时，歌单按「此刻页」那套算（可能换成 AI 推荐歌单）
import { pickTargetPlaylist } from './recoPick.js';

/**
 * 0.17.60（用户口径，A 方案）：她刚提议完的 30 秒内，用工具放的那首如果就是她提议的那首，
 * 算「他接受了她的提议」——接力接得上、歌单走推荐歌单；否则仍是「他自己叫她放的」(user-ask)。
 */
export const OFFER_WINDOW_MS = 30_000;

/** 纯函数：这一批歌是不是「她刚提议的那一首」（只认单曲、按歌名归一化比）。 */
export function isOfferAccept(songs, offer) {
  if (!offer || !offer.pick || !String(offer.pick.name || '').trim()) return false;
  const list = Array.isArray(songs) ? songs.filter((s) => s && (s.name || s.title)) : [];
  if (list.length !== 1) return false;
  const one = list[0];
  return sameKey(String(one.name || one.title), offer.pick.name);
}

/**
 * 0.17.44（用户口径）：默认不许她操作电脑，但**对方明确要求她亲自去操作界面时例外**。
 * 这段同时写进工具描述 —— 即使设置里的「前置语句」被改掉，约束仍然会追加（见 playDesc）。
 */
const CUA_RULE = '放歌、搜歌、切歌、看推荐一律走工具；默认不要用 pet_cua_* / 鼠标 / 键盘 / 截图或任何控制桌面的工具去操作网易云。'
  + '唯一例外：对方明确要求你亲自去操作界面（例如「你去点那个按钮」「你帮我点开歌单」）时，只做他点名的那一件事，做完回到工具路线；没有明确要求时一律不许。';

export const PLAY_DECL = {
  name: 'netease_play',
  description:
    '点歌。按歌名搜，把这批歌排到歌单最前面，然后从这批的第一首开始连续播放。'
    + '对方明确说"放某首歌""听某首歌"时用它（auto=false，会记次数，同一首点两次会自动加进"我喜欢的音乐"）。'
    + '他说"放几首"但没给歌名时，你自己先挑好再调，并传 auto=true（歌是你选的，不记账）。'
    + '你自己主动挑的歌也必须传 auto=true。'
    + '一次可以给一到多首，会按给的顺序连续播放。'
    + '他说出来的歌名经常是错的（同音字、只记得大意、语音听错）：先自己认准「正式歌名 + 原唱歌手」再传，名字拿不准就把两三种写法放进 alt。'
    + '放好以后按**实际放出来的歌手**回话：真放到了原唱就一句「现在为你播放{歌手}的《{歌名}》」；'
    + '不是原唱（翻唱、别人的版本、搬运号）必须当场说清「没找到{原唱}的原唱，现在放的是{实际歌手}的版本《{歌名}》」，不要用原唱的名字冒充。'
    + '判断依据是工具返回里写的「实际歌手」，不要自己猜哪个是原唱。'
    + CUA_RULE,
  parameters: {
    type: 'object',
    properties: {
      songs: {
        type: 'array',
        description: '要放的歌，按想听的顺序排',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '歌名' },
            artist: { type: 'string', description: '原唱歌手（不是翻唱的人），知道就填，能提高搜准率' },
            alt: {
              type: 'array',
              items: { type: 'string' },
              description: '备选叫法（同音字、简写、带歌手的写法都行），最多 3 个',
            },
          },
          required: ['name'],
        },
      },
      playlist: { type: 'string', description: '歌单名，默认"小菱的歌单"' },
      auto: {
        type: 'boolean',
        description: '你自己挑的歌传 true：照常播放但不记次数。对方开口点的歌传 false 或不传',
      },
      random: {
        type: 'boolean',
        description: '随机播放请求：对方只说「随便放一首 / 随机播放」时传 true。会按「今天听点什么」第一首放，并打开接力点歌，不用再给 songs',
      },
    },
    required: [],
  },
  tags: ['act'],
};

/** 发给 AI 的前置语句默认版（设置页当占位符，也当「还原默认」的底）。 */
export const DEFAULT_PLAY_PROMPT = PLAY_DECL.description;

export const LEDGER_DECL = {
  name: 'netease_ledger',
  description:
    '看点歌次数账本。对方问"这首我点过几次""我最近常点什么"，或你想判断某首是不是快够两次（两次会进"我喜欢的音乐"）时用。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '只看名字里含这个词的歌，不填看全部' },
      limit: { type: 'integer', description: '最多列几首，默认 12' },
    },
  },
  tags: ['read'],
};

export const QUIET_DECL = {
  name: 'netease_quiet',
  description:
    '看她刚才在安静时主动说了想听什么。对方回「放吧」「好啊」「就你说的那首」却没说歌名，'
    + '或者问「你刚才说想听什么」时，先用它拿到是哪首（带歌曲 id），再调 netease_play。'
    + '她没开过口时这里会如实说没有，不要自己编一首顶上去。',
  parameters: {
    type: 'object',
    properties: {},
  },
  tags: ['read'],
};

export const RECO_DECL = {
  name: 'netease_reco',
  description:
    '看她现在推荐了什么，或者重算一批。推荐来源由设置里的「接力按哪张卡挑」决定（按天气 / 按听歌历史），'
    + '返回里会写清是哪一种，不要自己换一路去读。对方说「换一批」「再推几首」「这首不像我会听的」，'
    + '就把 refresh 填 true 重算。'
    + '填了 refresh 之后这个工具会立刻返回、不等算完 —— 不要再调第二次等结果，'
    + '也不要自己去点网易云的界面或者移动鼠标（除非对方明确要求你亲自操作那个界面）：算完她会自己把歌名报出来。'
    + '不填只读当前推荐，不重算。',
  parameters: {
    type: 'object',
    properties: {
      refresh: { type: 'boolean', description: 'true = 重算一批推荐；不填只读现在的' },
    },
  },
  tags: ['read'],
};

function fmtReco(items, source) {
  const tag = source === 'weather' ? '（按天气）' : '（按听歌历史）';
  if (!items || !items.length) return `现在还没有推荐结果${tag}。`;
  return [`推荐${tag}（前五）：`, ...items.slice(0, 5).map((x, i) => `${i + 1}. ${x.name}${x.artist ? ` / ${x.artist}` : ''}`)].join('\n');
}

function fmtPlay(r) {
  const j = r.result;
  if (!j) {
    const tail = String(r.out || '').trim().split(/\r?\n/).slice(-4).join('\n');
    return `点歌脚本没有给出结果（退出码 ${r.code}）。最后的输出：\n${tail || '（空）'}`;
  }
  if (!j.ok) {
    const why = j.error || '没搜到合格的歌';
    const resolveFail = (j.failed || []).map((f) => f.name).filter(Boolean);
    const addFail = (j.addFailed || []).map((f) => f.name).filter(Boolean);
    const parts = [];
    if (resolveFail.length) parts.push(`没搜到：${resolveFail.join('、')}`);
    if (addFail.length) parts.push(`没加进歌单：${addFail.join('、')}`);
    // 0.17.42：加歌失败时把 stage 也带出来（del / add / play），别只说一句「没点成」
    const stages = (j.errors || []).map((e) => e.stage).filter(Boolean);
    const where = stages.length ? `（卡在 ${[...new Set(stages)].join('/')}）` : '';
    return `没点成：${why}${where}${parts.length ? `\n${parts.join('\n')}` : ''}`;
  }
  const lines = [];
  // 0.17.42：`added` 已经是「真的加进歌单的」，不再是解析数
  const added = j.added || j.resolved || [];
  if (added.length) {
    const nAll = Number(j.counts?.requested) > added.length ? `（共点了 ${j.counts.requested} 首）` : '';
    lines.push(`已加入「${j.playlist || '歌单'}」${added.length} 首${nAll}，从第一首开始连播：`);
    for (const a of added) {
      const nm = a.name || a.title || '?';
      const ar = a.matched_artist || a.artist || a.artists || '';
      const cnt = a.count ?? j.ledger?.counts?.[String(a.id)];
      const sus = String(a.suspect || '').trim();
      lines.push(`- ${nm}${ar ? ` / ${ar}` : ''}${cnt ? `（第 ${cnt} 次）` : ''}${sus ? `　${sus}` : ''}`);
    }
  } else {
    lines.push('一首都没加进去。');
  }
  const failed = j.failed || [];
  if (failed.length) {
    lines.push(`没搜到：${failed.map((f) => f.name).filter(Boolean).join('、')}`);
  }
  // 0.17.42：解析到了、但没加进歌单的那些 —— 以前会被混进「已加入」里
  const addFailed = j.addFailed || [];
  if (addFailed.length) {
    lines.push(`没加进歌单：${addFailed.map((f) => f.name).filter(Boolean).join('、')}`);
  }
  const played = j.played;
  if (played) {
    const nm = played.name || played.title || '';
    if (nm) lines.push(`现在在放：${nm}`);
  } else if (added.length) {
    // 加进去了却没响：以前这种情况会静默变成「没点成」，现在单独说
    lines.push('加进去了，但没放起来（播放器那边没确认）。');
  }
  // 0.0.1.6.37：直接把回话的句式摆给它 —— 免得它自己编一句「这就给你放上了，应该挺对味的」。
  const first = added[0] || played || null;
  if (first) {
    const nm = String(first.name || first.title || '').trim();
    const ar = String(first.matched_artist || first.artists || '').trim();
    const asked = String(first.artist || '').trim();
    const sus = String(first.suspect || '').trim();
    // 标题/歌手里带这些词，一看就不是原版
    const VERSION_WORDS = /翻唱|cover|live|现场|dj|伴奏|纯音乐|remix|烟嗓|女声|男声|童声|钢琴|吉他|抖音|片段|demo|remake/i;
    const aLow = ar.toLowerCase();
    const askedLow = asked.toLowerCase();
    const looksOriginal = !!askedLow && aLow.includes(askedLow) && !VERSION_WORDS.test(nm + ' ' + ar);
    if (nm && looksOriginal) {
      lines.push(`回他一句就行：现在为你播放${ar}的《${nm}》。`);
    } else if (nm) {
      // 说不准是不是原唱 → 把「实际放出来的这首」摆出来，由模型自己判断怎么说
      lines.push(`实际放出来的是：${nm}${ar ? ` - ${ar}` : ''}${sus ? `；${sus}` : ''}`);
      lines.push(`你报的原唱：${asked || '（没说）'}`);
      lines.push(`回他时按**实际放出来的这首**说：是原唱就只说「现在为你播放${ar || ''}的《${nm}》」；`
        + `不是原唱（翻唱、别人的版本、搬运号）必须说「没找到${asked || '原唱'}的原唱，现在放的是${ar || '别人'}的版本《${nm}》」，不要用原唱的名字冒充。判断不了是不是原唱时，按「不是原唱」说 —— 宁多说一句，也不要冒充原唱。`);
    }
  }
  if (j.ledger?.fav_added?.length) {
    lines.push(`这两首点满两次，已加进「我喜欢的音乐」：${j.ledger.fav_added.map((x) => x.name || x).join('、')}`);
  }
  if (j.ledger?.fav_err) lines.push(`加进我喜欢的音乐时出问题：${j.ledger.fav_err}`);
  return lines.join('\n');
}

function fmtLedger(j, limit) {
  if (!j.ok) return `读账本失败：${j.error}`;
  const all = Object.entries(j.songs)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || String(b.last || '').localeCompare(String(a.last || '')));
  if (!all.length) return '账本还是空的，一首都没点过。';
  const shown = all.slice(0, limit);
  const lines = [`账本更新于 ${j.updated || '未知'}，共 ${all.length} 首点过。`];
  for (const s of shown) {
    lines.push(`- ${s.name}${s.artist ? ` / ${s.artist}` : ''}：${s.count} 次${s.count >= 2 ? '（已在喜欢里）' : ''}　最后 ${s.last || ''}`);
  }
  return lines.join('\n');
}

export function makeTools(world) {
  const cfg = () => (world && world.ctx && world.ctx.cfg) || {};
  /**
   * 0.17.10：发给 AI 的前置语句（工具说明）改成可写 —— 设置页「AI 设置」里那段 textarea。
   * 留空就走 PLAY_DECL.description 这份默认；用户改了就整段替换。
   */
  const playDesc = () => {
    const v = String(cfg().aiPlayPrompt || '').trim();
    /* 0.17.44：自定义文案只替换"怎么说"，**安全约束始终追加**，不能被改没。 */
    return v ? `${v}\n${CUA_RULE}` : PLAY_DECL.description;
  };
  return [
    {
      ...PLAY_DECL,
      get description() { return playDesc(); },
      handler: async (args) => {
        let songs = Array.isArray(args.songs) ? args.songs : [];
        let randomTakeover = false;
        const c = cfg();
        // 0.17.2：随机播放请求 —— 开关开着就按 AI 推荐开局，并顺手把接力打开
        if ((args.random === true || !songs.length) && c.aiRandomChain !== false) {
          const rec = peekRecommend(c);
          const pick = rec && Array.isArray(rec.items) ? rec.items[0] : null;
          if (!pick) return '今天的推荐还没算出来，等一下再喊我随机播放吧。';
          songs = [{ name: pick.title || pick.name || '', artist: pick.artist || '' }];
          randomTakeover = true;
          if (c.chainPick === false) {
            c.chainPick = true;
            const p = world && world.ctx && typeof world.ctx.persist === 'function' ? world.ctx.persist : null;
            if (p) { try { p({ chainPick: true }); } catch { /* 存不下也照旧接 */ } }
          }
        }
        if (!songs.length) return '没给歌名。';
        /* 0.17.65：先认「这一次是不是接受她刚才的安静提议」。
           判据两样：这条提议还没作答、而且这次要放的就是她提议的那一首（单曲、歌名归一化比）。
           时间锚点两选一（见 recentIdleOffer）：他点了「放《X》」就按**点击时刻**算 30 秒（0.17.65 主路径，
           等十分钟后才点也算）；没拿到点击（AI 自主调工具）退回「她开口 + 30 秒」的老口径。 */
        const offer = recentIdleOffer(OFFER_WINDOW_MS);
        const acceptOffer = !randomTakeover && isOfferAccept(songs, offer);
        // 0.0.1.6.38：他有动作了（开口点歌）→ 「先安静着」这个临时开关就解除
        clearQuiet('play-tool');
        // 0.17.60：接受提议不算「用户自己点歌」——不记 BLOCK 类动作，别让接力在 45 秒里被挡；
        // 只留一条 'offer-accept' 的记录（不在 userAction 的 BLOCK 名单里）。
        if (acceptOffer) {
          markUserAction('offer-accept', String(songs[0].name || songs[0].title || '').slice(0, 80));
          // 0.17.65：认领即收口 —— 写 answeredAt，免得同一条提议在 30 秒里被第二首歌再认领一次
          markIdleAnswered();
        } else {
          markUserAction('play', songs.map((x) => x && (x.name || x.title)).filter(Boolean).join('、').slice(0, 80));
        }
        const explicitPlaylist = (typeof args.playlist === 'string' && args.playlist.trim())
          ? args.playlist.trim()
          : '';
        // 0.17.60：接受提议时歌单按「此刻页」同一套规则（勾了「接力点歌歌单」才换成 AI 推荐歌单）；
        // 他自己点名给歌单的，仍然听他的。
        const plFromOffer = (!explicitPlaylist && acceptOffer) ? pickTargetPlaylist(c, 'now') : '';
        const playlist = explicitPlaylist || plFromOffer;
        // 接受提议 = 她选的歌，不记点歌次数（和「此刻页点歌」同一口径）
        const auto = args.auto === true || randomTakeover || acceptOffer;
        // 0.0.1.6.39：走到这一步就是「确定要放歌」了 —— 客户端没开就这时候拉起来，
        // 别在开口询问的时候拉（用户口径：只有确定放歌才拉起）。
        if (!(await cdpAlive(c.cdpPort))) {
          const up = await ensureClient(c, { timeoutMs: 25000 });
          if (!up.ok) {
            return up.reason === 'no-exe'
              ? '网易云没开，也找不到它的安装位置，放不了。'
              : '网易云没开，我试着拉了一下但没起来，放不了。';
          }
        }
        // 0.17.18（方案 A）：他开口的这一刻先把接力掐掉 —— 后面 `playSongs` 要跑 1.4~10 秒，
        // 等它回来再标 user-ask 就晚了：上一轮「已播报」的承诺会抢在这几秒里把歌换掉。
        // 0.17.60：接受她的提议时**不许掐**（那正是要接着跑的这一轮）。
        if (!randomTakeover && !acceptOffer) {
          // 顺带把已经出口/正在合成的那句「即将播放《X》」撤掉 ——
          // 不然会出现「接力已停止，却又念了一句，歌没换」。
          try { stopSpeaking(); } catch { /* 没在播就无所谓 */ }
          try { beginUserTakeover(); } catch { /* 标记失败就退回老路子，末尾那次 markOrigin 仍然会标 */ }
        }
        // 0.17.60：接受提议时，先把「这首是她递的」标上去，再开播 ——
        // 跟 `answerIdle` 一样抢在 `playSongs` 那几秒之前占位，免得上一轮接力把歌换掉。
        if (acceptOffer) {
          try {
            const f = songs[0] || {};
            markOrigin('her-offer', { name: f.name || f.title || '', artist: f.artist || '' });
          } catch { /* 标记失败不影响这次点歌，末尾那次还会再标一次 */ }
        }
        const r = await playSongs({
          playlist: playlist || c.playlist || '',
          songs,
          auto,
          dryRun: false,
          cdpPort: c.cdpPort,
          favAt: c.favThreshold,
          autoFav: c.autoFav !== false,
          allowRestart: c.allowRestart === true,
        });
        // 0.16.58：这是**他自己叫她放的歌** → 打 user-ask，接力点歌一律不许顺着往下接。
        // 用户口径：「我让她点几首歌、播放几首，这种不要触发 AI 接力。」
        try {
          const first = songs.find((x) => x && (x.name || x.title)) || songs[0] || null;
          // 随机接管 / 接受她的提议 → 这首算「她递的」，接力才会顺着往下接；他自己点的一律 user-ask
          if (r && r.ok !== false) markOrigin((randomTakeover || acceptOffer) ? 'her-offer' : 'user-ask', first
            ? { name: first.name || first.title || '', artist: first.artist || '' }
            : null);
        } catch { /* 标记失败不影响这次点歌 */ }
        // 点歌可能会新建歌单，顺手刷一次下拉缓存（后台，不等）
        refreshPlaylists(c.cdpPort).catch(() => {});
        if (randomTakeover) {
          const f = songs[0] || {};
          if (r && r.ok !== false) {
            return `正在为你播放${f.artist ? `${f.artist}的` : ''}《${f.name || ''}》，并自动开启接力点歌。`;
          }
          return fmtPlay(r);
        }
        // 0.17.60：接受提议这条路上，告诉 AI「接力已开、歌单按此刻页规则」——它回话时不必再解释。
        if (acceptOffer && r && r.ok !== false) {
          return `${fmtPlay(r)}\n（这是他接受了她刚才的提议：接力点歌已开启，歌单按「此刻页」的规则。）`;
        }
        return fmtPlay(r);
      },
    },
    {
      ...LEDGER_DECL,
      handler: async (args) => {
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 12;
        const j = await readLedger();
        if (keyword) {
          const hits = Object.entries(j.songs || {}).filter(([, v]) => String(v.name || '').includes(keyword));
          if (!hits.length) return `账本里没有名字含「${keyword}」的歌。`;
          const lines = [`含「${keyword}」的点歌记录：`];
          for (const [id, v] of hits) lines.push(`- ${v.name}${v.artist ? ` / ${v.artist}` : ''}：${v.count} 次　最后 ${v.last || ''}　id ${id}`);
          return lines.join('\n');
        }
        return fmtLedger(j, limit);
      },
    },
    {
      ...QUIET_DECL,
      handler: async () => {
        let now = null;
        try {
          now = await currentTrack();
        } catch {
          now = null;
        }
        const lines = [];
        if (now && now.playing === true && now.title) {
          lines.push(`现在正在放《${now.title}》${now.artist ? `（${now.artist}）` : ''}，已经不是安静状态了。`);
        } else {
          const sec = idleSecs();
          lines.push(sec > 0
            ? `现在没在放歌，已经安静了 ${sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`}。`
            : '现在没在放歌。');
        }
        const say = describeIdle();
        if (say) lines.push(say);
        else lines.push('她还没在安静时主动开过口（或者那句已经过去两小时了）。');
        // 接力点歌：她递过来的下一首她自己就接着放了（0.0.1.6.22 的口径：只语音报一声，不弹窗、不问）
        const st = peekChain();
        if (st && st.offer && st.offer.name) {
          lines.push(`另外，她趁刚才那首快放完时接了一首：《${st.offer.name}》${st.offer.artist ? `（${st.offer.artist}）` : ''}（这一轮第 ${st.count || 1} 首，没有上限）。`);
          lines.push('这一首她报完歌名就自己放了，不用你调工具，也不要再问她要不要放。');
        }
        const idle = peekIdle();
        const next = (idle && idle.pick) || null;
        if (next && next.name && !(st && st.offer && st.offer.name)) {
          lines.push(`要放的话：netease_play songs=[{"name":"${next.name}"${next.artist ? `,"artist":"${next.artist}"` : ''}}]`);
        }
        // 0.16.86（第 132 节 A8）：这里原来会报"这一轮是自动连播第 n/5 首" —— 队列删了，这段一起去掉
        return lines.join('\n');
      },
    },
    {
      ...RECO_DECL,
      handler: async (args) => {
        const c = cfg();
        const weatherOn = isWeatherActive(c);
        if (args && args.refresh === true) {
          /* 0.17.39：重算的必须是当前来源那一路；另一路已经停刷，不能再把它叫醒。 */
          if (weatherOn) {
            const old = peekWxReco(c, { kick: false });
            const after = await rerollWxPick(c, {});
            const prev = old && old.ok && Array.isArray(old.items) && old.items.length
              ? `\n这一轮已投：${old.items.map((x) => `《${x.name}》`).join('、')}`
              : '';
            const nx = after && after.ok ? `\n这一轮还剩 ${Math.max(0, Number(after.left) || 0)} 首。` : '';
            return '已经把这一首换掉了（丢掉这一句和它配的那首，下一句重算一首）。'
              + nx + prev;
          }
          // 0.0.1.6.31：不再同步等重算（冷态 15 秒，宿主等不住会自己去点界面）。
          // 立刻回一句，算完她报歌名。
          const cfgNow = c;
          const old = peekRecommend(cfgNow);
          const job = typeof world.startRecoRefresh === 'function'
            ? world.startRecoRefresh()
            : { busy: true };
          const hint = '正在重算新的一批，大约十几秒，算完她会自己把歌名报出来。'
            + '这期间不要去点界面、不要用鼠标操作屏幕，也不要再调这个工具等结果。';
          if (job && job.busy) return `已经在算了，再等她就报。${hint}`;
          if (old && Array.isArray(old.items) && old.items.length) {
            return `上一批是这样的：\n${fmtReco(old.items, 'history')}\n${hint}`;
          }
          return hint;
        }
        if (weatherOn) {
          /* 0.1.19（007）：天气这一路是「一句配一首」，列表里是**这一轮已经投出去的**，
             所以先说下一首（就是下一句算出来的那首），再报这一轮已投了几首。 */
          const w = peekWxReco(c, { kick: false });
          let nx = null;
          try { nx = await peekNextWx(c); } catch { nx = null; }
          const done = (w && w.ok && Array.isArray(w.items)) ? w.items.filter((x) => x && x.name) : [];
          const head = nx ? `下一首（按天气）：《${nx.name}》${nx.artist ? ` / ${nx.artist}` : ''}` : '';
          const tail = done.length
            ? `这一轮已投 ${done.length} 首：${done.map((x) => `《${x.name}》`).join('、')}`
            : '';
          if (head) return tail ? `${head}\n${tail}` : head;
          if (tail) return tail;
          return `现在还没有按天气算出来的推荐。${w && w.reason ? `（状态：${w.reason}）` : ''}`;
        }
        const rec = peekRecommend(c);
        return fmtReco(rec && rec.items, 'history');
      },
    },
  ];
}
