/**
 * 面板后端：两个页签的数据都由这里出。
 *
 * 契约（cortico world api 6）：
 *   webUi() 里给 panels 与 invoke；WebUI 调 ctx.invoke(method, args)
 *   → 这里 panelInvoke(panel, method, args)。
 *
 * rank 有两个口径，分得很清：
 *   「点歌次数」= 你开口点了几次（点歌账本 notes\点歌次数.json，只记非 auto 的点歌）
 *   「听歌次数」= 网易云实际放到它几次、共多少秒（data\listening.jsonl，常驻采集）
 */
import { readLedger, playSongs } from './python.js';
import { logPath } from './store.js';
import { playSong, logPlay } from './play.js';
import { nameById } from './playlists.js';
// 0.17.52（B3）：当前曲目走 track.js（CDP 优先，PowerShell 只兜底）
import { currentTrack } from './track.js';
import { getLiked } from './liked.js';
import { readListens, idleSecs, lastTrack } from './listening.js';
import { readWants, wantCount, clearWants, addWant } from './wants.js';
import { peekTake, peekFail, generateTake, peekFailError } from './take.js';
import { hearCardOn, likedRowOn, takeBodyOn } from './cards.js';
import { peekLike, peekLikeFail, generateLike, readPersonaNote, peekLikeFailError, rotateLike } from './like.js';
import { peekComment, peekCommentFail, generateComment } from './comment.js';
import { peekReply, peekReplyFailError, generateReply } from './her-reply.js';
import { peekRecommend, peekRecommendStale, peekRecommendFail, generateRecommend } from './recommend.js';
import { hasModel } from './ollama.js';
import { cloudPanelSnapshot, cloudPanelSetSource, cloudPanelSave, cloudPanelList } from './cloudpanel.js';
import { settingsSnapshot, settingsSet, settingsSetMany, aboutInfo, weatherSnapshot } from './settingspanel.js';
// 0.17.30：天气查询独立成模块，模型页与此刻页共用
import { weatherNow, fetchWeather, wxProbe } from './qweather.js';
// 0.17.30：卡片5 —— 按天气挑歌（此刻页，卡①下面那张）
import { peekWxReco, refreshWxReco, scheduleWxReco, dropWxSong } from './wxreco.js';
// 0.17.39：来源开关（设置里那个 2 选 1）—— 决定哪张卡有数据、哪张卡显示「已停用」。
import { activeSource, isHistoryActive, isWeatherActive } from './source.js';
// 0.17.43（A8）：用户动作统一入口
import { markUserAction } from './userAction.js';
export { weatherNow };
import { isIdleAsking, peekIdle } from './idle.js';
import { peekChain, syncOffer, displayOffer, markOrigin, markClosed, saveChain, pickWaitLeft, chainStateOf, sameKey } from './chain.js';
import { lastAlive, clientProcessRunning } from './client.js';
import { peekQuiet, setQuietForever } from './quiet.js';
import { clearQuiet } from './quiet.js';
import { DEFAULT_PLAYLIST } from './python.js';
// 0.16.62：推荐页点歌要不要落到「AI 推荐歌单」—— 单独一个文件，见 src\recoPick.js 开头
import { applyPick } from './recoPick.js';
// 0.17.4：排名页每行都要带歌曲 id（账本本来就按 id 记，流水补 id）
import { remember, resolveMany, cachedId } from './songid.js';


/** 账本里的时间格式是 "YYYY-MM-DD HH:MM"，浏览器解析不保证，统一转 ISO。 */
function toIso(savedAt) {
  const raw = String(savedAt || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) return raw;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}`;
}

/**
 * 榜单：两套口径一起给。
 *
 *   count / countLastAt  —— 点歌次数（你开口点了几次，来自点歌账本）
 *   listens / listenSec  —— 听歌次数与累计秒数（网易云实际放到它，来自 listening.jsonl）
 *
 * 两套排序都排好再交给前端，前端切口径只是换个数组，不用自己重算名次。
 */
async function rankSnapshot(limits = { rankTracks: 100, rankArtists: 30 }) {
  const [led, listens] = await Promise.all([readLedger(), readListens()]);

  const raw = Object.entries(led.songs || {}).map(([id, v]) => {
    // 账本的键就是歌曲 id —— 顺手记进 id 缓存，以后这首歌被听到时不用再查接口
    remember(String(v.name || '').trim(), String(v.artist || '').trim(), id);
    return {
      songId: id,
      title: String(v.name || '').trim(),
      artist: String(v.artist || '').trim(),
      count: Number(v.count) || 0,
      lastAt: toIso(v.last),
    };
  }).filter((x) => x.title);

  // 账本按歌曲 id 记账，同一首歌的不同版本（原版 / Live / 翻唱）会分成几条。
  // 榜单按「歌名 + 歌手」合并，否则前三名里会出现两行一模一样的《永夜》。
  const bySong = new Map();
  for (const s of raw) {
    const k = `${s.title}|${s.artist}`.toLowerCase();
    const cur = bySong.get(k);
    if (cur) {
      cur.count += s.count;
      if (s.lastAt > cur.lastAt) cur.lastAt = s.lastAt;
      cur.versions = (cur.versions || 1) + 1;
    } else {
      bySong.set(k, { ...s, versions: 1 });
    }
  }

  // 把听歌流水贴到同一批曲目上；只听过没点过的歌也补进来（它们同样是"常听"）。
  /* 0.17.52（B3 配套）：听歌流水的标题现在可能来自「官方详情接口」，和账本里的
     窗口标题（「歌名 - 歌手」）不一定一模一样 —— 所以先用 **id** 配，配不上再按歌名+歌手。
     否则同一首会被拆成两行。 */
  const rest = new Map(); // key -> listen item（id 优先，其次名字）
  for (const it of listens.items) {
    const sid = String(it.id || '');
    const k = sid ? `id:${sid}` : `nm:${it.title}|${it.artist}`.toLowerCase();
    if (!rest.has(k)) rest.set(k, { ...it });
  }
  const takeFor = (s) => {
    const sid = String(s.songId || '');
    if (sid && rest.has(`id:${sid}`)) {
      const hit = rest.get(`id:${sid}`);
      rest.delete(`id:${sid}`);
      return hit;
    }
    const nk = `nm:${s.title}|${s.artist}`.toLowerCase();
    if (rest.has(nk)) {
      const hit = rest.get(nk);
      rest.delete(nk);
      return hit;
    }
    return null;
  };
  for (const s of bySong.values()) {
    const hit = takeFor(s);
    s.listens = hit ? hit.listens : 0;
    s.listenSec = hit ? hit.sec : 0;
    s.lastListenAt = hit ? hit.lastAt : '';
  }
  for (const it of rest.values()) {
    const key = `${it.title}|${it.artist}`.toLowerCase();
    if (bySong.has(key)) continue;
    bySong.set(key, {
      songId: String(it.id || cachedId(it.title, it.artist) || ''),
      title: it.title,
      artist: it.artist,
      count: 0,
      lastAt: '',
      versions: 0,
      listens: it.listens,
      listenSec: it.sec,
      lastListenAt: it.lastAt,
    });
  }

  const songs = [...bySong.values()];

  // 账本里的行本来就有 id；只听没点过的行上面已查缓存。还差的（老流水、从没查过）
  // 后台慢慢查，查到进缓存，下一次快照自然就有了 —— 这里不 await，排名页不能等上百次网络往返。
  for (const s of songs) {
    if (!s.songId && s.title) s.songId = cachedId(s.title, s.artist);
  }
  const missing = songs.filter((s) => !s.songId && s.title);
  if (missing.length) {
    resolveMany(missing.map((s) => ({ title: s.title, artist: s.artist })), { concurrency: 3, timeoutMs: 5000 })
      .catch(() => { /* 查不到不影响排名 */ });
  }

  const byCount = (a, b) => b.count - a.count || b.listens - a.listens
    || String(b.lastAt).localeCompare(String(a.lastAt));
  const byListen = (a, b) => b.listens - a.listens || b.listenSec - a.listenSec
    || b.count - a.count;

  const trackView = (s, i) => ({ rank: i + 1, ...s });

  const tracks = [...songs].sort(byCount).slice(0, limits.rankTracks).map(trackView);
  const tracksByListen = songs.filter((s) => s.listens > 0)
    .sort(byListen).slice(0, limits.rankTracks).map(trackView);

  // 歌手聚合：点歌次数、听歌次数分别相加，最近时间取最大。
  const aggArtists = (sortFn) => {
    const byArtist = new Map();
    for (const s of songs) {
      const name = s.artist || '未知歌手';
      const cur = byArtist.get(name);
      if (cur) {
        cur.count += s.count;
        cur.listens += s.listens;
        cur.tracks += 1;
        if (s.lastAt > cur.lastAt) cur.lastAt = s.lastAt;
      } else {
        byArtist.set(name, {
          name, count: s.count, listens: s.listens, lastAt: s.lastAt, tracks: 1,
        });
      }
    }
    return [...byArtist.values()].sort(sortFn).slice(0, limits.rankArtists)
      .map((a, i) => ({ rank: i + 1, ...a }));
  };

  const artists = aggArtists(byCount);
  const artistsByListen = aggArtists(byListen).filter((a) => a.listens > 0);

  return {
    status: led.ok ? 'ok' : 'unavailable',
    error: led.ok ? '' : String(led.error || ''),
    totalRequests: songs.reduce((sum, s) => sum + s.count, 0),
    totalListens: listens.totalListens,
    totalListenSec: listens.totalSec,
    listened: listens.exists === true,
    storedTracks: songs.length,
    storedArtists: new Set(songs.map((s) => s.artist || '未知歌手')).size,
    limits,
    tracks,
    tracksByListen,
    artists,
    artistsByListen,
    ledgerUpdated: String(led.updated || ''),
    at: Date.now(),
  };
}

/** 上一轮快照看到的是哪首 —— 换歌时缓存里那句是上一次听的答案，不能拿来显示。 */
let lastNowKey = '';
// 0.17.54：上一遍看到的「世代号」—— 换歌/重播都算新的一遍，卡②③④ 只在它变的时候重算
let lastGen = null;

/** 此刻：在放什么 + 她怎么听这首 + 她喜不喜欢 + 想听清单。 */
async function nowSnapshot(cfg, ctx) {
  const now = await currentTrack();
  const pid = String((cfg && cfg.playlist) || '').trim();
  const c = cfg || {};
  /* 0.17.39（用户口径）：来源开关选哪张卡，就只有哪张卡算数、有数据；
     另一张卡显示「已停用」。快照只向 active 那一路要数据，不 kick 另一路。 */
  const src = activeSource(c);
  const wxOn = src === 'weather';
  const wxSnap = wxOn ? peekWxReco(c) : { ok: false, reason: 'inactive', items: [], pool: [], at: 0 };
  let title = String(now.title || '');
  let artist = String(now.artist || '');
  const playing = now.playing === true;

  /* 0.16.42：没在放歌时，卡②③④ 不该是三张空卡 —— 用户口径「第一次启动还是会出错」，
     说的就是重启后客户端没开、面板下面三张只剩「—」「还没说过」「没找到评论」，看着像坏了。
     做法：拿「今天听点什么」第一首当这次说的对象，只喂给这三张卡的内容；
     头部由前端按 playing=false 显示成「没在放」，另外用小字注明「先按《X》说」。
     设置页的 cardsPreview 关掉就退回原来的空状态。 */
  let preview = null;
  if (!playing) {
    /* 0.17.39：预览对象也跟来源走 —— 选了天气就别拿历史推荐第一首去喂这三张卡。 */
    const rec0 = wxOn ? wxSnap : (peekRecommend(c) || peekRecommendStale());
    const it0 = rec0 && Array.isArray(rec0.items) ? rec0.items[0] : null;
    if (it0 && it0.name && c.cardsPreview !== false) {
      preview = { title: String(it0.name), artist: String(it0.artist || '') };
      title = preview.title;
      artist = preview.artist;
    }
  }
  // 卡② 要用她的性格：从宿主 config.json 的 self-awareness.personaNote 读，读不到就退回无性格版
  const persona = readPersonaNote(ctx && ctx.botDir);

  /* 0.16.44（用户口径）：设置页一个总开关 + 卡②③④ 各一个勾。
     关掉的卡**真的不算**：不调模型、不拉评论、不写缓存，也不在到点后出声 ——
     面板上只留一行「这张卡在设置里关掉了」，四张卡的布局不动。
     默认全开；总开关关掉时三个单项一律无效（它们无法单独绕过总开关）。
     0.16.56：卡② 的勾拆成两段（sayHead / sayBody），两个都不勾就等于这张卡关掉。 */
  const cardsOn = c.cardsOn !== false;
  const cardHear = hearCardOn(c);

  /* 0.16.53：卡② 顶上那行「歌手《歌名》· 100 多万人喜欢」。
     只在「真在放歌」时读 —— 推荐预览那首没在客户端里放，页面上留着上一首的红心数，
     拿它配预览歌就是错的（getLiked 里也会按歌名比对再放行）。
     这一下最多等 0.6 秒（起一个 node 读 CDP），同一首之后走缓存不出进程。 */
  let liked = '';
  if (playing && title && likedRowOn(c)) {
    const lr = await getLiked({ title, artist, cdpPort: c.cdpPort });
    const lbl = lr && lr.ok ? lr.label : '';
    if (lbl) liked = `${artist ? `${artist} ` : ''}《${title}》 · ${lbl}`;
  }

  /* 卡①、卡② 都是「换歌就重算，同一首才读缓存」。
     生成要几秒，绝对不能 await —— 快照卡住的话整个面板都不动了。 */
  let take = null;
  let takeState = 'no-playing';
  let like = null;
  let likeState = 'no-playing';
  let comment = null;
  let commentState = 'no-playing';
  let reply = null;
  let replyState = 'no-playing';
  /* 0.16.44（用户口径）：设置页一个总开关 + 卡②③④ 各一个勾。
     关掉的卡**真的不算**：不调模型、不拉评论、不写缓存，也不在到点后出声 ——
     面板上只留一行「这张卡在设置里关掉了」，四张卡的布局不动。
     默认全开；总开关关掉时三个单项一律无效（它们无法单独绕过总开关）。 */
  const cardFeel = cardsOn && c.cardFeel !== false;
  const cardComment = cardsOn && c.cardComment !== false;
  if (title) {
    const k = `${title}|${artist}`.toLowerCase();
    // 0.17.54：世代号只认「采样器已经看到这首」的时候（标题一致），避免新歌刚切、
    // 采样器还没到，就拿上一遍的 gen 去比。
    const lt = lastTrack();
    const sameSeen = !!(lt && String(lt.title || '').trim() === title);
    const gen = sameSeen ? (Number(lt.gen) || 0) : null;
    const genChanged = gen != null && lastGen != null && gen !== lastGen;
    if (gen != null && lastGen == null) lastGen = gen;
    if (gen != null) lastGen = gen;
    const switched = k !== lastNowKey || genChanged;
    lastNowKey = k;
    const modelOk = hasModel(c);

    /* 她听这首歌时：两个勾各管一件事 —— 只关正文那一勾时，卡还在（顶上人数照显示） */
    if (!cardHear) {
      takeState = 'off';
    } else if (!takeBodyOn(c)) {
      takeState = 'body-off';
      take = null;
    } else if (!modelOk) {
      takeState = 'no-model';
      // 没模型也别把上一遍的旧句顶上来，那样看着像「这首歌也是这句」
    } else if (switched) {
      // 换歌：先显示「她在听…」，后台重算完下一轮刷新就是新答案
      takeState = 'pending';
      generateTake({
        title,
        artist,
        cdpPort: c.cdpPort,
        cfg: c,
        gen,
      }).catch(() => { /* 失败会自己落到负缓存，下次刷新显示原因 */ });
    } else {
      const hit = peekTake(title, artist, c, gen);
      if (hit) {
        take = hit;
        takeState = 'ready';
      } else {
        const failed = peekFail(title, artist);
        if (failed) {
          takeState = failed;
        } else {
          takeState = 'pending';
          generateTake({
            title,
            artist,
            cdpPort: c.cdpPort,
            cfg: c,
            gen,
          }).catch(() => { /* 失败会自己落到负缓存，下次刷新显示原因 */ });
        }
      }
    }

    /* 她的感觉 —— 换成另一首歌第一眼就该有东西看。
       池子里存着这首歌以前算过的几条（每条引的是不同的歌词句子），换歌时只做「抽签」，
       不花模型调用；池子空（这首歌第一次听）才现算两条。 */
    if (!cardFeel) {
      likeState = 'off';
    } else if (!modelOk) {
      likeState = 'no-model';
    } else if (switched) {
      const rotated = rotateLike(title, artist, c, gen);
      if (rotated) {
        like = rotated;
        likeState = 'ready';
      } else {
        likeState = 'pending';
        generateLike({
          title,
          artist,
          cdpPort: c.cdpPort,
          persona,
          cfg: c,
          gen,
        }).catch(() => { /* 失败会自己落到负缓存，下次刷新显示原因 */ });
      }
    } else {
      const hit = peekLike(title, artist, c, gen);
      if (hit) {
        like = hit;
        likeState = 'ready';
      } else {
        const failed = peekLikeFail(title, artist);
        if (failed) {
          likeState = failed;
        } else {
          likeState = 'pending';
          generateLike({
            title,
            artist,
            cdpPort: c.cdpPort,
            persona,
            cfg: c,
            gen,
          }).catch(() => { /* 失败会自己落到负缓存，下次刷新显示原因 */ });
        }
      }
    }

    /* 别人怎么说 —— 评论区热评，不需要模型，也不依赖客户端（纯 HTTP） */
    if (!cardComment) {
      commentState = 'off';
    } else if (switched) {
      commentState = 'pending';
      generateComment({ title, artist, gen }).catch(() => { /* 失败会落到负缓存 */ });
    } else {
      const hit = peekComment(title, artist, gen);
      if (hit) {
        comment = hit;
        commentState = 'ready';
      } else {
        const failed = peekCommentFail(title, artist);
        if (failed) {
          commentState = failed;
        } else {
          commentState = 'pending';
          generateComment({ title, artist, gen }).catch(() => { /* 失败会落到负缓存 */ });
        }
      }
    }
    /* 她看完这条评论说几句 —— 评论先到手才能评价，所以总比卡③ 正文慢一拍。
       原文已经在上面整段引着，这里只出她自己的看法，不再替她复述一遍。 */
    if (!cardComment) {
      replyState = 'off';
    } else if (comment && comment.text) {
      const hitReply = peekReply(title, artist, c, comment.text);
      if (hitReply) {
        reply = hitReply;
        replyState = 'ready';
      } else {
        replyState = 'pending';
        generateReply({
          title,
          artist,
          comment: comment.text,
          persona,
          cfg: c,
        }).catch(() => { /* 失败会落到负缓存 */ });
      }
    } else if (commentState === 'pending') {
      replyState = 'pending';
    } else {
      // 评论都拿不到（没评论 / 接口挂），评价也就无从谈起
      replyState = commentState;
    }
  } else {
    // 没在放就忘掉上一首，免得下次播同一首时误判成「没换歌」
    lastNowKey = '';
  }

  /* 卡④ 今天听点什么 —— 跟当前放的是哪首没关系，翻的是历史和每日推荐。
     30 分钟才重算一次，失败退避 20 分钟，别让面板每 3 秒去 spawn 一次子进程。 */
  let recommend = null;
  let recommendState = 'pending';
  let recommendError = '';
  if (!wxOn) {
    const hit = peekRecommend(c);
    if (hit) {
      recommend = hit;
      recommendState = 'ready';
    } else {
      const failed = peekRecommendFail(c);
      if (failed) {
        recommendState = failed.reason;
        recommendError = failed.error;
      } else {
        generateRecommend(c).catch(() => { /* 失败会落到负缓存 */ });
      }
    }
  } else {
    // 0.17.39：另一张卡是当前来源 → 这一路彻底不算，卡片显示「已停用」。
    recommendState = 'inactive';
  }

  // 0.17.45（B2）：进程探测改成异步，先 await 一次再拼快照（30 秒缓存，不会每帧起进程）
  const clientRunning = await clientProcessRunning();

  /* 0.17.51（用户口径）：天气卡要显示「自动播放会放的那一首」——
     和 pickWxSong 同口径：排除正在放的 / 当前 base / 已递出的 offer / 已挑好的 next，
     取顺位第一首。前端不再自己猜 items[0]。 */
  let wxNext = null;
  if (wxOn) {
    const ch = peekChain() || {};
    const ex = [
      playing ? title : '',
      (ch.base && ch.base.name) || '',
      (ch.offer && ch.offer.name) || '',
      (ch.next && ch.next.name) || '',
    ].filter(Boolean);
    const list = (wxSnap.items || []).filter((it) => it && it.name && !ex.some((e) => sameKey(e, it.name)));
    if (list[0]) wxNext = { name: list[0].name, artist: list[0].artist || '', id: list[0].id || '' };
  }

  return {
    ok: now.ok !== false,
    playing,
    // 0.17.17（用户口径）：面板抬头写「{她的名字}此刻在陪听」——
    // 名字取宿主给的这个字段（重命名后立刻跟上），取不到才退回「她」。
    herName: String((ctx && ctx.botName) || '').trim(),
    title,
    artist,
    app: now.app || '',
    source: now.source || 'none',
    /** 0.17.39：当前推荐来源（history / weather），前端据此禁用另一张卡。 */
    recoSource: src,
    // 0.16.42：没在放歌时，这三张卡说的是哪一首（前端用它写「先按《X》说」）
    preview: preview ? { title: preview.title, artist: preview.artist } : null,
    // 0.16.53：卡② 顶上那行「歌手《歌名》· 100 多万人喜欢」；读不到就给空串，前端不显示
    liked,
    // 0.16.44：三张卡各自的开关状态（前端要把「关掉的那张」写清楚，而不是留一句怪话）
    cards: { on: cardsOn, hear: cardHear, feel: cardFeel, comment: cardComment },
    error: now.error || '',
    // 进度读不到 —— 网易云既不上报 SMTC 进度，页面里也没有播放条。
    // 这里如实给 null，不要编一个数字出来。
    posSec: null,
    durSec: null,
    take: take ? { text: take.text, songId: take.songId || '', at: take.at } : null,
    takeState,
    like: like ? { line: like.line, feel: like.feel, verdict: like.verdict, at: like.at, persona: !!like.persona } : null,
    likeState,
    // 失败时的原始错误（云端 401/402 这类），前端在 model-error 时显示成一行小字
    takeError: title ? peekFailError(title, artist) : '',
    likeError: title ? peekLikeFailError(title, artist) : '',
    comment: comment
      ? { text: comment.text, likes: comment.likes, nick: comment.nick, total: comment.total || 0, at: comment.at }
      : null,
    commentState,
    reply: reply ? { text: reply.text, at: reply.at } : null,
    replyState,
    replyError: title ? peekReplyFailError(title, artist) : '',
    recommend: recommend
      ? {
        items: (recommend.items || []).map((it) => ({
          name: it.name,
          artist: it.artist,
          album: it.album || '',
          // 第 104.4 / 111 节：id 必须透出去 —— 前端播放靠 item.songId || item.id，
          // 以前在这里被剥掉，推荐点播只能退化成「靠歌名搜」，也是 fastplay.log 里 id=EMPTY 的根子。
          id: it.id || '',
          songId: it.id || '',
          durMs: Number(it.durMs) || 0,
          from: it.from || '',
          basis: it.basis ? { title: it.basis.title, sim: Number(it.basis.sim) || 0 } : null,
        })),
        historyCount: Number(recommend.historyCount) || 0,
        candidateCount: Number(recommend.candidateCount) || 0,
    poolSize: Number(recommend.poolSize) || 0,
        at: recommend.at,
        // 0.17.6：候选数据是什么时候从网易云拉下来的 —— 页面文案该显示这个，
        // 而不是「这批推荐什么时候算的」（重算会被打开页面/改勾/递歌触发，看着像打开时间）
        poolAt: Number(recommend.poolAt) || 0,
        dailyAt: Number(recommend.dailyAt) || 0,
      }
      : null,
    recommendState,
    recommendError,
    // 0.17.30：卡片5 —— 按天气挑的那几首（只取第一名那首是后端口径里的 TAKE=5 展示，
    // 首推仍是第一名；前端照卡①的版式画）
    // 0.17.43（B5）：pool（30 条接力顺位）只给服务端用，不进每帧快照 ——
    // 卡片只显示 2 条，每 3 秒回传 30 条纯浪费。
    wxReco: (() => {
      const { pool, ...pub } = wxSnap;
      return { ...pub, pool: [], next: wxNext };
    })(),
    // 0.17.39：当前来源（history / weather）—— 前端据此把另一张卡画成「已停用」
    // 她最近一次在安静时主动开的口（面板上显示成推荐卡下面的一行）
    idle: (() => {
      const it = peekIdle();
      if (!it) return null;
      // 「还在等他回应」只看有没有答过，不看时间 —— 他没点就说明人不在，一直挂着等（0.0.1.6.13）
      const ask = isIdleAsking();
      return {
        spoken: it.spoken,
        pick: it.pick ? { name: it.pick.name, artist: it.pick.artist || '', id: it.pick.id || '' } : null,
        at: it.at,
        asking: !!ask,
      };
    })(),
    // 已经安静多少秒（在放歌就是 0）—— 面板可以显示「还要多久她才会开口」
    idleSec: playing ? 0 : idleSecs(),
    // 网易云客户端在不在（0.0.1.6.34）。没开时她会「不开口、不接歌」，
    // 面板得说明这件事，否则用户看到的只是「怎么今天一句话都没有」。
    clientOpen: !!(lastAlive() && lastAlive().ok),
    // 0.16.42：进程在、只是没开调试端口时不能一口咬定「网易云没开」——用户截图那次的困惑就是这个
    clientRunning,
    // 「一直保持安静」（0.0.1.6.36）：她这会儿不主动开口，面板要写明，并且给一个「恢复」的入口
    quiet: peekQuiet(cfg),
    // 接力点歌：她递过来的下一首（播放中也会出现，这是它的主场景）
    chain: (() => {
      // 0.0.1.6.33：这块要跟「今天听点什么」走，不能一直挂着上一次真放歌时的旧歌
      // （用户实测《捕风》挂了一上午都没换）。0.16.58 起 syncOffer 只写 preview，
      // 不再冒充「接力进行中」，所以刷推荐也不会把接力状态洗掉。
      try {
        /* 0.17.39：预告（「我挑中了《X》」）必须来自**当前来源**。
           以前死取 peekRecommend：选了天气也会挂一首历史推荐的歌，
           于是面板说我挑中了 A、接力实际放的是 B。 */
        /* 0.16.61（用户第 12 条）：不能挂「正在放的」和「他刚点/她刚推的那首」。 */
        const st0 = peekChain() || {};
        const exclude = [
          playing ? title : '',
          (st0.base && st0.base.name) || '',
          // 第 147 节：已递出去（offer）/ 已挑好（next）的那首也要排掉，别让新预告正好挑成它
          (st0.offer && st0.offer.name) || '',
          (st0.next && st0.next.name) || '',
        ];
        /* 0.17.47：天气模式下「下一首」是**顺位第一首没被排除的**（见 pickWxSong），
           不是随机抽的。以前这里把 5 首全丢给 syncOffer 随机取，于是面板预告
           《冷夜》、实际会放《颜色》。现在只喂那一首。 */
        let rc;
        if (wxOn) {
          const list = (wxSnap.items || [])
            .filter((it) => it && it.name && !exclude.some((e) => e && sameKey(e, it.name)));
          rc = list.length ? { at: wxSnap.at || 0, items: list.slice(0, 1) } : null;
        } else {
          rc = peekRecommend(cfg);
        }
        if (rc && Array.isArray(rc.items) && rc.items.length) {
          // 第 125 节：拿「这一批推荐」的时间戳当种子 —— 同一批挑到同一首
          syncOffer(rc.items, { exclude, seed: rc.at });
        }
      } catch { /* 面板换不动也不该影响别的 */ }
      const of = displayOffer();
      if (!of || !of.name) return null;
      const st = peekChain() || {};
      return {
        name: of.name,
        artist: of.artist || '',
        id: of.id || '',
        count: Number(st.count) || 0,
        // 0.16.58：不再有「最多 6 首」，所以不给 max
        at: of.at || st.at,
        // 这是推荐刷出来的预告（不是接力真递的那首）
        idle: of.kind === 'preview',
        // 这一轮从哪首开始接的、来源是什么（面板上用来显示「接力已开始／还没接」
        origin: st.origin || '',
        baseName: (st.base && st.base.name) || '',
      };
    })(),
    // 第 128 节：点了「换一批」之后还有几秒才挑（>0 时面板显示「正在为你挑选歌曲中…」）
    pickWaitLeft: Math.ceil(pickWaitLeft() / 1000),
    // 第 131 节（用户口径）：接力点歌那块**只有三种状态**，后端一次算完，前端照着投影文字，
    // 不再让前端拿一堆字段自己拼条件（拼错过两次：v99 没显示「挑选中」、手动切歌没显示「已停止」）。
    //
    //   picking → 「正在为你挑选歌曲中…」
    //   picked  → 「我挑中了《X》」
    //   stopped → 「接力点歌已停止」
    //
    // 判定顺序也是固定的：正在挑 > 挑出来了 > 已停止。谁在前谁说话，不会两头抢。
    //     判定本身在 `chain.js` 的 `chainStateOf()` 里（纯函数、可自测），这里只负责取数据。
    chainState: chainStateOf({
      chain: peekChain() || {},
      offer: displayOffer(),
      waitMs: pickWaitLeft(),
    }),
    // 0.16.58：这一轮接力是从哪首开始的（点中推荐那首之后，面板要立刻给一句提示，不出声）
    chainRound: (() => {
      const st = peekChain();
      if (!st || st.origin !== 'her-offer' || !st.base || !st.base.name) return null;
      return {
        baseName: st.base.name,
        count: Number(st.count) || 0,
        at: st.at,
      };
    })(),
    // 0.16.58：播报出去了却没放成的那首（面板要显眼地写出来，别只在语音里说一句）
    chainFail: (() => {
      const st = peekChain();
      if (!st || !st.fail || !st.fail.name) return null;
      if (Date.now() - Number(st.fail.at || 0) > 10 * 60 * 1000) return null;
      return String(st.fail.name);
    })(),
    wants: readWants(10),
    wantTotal: wantCount(),
    config: {
      playlistId: pid,
      playlistName: DEFAULT_PLAYLIST,
      port: Number((cfg && cfg.cdpPort) || 9229),
    },
    at: Date.now(),
  };
}

/**
 * 「点一下这首歌」的公共实现 —— 榜单面板和「此刻」页的推荐卡共用。
 * 实现搬到了 src\play.js（0.0.1.6.12：连播也要用它），这里只留个薄壳，
 * 走的是「用户自己点的」那条口径（进点歌次数）。
 *
 * 0.16.58 起这里还要判断**这一轮准不准接力**；0.16.62 起多传一个 `fromPanel`
 * （`'now'` 此刻页 / `'rank'` 点歌排名页）。
 *
 * **0.16.65 改了口径**：起点只看**从哪一页点的**，不再拿歌名去推荐清单里反查。
 *   - 1 号窗口（`now` 此刻页，就是推荐那一页）点的任何一首 → `'her-offer'`，
 *     立即立一轮，接力闸进入「装填中」，等这首真落到播放条上就开始盯进度；
 *   - 其他页（`'rank'` 等）→ `'user-ask'`，不接力、走默认歌单（默认歌单永不删）。
 * 反查靠不住：推荐清单每 30 分钟重算、面板每 3 秒同步，清单里一刷新就对不上了。
 * 目标歌单仍由 `fromPanel` + `chainPlaylist` 那个勾一起决定，规则收在 `src\recoPick.js`。
 */
const playTrack = async (c, a, fromPanel) => {
  try {
    // 0.16.65：起点只看「从哪一页点的」——用户 0.16.64 提的就这条：
    // 1 号窗口（此刻页 `now`，就是推荐那一页）点的歌 → 立刻立一轮 `her-offer`，
    // 接力闸随即进入「装填中」，等这首真的落到播放条上就开始盯进度，不用再读时间猜。
    // 其他页（点歌排名 `rank` 等）→ `user-ask`，不接力，走默认歌单。
    // 以前是拿歌名去推荐清单里反查 —— 反查靠不住：清单每 30 分钟重算，歌名还可能带后缀。
    const origin = fromPanel === 'now' ? 'her-offer' : 'user-ask';
    // 0.17.33：前端会把「这次点的是哪张卡」的 source 带上来（reco 卡① / wx 卡片5）。
    // 只决定这一轮播报垫什么；自动接力挑哪一路看设置里的 chainSource。
    // 0.17.43（A1）：这里仍要先立一轮 —— 快/慢路径 1.4~10 秒里播放条还是上一首，
    // 不先挂 pending 的话闸门会把它判成「他切歌了」。但**失败要回滚**（见下面）。
    markOrigin(origin, a && (a.title || a.name) ? { name: a.title || a.name, artist: a.artist || '' } : null, a && a.source);
    // 0.17.43（A8）：面板点歌也是用户动作
    markUserAction('play', String((a && (a.title || a.name)) || '').slice(0, 80));
  } catch { /* 标记失败就当 user-ask，宁可不接也不乱接 */ }
  // 0.16.62：推荐页 + 勾着「接力点歌歌单」→ 目标歌单换成「AI 推荐歌单」（二选一，不叠加默认歌单）
  /* 0.17.44（用户口径）：**此刻页点的不算「用户点歌」** —— 那是接受她的推荐（和接力同性质），
     不进点歌次数、不进「我喜欢的音乐」；只有「点歌排名」页点击、或工具里用户明确点了歌名才记。 */
  const by = fromPanel === 'now' ? 'auto' : 'user';
  const r = await playSong(applyPick(c, fromPanel), a, by);
  /* 0.17.43（A1）：点歌没成 → 把刚才立的那一轮收掉。
     以前失败也留着 `her-offer` + pending，面板就显示「接力从《X》开始」，
     而实际上什么都没放 —— 用户以为接力在跑，下一轮还会按错的前提接歌。 */
  if (!r || r.ok === false) {
    try {
      saveChain({ pending: null, next: null, nextAt: 0, offer: null, offeredBaseKey: '', fail: null });
      markClosed('play-failed');
    } catch { /* 收不掉也不影响这次返回 */ }
  }
  return r;
};

export async function panelInvoke(cfg, panel, method, args, ctx, worldIn) {
  // 宿主协议要求 args 必须是 JSON 数组（传对象会被它直接拒掉：「args 必须是 JSON 数组」）。
  // 我们所有方法都只取一个参数对象，所以统一拿数组第 0 项；也兼容直接传对象的老调用。
  const list = Array.isArray(args) ? args : [args];
  const raw = list.length > 0 ? list[0] : undefined;
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const c = cfg || {};

  // 0.0.1.6.38：「先安静着」是临时开关 —— 他在面板上按任何东西都算「有动作」，
  // 就解除。轮询用的 snapshot / refresh 不算。
  if (panel === 'now' && method !== 'snapshot' && method !== 'refresh') {
    clearQuiet(`panel:${method}`);
    // 0.17.43（A8）：记一条面板动作（'panel' 不在拦截名单里，只记不改行为）
    markUserAction('panel', String(method || ''));
  }

  if (panel === 'rank') {
    if (method === 'snapshot') {
      return rankSnapshot({
        rankTracks: Number(a.rankTracks) > 0 ? Number(a.rankTracks) : 100,
        rankArtists: Number(a.rankArtists) > 0 ? Number(a.rankArtists) : 30,
      });
    }
    // 榜单上点歌名就播那一首 —— 实现见 playTrack()，跟「此刻」页的推荐卡是同一套。
    if (method === 'play') return playTrack(c, a, panel);
    return { error: `rank 没有 ${method} 这个方法` };
  }

  // 「模型」页签：本机 / 云端开关、云端地址、Key（密文）、模型清单。
  // 为什么单独做一页，见 src/cloudpanel.js 开头那段。
  if (panel === 'model') {
    if (method === 'snapshot') return { ...cloudPanelSnapshot(c), about: aboutInfo(ctx), weather: weatherSnapshot(c) };
    if (method === 'set') return settingsSet(ctx, c, a);
    if (method === 'weatherNow') return weatherNow(c, { force: a.force === true });
    /* 0.17.43（D2，用户口径）：「天气面板只看缓存，另给一个刷新按钮，点了才去抓远端，
       抓完把成功/失败写回文字。」这个入口只给那个按钮用，不参与自动刷新。 */
    if (method === 'weatherFetch') {
      return fetchWeather(c)
        .then((r) => ({ ok: !!(r && r.ok), error: String((r && r.error) || ''), at: Date.now() }))
        .catch((e) => ({ ok: false, error: String((e && e.message) || e), at: Date.now() }));
    }
    if (method === 'setSource') return cloudPanelSetSource(ctx, c, a.source);
    if (method === 'saveCloud') return cloudPanelSave(ctx, c, a);
    if (method === 'listModels') return cloudPanelList(ctx, c, a);
    return { error: `model 没有 ${method} 这个方法` };
  }

  // 「设置」页签（0.16.50）：四张折叠卡的开关全在这一页里读写，宿主设置页那份先留着。
  if (panel === 'settings') {
    if (method === 'snapshot') return settingsSnapshot(c, ctx && ctx.language, ctx);
    if (method === 'set') return settingsSet(ctx, c, a);
    if (method === 'setMany') return settingsSetMany(ctx, c, a.items);
    return { error: `settings 没有 ${method} 这个方法` };
  }

  if (panel === 'now') {
    if (method === 'snapshot') return nowSnapshot(cfg, ctx);
    if (method === 'refresh') return nowSnapshot(cfg, ctx);
    // 「今天听点什么」卡上点歌名 / 点「像《X》」就直接播 —— 同一套实现，也记点歌次数。
    if (method === 'play') {
      const job = playTrack(c, a, panel);
      /* 0.17.39：天气卡点歌 → 只把这首从当前名单划掉并补位（O(30)），
         不再整批重算（那要模型写一句 + 100 条向量，点一下机器转几秒）。 */
      if (isWeatherActive(c) && String(a.source || '') === 'wx') {
        try { dropWxSong(a.title || a.name); } catch { /* 划不掉不影响播放 */ }
      }
      return job;
    }
    // 确认条：她问「要我帮你放吗」之后按「是 / 否」（30 秒不按等于否，倒计时在前端走）
    if (method === 'answerIdle') {
      const world = worldIn || (ctx && ctx.world);
      if (!world || typeof world.answerIdle !== 'function') return { ok: false, error: '世界还没就绪' };
      return world.answerIdle(a.yes !== false);
    }
    // 0.17.30：卡片5「按天气听点什么」的「换一批」/ 点了里面的歌之后的重新计算
    // 0.17.35：改成后台排队 2.5 秒再算 —— 不立刻查天气（吃 qwInterval 那份缓存），
    // 先等一小段再出结果；连续点几下只算最后一次，面板期间照旧显示上一批。
    if (method === 'wxRecoRefresh') {
      // 0.17.39：来源不是天气 → 这张卡已经「已停用」，不许再把它叫醒。
      if (!isWeatherActive(c)) return { ok: false, reason: 'inactive' };
      return scheduleWxReco(c, { delayMs: Number(a.delayMs) > 0 ? Number(a.delayMs) : 2500 });
    }
    // 「重新推荐」按钮：AI 也能通过 netease_reco_refresh 触发同一条
    if (method === 'recoRefresh') {
      // 0.17.39：来源不是历史 → 同上。
      if (!isHistoryActive(c)) return { ok: false, reason: 'inactive', count: 0, items: [] };
      const world = worldIn || (ctx && ctx.world);
      if (!world || typeof world.recoRefresh !== 'function') return { ok: false, error: '世界还没就绪' };
      return world.recoRefresh();
    }
    // 「一直保持安静」的开关（0.0.1.6.36）：他在气泡里选了第二条 / 点了叉以后，
    // 面板上要能看见这件事，也得能一句话放开。
    if (method === 'quietSet') {
      const on = a.on !== false;
      setQuietForever(on);
      return { ok: true, quiet: peekQuiet(c) };
    }
    if (method === 'clearWants') return { ok: clearWants(), wants: readWants(10), wantTotal: wantCount() };
    // 面板上手动记一首想听的。歌名 + 歌手（可选），重复的不会再加。
    if (method === 'addWant') {
      const name = String(a.name || '').trim();
      if (!name) return { ok: false, error: '没给歌名', wants: readWants(10), wantTotal: wantCount() };
      const r = addWant({ name, artist: String(a.artist || '').trim(), why: '面板手记' });
      return { ok: r.added !== false, added: r.added, error: r.error, wants: readWants(10), wantTotal: wantCount() };
    }
    return { error: `now 没有 ${method} 这个方法` };
  }

  return { error: `未知面板 ${panel}` };
}

// 0.17.30：weatherNow 挪到 src/qweather.js（此刻页的天气推荐也用它）


