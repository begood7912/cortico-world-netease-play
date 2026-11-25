/**
 * 网易云陪听 · 面板前端（两个页签）。
 *
 * 契约：默认导出 { panels: { <id>: { mount(ctx) } } }。
 *   ctx.root    唯一挂载点
 *   ctx.ui      宿主组件库
 *   ctx.invoke  打到 World 的 panelInvoke
 *   ctx.interval 宿主管的定时器 —— **不要用裸 setInterval**，切页时宿主清不掉
 *
 * 几个已经踩过的坑，改的时候别踩回去：
 *   1. sheet / segmented / table 返回 {el,...}；button / chip / msgline / statgrid
 *      返回的是**元素本身**，没有 .el。
 *   2. button 的样式参数叫 variant（'plain' | 'primary' | 'danger'），不叫 tone。
 *   3. 默认口径是「按听歌次数」，选择用 localStorage 记住，不再每次跳回去。
 */

const PREFS_KEY = 'netease-play.rank';

/** 读上次选的口径；读不到就用默认（听歌次数）。 */
function loadPrefs() {
  const fallback = { view: 'tracks', metric: 'listen' };
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const j = JSON.parse(raw);
    return {
      view: j.view === 'artists' ? 'artists' : 'tracks',
      metric: j.metric === 'request' ? 'request' : 'listen',
    };
  } catch {
    return fallback;
  }
}

function savePrefs(p) {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式 / 配额满了：记不住就算了，不该影响点击 */
  }
}

export default {
  panels: {
    rank: {
      mount(ctx) {
        const ui = ctx.ui;
        const zh = String(ctx.language ?? 'zh').toLowerCase().startsWith('zh');
        const prefs = loadPrefs();
        let view = prefs.view;        // tracks | artists
        let metric = prefs.metric;    // request | listen
        let last = null;
        let draw = () => {};
        let busyPlay = false;
        /** 0.16.63：起播途中被点掉的那一下，排队等这一趟结束再补。 */
        let pendingPlay = null;

        const statsHost = ui.h('div');
        const note = ui.msgline('');

        const tabs = ui.segmented([
          { value: 'tracks', label: zh ? '歌曲榜' : 'Songs' },
          { value: 'artists', label: zh ? '歌手榜' : 'Artists' },
        ], {
          value: view,
          size: 'sm',
          onSelect: (value) => { view = value; savePrefs({ view, metric }); if (last) draw(last); },
        });

        const metrics = ui.segmented([
          { value: 'request', label: zh ? '按点歌次数' : 'By requests' },
          { value: 'listen', label: zh ? '按听歌次数' : 'By listens' },
        ], {
          value: metric,
          size: 'sm',
          onSelect: (value) => { metric = value; savePrefs({ view, metric }); if (last) draw(last); },
        });

        const bar = ui.rowbar();
        bar.append(tabs.el, metrics.el);

        const podiumHost = ui.h('div');

        // 四张表：歌曲×2 / 歌手×2。列头不同只能建两份。
        const tSongReq = ui.table({
          head: zh ? ['#', '歌曲', '歌手', '点歌', '最近'] : ['#', 'Song', 'Artist', 'Requests', 'Last'],
          maxHeight: '38vh',
        });
        const tSongListen = ui.table({
          head: zh ? ['#', '歌曲', '歌手', '听歌', '时长'] : ['#', 'Song', 'Artist', 'Listens', 'Time'],
          maxHeight: '38vh',
        });
        const tArtistReq = ui.table({
          head: zh ? ['#', '歌手', '点歌', '曲目', '最近'] : ['#', 'Artist', 'Requests', 'Tracks', 'Last'],
          maxHeight: '30vh',
        });
        const tArtistListen = ui.table({
          head: zh ? ['#', '歌手', '听歌', '曲目', '最近'] : ['#', 'Artist', 'Listens', 'Tracks', 'Last'],
          maxHeight: '30vh',
        });

        const section = ui.section(
          zh ? '榜单' : 'Ranking',
          zh ? '点歌名就放那一首；前三名单独展示，第 4 名起进表格' : 'Click a title to play it. Top 3 highlighted.',
        );
        section.append(podiumHost, tSongReq.el, tSongListen.el, tArtistReq.el, tArtistListen.el);

        ctx.root.append(statsHost, bar, section, note);

        const date = (v) => {
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString();
        };

        const dur = (sec) => {
          const n = Math.max(0, Math.round(Number(sec) || 0));
          if (n < 60) return `${n} ${zh ? '秒' : 's'}`;
          const h = Math.floor(n / 3600);
          const m = Math.floor((n % 3600) / 60);
          if (!h) return `${m} ${zh ? '分' : 'm'}`;
          return `${h} ${zh ? '小时' : 'h'} ${m} ${zh ? '分' : 'm'}`;
        };

        const current = (s) => {
          if (view === 'tracks') return metric === 'request' ? (s.tracks || []) : (s.tracksByListen || []);
          return metric === 'request' ? (s.artists || []) : (s.artistsByListen || []);
        };

        /** 歌名 → 可点的按钮（表格里用）。 */
        const playBtn = (item) => {
          const btn = ui.button(item.title, {
            variant: 'plain',
            size: 'sm',
            onClick: () => void play(item, btn),
          });
          btn.title = zh
            ? `点播《${item.title}》${item.artist ? ` — ${item.artist}` : ''}（会记一次点歌）`
            : `Play ${item.title}`;
          return btn;
        };

        /**
         * 前三名的卡片：整张卡都能点，不指望用户点中那行标题。
         * 手型光标走内联样式 —— 万一 webUiStyle 没被注入，也还能看出能点。
         */
        const clickableCard = (card, item) => {
          const h3 = card.el.querySelector('h3');
          card.el.classList.add('np-clickable');
          card.el.style.cursor = 'pointer';
          const why = zh
            ? `点一下播这首《${item.title}》${item.artist ? ` — ${item.artist}` : ''}（会记一次点歌）`
            : `Play ${item.title}`;
          card.el.title = why;
          if (h3) {
            h3.style.cursor = 'pointer';
            // 给个看得见的提示，否则没人知道这里能点
            h3.appendChild(ui.h('span', 'np-play-hint', zh ? '▷ 播放' : '▷ play'));
          }
          card.el.addEventListener('click', () => void play(item, card.el));
        };

        const play = async (item, target) => {
          // 0.16.63：起播途中又点了一下，不能静默丢掉。
          // 点一首不在当前歌单页的歌要「切歌单页 + 顶歌 + 双击」，实测 1.4 秒左右，
          // 这期间再点一下会被 `busyPlay` 直接 return，看起来就是「点了两次才播」。改成排队一次。
          if (busyPlay) { pendingPlay = { item, target }; return; }
          busyPlay = true;
          target.classList.add('np-busy');
          // 快路径通常 0.4 秒就回来了，正常情况下这个字都来不及看清；
          // 只有歌不在当前列表、要走搜歌那套时才会停在这儿几秒，那就必须有个交代。
          const hint = target.querySelector('.np-play-hint');
          const hintText = hint ? hint.textContent : '';
          if (hint) hint.textContent = zh ? '▷ 起播中…' : '▷ starting…';
          try {
            // args 必须是 JSON 数组（宿主协议要求），参数对象放第 0 项
            // songId 有就用，没有退回 id —— 推荐项存的是 `id`，早先这里只认 `songId`，
            // 结果每次都白跑一次搜索（实测多花 0.3 秒）。
            const r = await ctx.invoke('play', [{
              title: item.title,
              artist: item.artist,
              songId: item.songId || item.id,
            }]);
            ui.toast(r.message || (r.ok ? (zh ? '已开始播放' : 'Playing') : (zh ? '播放失败' : 'Failed')), r.ok ? 'ok' : 'bad');
            if (r.ok) void tick();
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e), 'bad');
          } finally {
            busyPlay = false;
            target.classList.remove('np-busy');
            if (hint) hint.textContent = hintText;
            // 起播途中被点掉的那一下，等这一趟结束立刻补上（只补一次，不叠）
            const p = pendingPlay;
            pendingPlay = null;
            if (p && p.item) void play(p.item, p.target);
          }
        };

        const podium = (items, nameOf, descOf, countOf, unit) => {
          podiumHost.replaceChildren();
          if (!items.length) {
            const empty = metric === 'listen'
              ? (zh ? '还没有听歌记录 —— 采集器要放着歌才会记。' : 'No listening data yet.')
              : (zh ? '还没有点歌记录。' : 'No request records yet.');
            podiumHost.append(ui.msgline(empty));
            return;
          }
          const host = ui.statgrid();
          for (const item of items.slice(0, 3)) {
            const card = ui.sheet({ title: `#${item.rank} ${nameOf(item)}`, desc: descOf(item) });
            card.body.append(ui.stat({
              k: metric === 'request' ? (zh ? '点歌' : 'Requests') : (zh ? '听歌' : 'Listens'),
              v: countOf(item),
              unit,
              accent: item.rank === 1,
            }));
            // 只有歌曲卡片能点播（歌手不是单曲）
            if (view === 'tracks') clickableCard(card, item);
            host.append(card.el);
          }
          podiumHost.append(host);
        };

        const fill = (table, items, cells) => {
          table.clear(items.length === 0
            ? (zh ? '暂无' : 'None')
            : items.length <= 3
              ? (zh ? '没有更多名次' : 'No more ranks')
              : (zh ? '前三名已在上方展示' : 'Top 3 shown above'));
          for (const item of items.slice(3)) {
            table.addRow([ui.chip(String(item.rank), 'plain'), ...cells(item)]);
          }
        };

        const showTables = () => {
          const songsMode = view === 'tracks';
          tSongReq.el.hidden = !(songsMode && metric === 'request');
          tSongListen.el.hidden = !(songsMode && metric === 'listen');
          tArtistReq.el.hidden = !(!songsMode && metric === 'request');
          tArtistListen.el.hidden = !(!songsMode && metric === 'listen');
        };

        draw = (s) => {
          last = s;
          const limits = s.limits || { rankTracks: 0, rankArtists: 0 };

          statsHost.replaceChildren(ui.statgrid([
            {
              k: zh ? '总点歌' : 'Total requests',
              v: s.totalRequests ?? 0,
              unit: zh ? '次' : '',
              accent: metric === 'request',
            },
            {
              k: zh ? '总听歌' : 'Total listens',
              v: s.totalListens ?? 0,
              unit: zh ? `次 · ${dur(s.totalListenSec)}` : '',
              accent: metric === 'listen',
            },
            { k: zh ? '收录歌曲' : 'Songs', v: s.storedTracks ?? 0, unit: zh ? '首' : '' },
            {
              k: zh ? '收录歌手' : 'Artists',
              v: s.storedArtists ?? 0,
              unit: `· ${limits.rankTracks}${zh ? '首' : ''}`,
            },
          ]));

          showTables();
          const items = current(s);

          if (view === 'tracks') {
            podium(
              items,
              (t) => t.title,
              (t) => `${t.artist || '-'} · ${date(metric === 'request' ? t.lastAt : (t.lastListenAt || t.lastAt))}`,
              (t) => (metric === 'request' ? t.count : t.listens),
              zh ? '次' : '',
            );
            fill(tSongReq, s.tracks || [], (t) => [playBtn(t), t.artist || '-', t.count, date(t.lastAt)]);
            fill(tSongListen, (s.tracksByListen || []), (t) => [playBtn(t), t.artist || '-', t.listens, dur(t.listenSec)]);
          } else {
            podium(
              items,
              (a) => a.name,
              (a) => `${date(a.lastAt)} · ${a.tracks ?? 0} ${zh ? '首' : 'songs'}`,
              (a) => (metric === 'request' ? a.count : a.listens),
              zh ? '次' : '',
            );
            fill(tArtistReq, s.artists || [], (a) => [a.name, a.count, a.tracks ?? 0, date(a.lastAt)]);
            fill(tArtistListen, (s.artistsByListen || []), (a) => [a.name, a.listens, a.tracks ?? 0, date(a.lastAt)]);
          }

          if (s.status === 'unavailable') {
            note.classList.add('bad');
            note.textContent = zh
              ? `读不到点歌账本${s.error ? `：${s.error}` : ''}`
              : 'Ledger unavailable';
            return;
          }
          note.classList.remove('bad');
          note.textContent = zh
            ? `点歌 ${s.totalRequests ?? 0} 次 · 听歌 ${s.totalListens ?? 0} 次（${dur(s.totalListenSec)}）· 点歌名即点播 · 更新于 ${new Date().toLocaleTimeString()}`
            : `${s.totalRequests ?? 0} requests · ${s.totalListens ?? 0} listens · updated ${new Date().toLocaleTimeString()}`;
        };

        async function tick() {
          try {
            draw(await ctx.invoke('snapshot', [{}]));
          } catch (e) {
            note.classList.add('bad');
            note.textContent = e instanceof Error ? e.message : String(e);
          }
        }

        void tick();
        ctx.interval(() => void tick(), 5000);
      },
    },

    now: {
      mount(ctx) {
        // 这一页照抄「一起听歌」的「她此刻」：头部（在放什么 + 进度条）+ 三块卡。
        // 那边是手写 DOM 配自己的 CSS，宿主组件库的 statgrid 做不出这个版式，所以这里也手写。
        // 类名用 np- 前缀，不跟一起听歌的 mu- 撞。
        const doc = ctx.root.ownerDocument ?? document;
        const zh = String(ctx.language ?? 'zh').toLowerCase().startsWith('zh');

        const el = (tag, cls, text) => {
          const node = doc.createElement(tag);
          if (cls) node.className = cls;
          if (text !== undefined && text !== null) node.textContent = text;
          return node;
        };

        // 赞数、评论总数都格式化：572961 → 57.3万，113820 → 11.4万
        const fmtLikes = (n) => {
          const v = Number(n) || 0;
          if (v >= 100000000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
          if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
          return String(v);
        };

        const t = zh
          ? {
            eyebrow: '此刻在陪听',
            notPlaying: '没在放',
            playerOff: '播放器没连上',
            previewSub: (name) => `先按《${name}》说她怎么听 —— 放起来就换成真在放的那首`,
            howSheHears: '她听这首歌时',
            cardOff: '打开单独开关就显示内容',
            bodyOff: '正文那句在设置里关掉了 —— 只显示顶上的人数',
            herTake: '她听完什么感觉',
            notSaid: '还没说过',
            notSaidWhy: '她听着的时候自己会说 —— 顺便标一句就有了，不用你替她判断。',
            likeYes: '喜欢',
            likeMeh: '一般',
            likeNo: '不喜欢',
            judging: '她在听那句…',
            othersSay: '别人怎么说',
            readingComments: '在翻评论…',
            noComment: '没找到这首歌的评论',
            commentFail: '评论暂时读不到',
            commentTotal: (n) => `一共 ${n} 条评论`,
            herReply: '她听完说',
            replyThinking: '她在想怎么回…',
            replyFail: '她没说出什么',
            recTitle: '今天听点什么',
            recHint: (n) => `按你听过的 ${n} 首算的，从今日推荐里挑`,
            recBasis: (title) => `像《${title}》`,
            recPending: '在算…',
            recNoDaily: '读不到今日推荐（客户端没开？）',
            recNoHistory: '还没听够，再听会儿就来',
            recNoEmbed: '向量模型没接上',
            recNoCandidate: '今日推荐里没有没听过的',
            recFail: '暂时算不出来',
            idleLabel: '她刚才开口：',
            idlePlay: (name) => `就放《${name}》`,
            idleHint: (sec) => {
              // 超过一分钟就按分钟说，别让它显示「已经安静 1874 秒」
              const s = Number(sec) || 0;
              return s >= 60 ? `没在放歌，已经安静 ${Math.round(s / 60)} 分钟` : `没在放歌，已经安静 ${s} 秒`;
            },
            chainLabel: '接力点歌',
            chainModeHistory: '接力点歌开启（听歌历史）',
            chainModeWeather: '天气点歌已开启',
            chainSay: (name) => `我挑中了《${name}》`,
            // 第 128 节：换了歌单之后先晾 10 秒，这段时间只显示这句
            chainPicking: '正在为你挑选歌曲中…',
            // 第 131 节：接力收场（你换歌了 / 放的已经不是那首了）
            chainStopped: '自动点歌已停止',
            // 0.17.39：来源开关选了另一张卡 → 这张卡停用
            inactive: '已停用（跟随设置里的「接力按哪张卡挑」）',
            chainWait: '报完歌名她自己就放，不用你点',
            // 0.16.58：不再有「最多 6 首」，所以只报接到第几首
            chainCount: (n) => `已经接下第 ${n} 首`,
            chainStarted: (name) => `接力从《${name}》开始，这首快放完时她接下一首`,
            chainPreview: '等你点了推荐里那首，就从那儿往下接',
            chainFailed: (name) => `《${name}》没放上`,
            chainNoChain: '这首是你自己让她放的 —— 不接力',
            clientOff: '网易云没开 —— 只有真要放歌的时候她才会去打开它',
            clientNoPort: '网易云开着，但没开调试端口（9229 连不上）—— 她这会儿放不了歌，重启一下客户端就恢复',
            quietOn: '她先安静着 —— 你下次操作、或者重启她，就恢复正常',
            quietOff: '让她现在就开口',
            askYes: '是，帮我放',
            askNo: '不用了',
            askWait: '不点就等着，你回来再定',
            recoAgain: '换一批',
            recoAgainBusy: '正在随机挑选歌曲中…',
            wantsTitle: '她想听什么',
            noWants: '暂时没有。她自己搜到喜欢的会记下来。',
            wantCount: (n) => `一共 ${n} 首`,
            clear: '清空',
            add: '记一首',
            addHint: '歌名',
            hearing: '她在听…',
            noModel: '设置页里没选生成模型',
            noLyric: '这首歌没歌词，或者拿不到',
            takeFail: '她没说得出话',
            refreshNote: '每 3 秒读一次',
          }
          : {
            eyebrow: 'Her now',
            notPlaying: 'Nothing playing',
            playerOff: "Player not connected",
            previewSub: (name) => `Hearing "${name}" ahead of time — switches to the real track once music starts`,
            howSheHears: '② When she hears it',
            cardOff: 'Turn on its switch in settings to show content',
            bodyOff: 'The body line is switched off — only the like count shows',
            herTake: 'What it felt like',
            notSaid: 'Not said yet',
            notSaidWhy: 'She says it herself while listening — she tags it, you do not decide for her.',
            wantsTitle: 'What she wants to hear',
            noWants: 'Nothing yet. She notes down what she finds and likes.',
            wantCount: (n) => `${n} songs`,
            clear: 'Clear',
            add: 'Add',
            addHint: 'Song name',
            hearing: 'She is listening…',
            likeYes: 'Likes it',
            likeMeh: 'Somewhere in between',
            likeNo: "Doesn't like it",
            judging: 'Hearing the line…',
            othersSay: 'What others say',
            readingComments: 'Reading the comments…',
            noComment: 'No comments found for this song',
            commentFail: 'Comments are not readable right now',
            commentTotal: (n) => `${n} comments in all`,
            herReply: 'She says',
            replyThinking: 'Thinking of something to say…',
            replyFail: 'She could not say anything',
            recTitle: 'What to play next',
            recHint: (n) => `From today's picks, ranked by the ${n} songs you have listened to`,
            recBasis: (title) => `Like “${title}”`,
            recPending: 'Working it out…',
            recNoDaily: 'Cannot read today’s picks (player closed?)',
            recNoHistory: 'Not enough listening history yet',
            recNoEmbed: 'No embedding model selected',
            recNoCandidate: 'Nothing new in today’s picks',
            recFail: 'Could not work it out right now',
            idleLabel: 'She just said:',
            idlePlay: (name) => `Play “${name}”`,
            idleHint: (sec) => {
              const s = Number(sec) || 0;
              return s >= 60 ? `Nothing playing, quiet for ${Math.round(s / 60)} min` : `Nothing playing, quiet for ${s}s`;
            },
            chainLabel: 'Next up',
            chainModeHistory: 'Chain on (listening history)',
            chainModeWeather: 'Weather picks on',
            chainSay: (name) => `I picked “${name}”`,
            chainPicking: 'Picking something for you…',
            chainStopped: 'Auto pick stopped',
            inactive: 'Off (follows the source switch in settings)',
            chainWait: 'She plays it herself after saying the name',
            chainCount: (n, max) => `${n}/${max}`,
            clientOff: 'NetEase is closed — she only opens it when she is actually about to play',
            clientNoPort: 'NetEase is running but the debug port (9229) is closed — she cannot play until the client is restarted',
            quietOn: 'She is staying quiet — she will speak up again after your next action or a restart',
            quietOff: 'Let her speak now',
            askYes: 'Yes, play it',
            askNo: 'Not now',
            askWait: 'Waiting — decide when you are back',
            recoAgain: 'Shuffle',
            recoAgainBusy: 'Picking random songs…',
            noModel: 'No chat model selected in settings',
            noLyric: 'No lyrics for this song',
            takeFail: 'She did not manage to say anything',
            refreshNote: 'Refreshed every 3s',
          };

        const app = el('div', 'np-panel');
        ctx.root.append(app);

        /* ---------------- 头部：在放什么 ---------------- */
        const head = el('header', 'np-head');
        // 抬头写谁在陪听 —— 名字来自宿主快照的 herName（s.herName），每 5 秒刷一次，
        // 在 Coopanion 里改了名字这里立刻跟上；取不到就退回「她」。
        const eyebrow = el('p', 'np-eyebrow', '');
        const title = el('h1', 'np-title', '—');
        // 歌手放同一行、跟在歌名后面 —— 一行读完，不占两行高度
        const sub = el('span', 'np-sub', '');
        const line = el('div', 'np-line');
        line.append(title, sub);
        head.append(eyebrow, line);

        /* ---------------- 三块卡 ---------------- */
        const hearCard = el('section', 'np-card');
        const takeCard = el('section', 'np-card');
        const commentCard = el('section', 'np-card');
        const cards = el('div', 'np-cols');
        cards.append(hearCard, takeCard, commentCard);

        /* 卡①「今天听点什么」——跨整行，放在最上面（用户要的顺序：先看推荐，再看这一首的解读） */
        const recCard = el('section', 'np-card np-card-wide');
        /* 0.17.30：卡片5「按天气听点什么」——版式照卡①，位置在卡①下面、下面三张卡上面。
           歌从哪来：实时天气压成一句话 → 向量比相似度 → 取第一名（用户口径：只选第一首）。 */
        const wxCard = el('section', 'np-card np-card-wide');

        // 卡③「别人怎么说」：一条热评 + 谁说的 + 多少赞。不需要输入行 ——
        // 3 秒重绘会整块重画，这里没有要保留输入状态的东西。

        const foot = el('footer', 'np-foot', '');
        app.append(head, recCard, wxCard, cards, foot);

        /**
         * 推荐卡上的歌点一下就播 —— 走 now 面板的 play 方法（跟榜单同一套实现：
         * 歌在列表里就 0.4 秒双击起播，不在就走搜歌排单那条慢链路）。
         * 推荐项带着 songId，点的是哪一版就播哪一版；「像《X》」那首只有歌名+歌手。
         */
        let busyPlay = false;
        /** 0.16.63：起播途中被点掉的那一下，排队等这一趟结束再补。 */
        let pendingPlay = null;
        /**
         * 0.17.39：这一页一直没声明 `ui` —— 下面 9 处 `ui.toast` 全是 ReferenceError。
         * 后果：点歌成功后先抛错，`if (r.ok) { tick(); … }` 再也走不到 →
         * 没有提示、不立即刷新，天气卡点歌后那句重算也从来没执行过。
         */
        const ui = ctx.ui;

        let sentKey = '';
        const playOne = async (item, target, source) => {
          const key = `${item.title || item.name || ''}|${item.artist || ''}`.toLowerCase();
          /* 0.17.43（A2，用户口径）：命令已经发出去了，再点**同一个标签**只做动作、不再发命令。
             以前这里会 `pendingPlay` 排队，等到这一趟结束再补放一次 —— 点两下等于放两遍。
             不同标签仍然排队（那是"我改主意了"，该放新的）。 */
          if (busyPlay) {
            if (key === sentKey) {
              target.classList.add('np-busy');
              setTimeout(() => target.classList.remove('np-busy'), 400);
              return;
            }
            pendingPlay = { item, target, source };
            return;
          }
          busyPlay = true;
          sentKey = key;
          target.classList.add('np-busy');
          try {
            // args 必须是 JSON 数组（宿主协议），参数对象放第 0 项
            // songId 没有就退回 id（推荐项里存的是 `id`），否则每次点歌都白跑一次搜索
            const r = await ctx.invoke('play', [{
              title: item.title,
              artist: item.artist,
              songId: item.songId || item.id,
              // 0.17.33：这次点的是哪张卡（'reco' 卡① / 'wx' 卡片5）—— 后端只拿它记这一轮
              // 的播报口径，自动接力挑哪一路仍按设置里的二选一开关。
              source: source || '',
            }]);
            ui.toast(r.message || (r.ok ? (zh ? '已开始播放' : 'Playing') : (zh ? '播放失败' : 'Failed')), r.ok ? 'ok' : 'bad');
            if (r.ok) {
              /* 0.17.39：点天气卡里的一首不再整批重算（模型写一句 + 100 条向量）。
                 服务端收到 source==='wx' 时只把这首从名单里划掉并补位，这一帧就能看到。 */
              void tick();
            }
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e), 'bad');
          } finally {
            busyPlay = false;
            sentKey = '';
            target.classList.remove('np-busy');
            const p = pendingPlay;
            pendingPlay = null;
            if (p && p.item) void playOne(p.item, p.target, p.source);
          }
        };

        /**
         * 确认条：她问过「要我帮你放吗」之后的「是 / 否」。
         * 不超时、不替他默认否 —— 他没点就是人不在电脑前，等他回来再定。
         */
        const answerIdle = async (yes) => {
          try {
            const r = await ctx.invoke('answerIdle', [{ yes }]);
            if (yes && r && r.ok === false) {
              ui.toast(r.error || r.reason || (zh ? '没放成' : 'Could not start'), 'bad');
            } else if (yes && r && r.played) {
              ui.toast(zh ? '好，这首放上了，后面我接着挑' : 'Starting now', 'ok');
            }
            void tick(true);
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e), 'bad');
          }
        };

        /* 「换一批」推荐：跑一次重算，回来再刷一遍面板 */
        let recoBusy = false;
        const recoAgain = async (btn) => {
          if (recoBusy) return;
          recoBusy = true;
          btn.disabled = true;
          btn.classList.add('np-rc-busy');
          btn.textContent = t.recoAgainBusy;
          try {
            const r = await ctx.invoke('recoRefresh', [{}]);
            if (r && r.ok === false) ui.toast(r.reason === 'inactive' ? t.inactive : (r.reason || (zh ? '没算出来' : 'Failed')), 'bad');
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e), 'bad');
          } finally {
            recoBusy = false;
            btn.disabled = false;
            btn.classList.remove('np-rc-busy');
            btn.textContent = t.recoAgain;
            void tick(true);
          }
        };

        /* 0.17.30：卡片5 的「换一批」——重查天气 + 重算向量，回来再刷面板 */
        let wxBusy = false;
        const wxAgain = async (btn) => {
          if (wxBusy) return;
          wxBusy = true;
          btn.disabled = true;
          btn.classList.add('np-rc-busy');
          btn.textContent = t.recoAgainBusy;
          try {
            const r = await ctx.invoke('wxRecoRefresh', [{}]);
            if (r && r.ok === false) ui.toast(r.reason === 'inactive' ? t.inactive : (r.error || r.reason || (zh ? '没算出来' : 'Failed')), 'bad');
          } catch (e) {
            ui.toast(e instanceof Error ? e.message : String(e), 'bad');
          } finally {
            wxBusy = false;
            btn.disabled = false;
            btn.classList.remove('np-rc-busy');
            btn.textContent = t.recoAgain;
            void tick(true);
          }
        };

        const draw = (s) => {
          /* 头部 */
          const st = s || {};
          /* 0.17.39：来源开关选哪张卡，哪张卡才可点。另一张画成「已停用」并禁用按钮。 */
          const wxOn = (st.recoSource || 'history') === 'weather';
          const histOn = !wxOn;
          /* 0.17.43（D1，用户口径）：只显示一张卡，由设置里那个来源开关决定；
             另一张隐藏，后台计算也已经停了（src 侧门控）。 */
          recCard.style.display = histOn ? '' : 'none';
          wxCard.style.display = wxOn ? '' : 'none';
          /* 接力状态、客户端提示、安静提示不属于某一张卡 —— 先攒着，等最后挂到
             **当前这张**卡下面。以前固定挂在卡① 上，选天气时就会出现
             「这张已停用，下面却写着我挑中了《X》」。 */
          const tailNodes = [];
          const hn = String(st.herName || '').trim();
          eyebrow.textContent = zh ? `${hn || '她'}此刻在陪听` : `${hn || 'She'} is listening now`;
          if (st.playing && st.title) {
            title.textContent = `《${st.title}》`;
            sub.textContent = st.artist || '';
          } else if (st.preview && st.preview.title) {
            /* 0.16.42：没在放歌，但下面三张卡说的是她挑的这首 —— 别写「播放器没连上」那种像报错的字 */
            title.textContent = t.notPlaying;
            sub.textContent = t.previewSub(st.preview.title);
          } else {
            /* 客户端进程在着（只是调试端口没开）就别喊「播放器没连上」——那读着像报错 */
            title.textContent = (st.clientOpen || st.clientRunning) ? t.notPlaying : t.playerOff;
            sub.textContent = '';
          }
          // 网易云不给播放进度，条已经去掉（见 RUN-REQUIREMENTS 第九节）

          /* 她听这首歌时 —— 生成要几秒，先是「她在听…」，下一轮刷新就有话说了 */
          hearCard.innerHTML = '';
          hearCard.append(el('h3', null, t.howSheHears));
          /* 0.16.53：谁唱的这首 + 多少人点赞（只对真在放的歌显示；读不到就整行不出现） */
          if (st.liked) hearCard.append(el('p', 'np-hear-meta', st.liked));
          const take = st.take;
          if (take && take.text) {
            hearCard.append(el('p', 'np-hear', take.text));
          } else {
            const state = st.takeState || '';
            let note = '—';
            if (state === 'off') note = t.cardOff;
            else if (state === 'body-off') note = t.bodyOff;
            else if (state === 'pending') note = t.hearing;
            else if (state === 'no-model') note = t.noModel;
            else if (state === 'no-lyric') note = t.noLyric;
            else if (state === 'model-error' || state === 'empty') note = t.takeFail;
            const p = el('p', 'np-muted', note);
            if (state === 'pending') p.className = 'np-muted np-hearing';
            hearCard.append(p);
            if (state === 'model-error' && st.takeError) {
              hearCard.append(el('p', 'np-err', st.takeError));
            }
          }

          /* 她听完什么感觉 —— 先引一句歌词，再从这一句说她自己 */
          takeCard.innerHTML = '';
          takeCard.append(el('h3', null, t.herTake));
          const lk = st.like;
          if (lk && lk.feel) {
            if (lk.line) {
              const q = el('p', 'np-like-line');
              q.append(el('span', 'np-like-quote', '「'));
              q.append(el('span', 'np-like-lyric', lk.line));
              q.append(el('span', 'np-like-quote', '」'));
              takeCard.append(q);
            }
            takeCard.append(el('p', 'np-like-why', lk.feel));
          } else {
            const state = st.likeState || '';
            let note = t.notSaid;
            if (state === 'off') note = t.cardOff;
            else if (state === 'pending') note = t.judging;
            else if (state === 'no-model') note = t.noModel;
            else if (state === 'no-lyric') note = t.noLyric;
            else if (state === 'model-error' || state === 'empty') note = t.takeFail;
            const v = el('div', 'np-verdict', note);
            if (state === 'pending') v.className = 'np-verdict np-hearing';
            takeCard.append(v);
            if (state === 'model-error' && st.likeError) {
              takeCard.append(el('p', 'np-err', st.likeError));
            }
            if (state === 'no-playing') takeCard.append(el('p', 'np-muted', t.notSaidWhy));
          }

          /* 别人怎么说 —— 评论区热评：一条最多赞、过 50 字的，带谁说的和多少赞 */
          commentCard.innerHTML = '';
          commentCard.append(el('h3', null, t.othersSay));
          const cm = st.comment;
          if (cm && cm.text) {
            const meta2 = el('div', 'np-cm-meta');
            meta2.append(el('span', 'np-cm-likes', `${fmtLikes(cm.likes)}人同意`));
            if (cm.nick) meta2.append(el('span', 'np-cm-nick', cm.nick));
            commentCard.append(meta2);
            commentCard.append(el('p', 'np-cm-text', cm.text));
            if (Number(cm.total) > 0) {
              commentCard.append(el('p', 'np-muted np-cm-total', t.commentTotal(fmtLikes(cm.total))));
            }
            /* 她看完这条评论，自己说几句 —— 原文整段在上面，这里直接接她的话。
               0.0.1.6.6 起不再挂「她听完说」这种标签：话本身就带「我觉得 / 我认为」开头，
               再挂一个引子反而像转述。 */
            const rp = st.reply;
            if (rp && rp.text) {
              const say = el('div', 'np-cm-say');
              say.append(el('p', 'np-cm-say-text', rp.text));
              commentCard.append(say);
            } else if (st.replyState === 'pending') {
              commentCard.append(el('p', 'np-muted np-hearing', t.replyThinking));
            } else if (st.replyState === 'model-error' && st.replyError) {
              commentCard.append(el('p', 'np-err', st.replyError));
            } else if (st.replyState && st.replyState !== 'no-playing' && st.replyState !== 'no-model') {
              commentCard.append(el('p', 'np-muted', t.replyFail));
            }
          } else {
            const state = st.commentState || '';
            let note = t.noComment;
            if (state === 'off') note = t.cardOff;
            else if (state === 'pending') note = t.readingComments;
            else if (state === 'not-found' || state === 'no-comment') note = t.noComment;
            else if (state === 'unavailable') note = t.commentFail;
            const p = el('p', 'np-muted', note);
            if (state === 'pending') p.className = 'np-muted np-hearing';
            commentCard.append(p);
          }

          /* 今天听点什么 —— 历史听歌 + 点歌次数喂给向量，再跟每日推荐比相似度 */
          recCard.innerHTML = '';
          const recHead = el('div', 'np-rc-head');
          recHead.append(el('h3', null, t.recTitle));
          const again = el('button', 'np-rc-again', recoBusy ? t.recoAgainBusy : t.recoAgain);
          again.type = 'button';
          again.disabled = recoBusy || !histOn;
          again.title = zh ? '重新算一批，AI 也能自己换' : 'Recompute a new batch';
          again.addEventListener('click', () => void recoAgain(again));
          recHead.append(again);
          recCard.append(recHead);
          const rc = st.recommend;
          if (rc && rc.items && rc.items.length) {
            if (Number(rc.historyCount) > 0) {
              recCard.append(el('p', 'np-muted np-rc-hint', t.recHint(rc.historyCount)));
            }
            /* 0.17.16（用户口径）：这行要能同时看出「什么时候拉的」和「池子多大、这轮能挑多少」。
               · 时间取候选数据实际拉取的时刻（poolAt 榜单 / dailyAt 每日推荐，哪个新用哪个）；
               · 池子 = 去重、剔掉听过的之后的总数（rc.poolSize，约 233）；
               · 「本轮可挑」= 打乱抽样后再让开推过的，真正进打分的那批（rc.candidateCount）。 */
            const stampOf = (ms, pool, usable) => {
              const at2 = Number(ms) || 0;
              if (!at2) return '';
              const d = new Date(at2);
              const p2 = (v) => String(v).padStart(2, '0');
              const when = zh
                ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`
                : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
              const tot = Number(pool) || 0;
              const use = Number(usable) || 0;
              if (zh) {
                if (!tot) return `歌单已于 ${when} 刷新`;
                return use > 0 && use < tot
                  ? `歌单已于 ${when} 刷新 · 候选池 ${tot} 首，本轮可挑 ${use} 首`
                  : `歌单已于 ${when} 刷新 · 候选池 ${tot} 首`;
              }
              if (!tot) return `Playlist refreshed ${when}`;
              return use > 0 && use < tot
                ? `Playlist refreshed ${when} · ${tot} in pool, ${use} usable`
                : `Playlist refreshed ${when} · ${tot} songs`;
            };
            const latest = Math.max(Number(rc.poolAt) || 0, Number(rc.dailyAt) || 0) || Number(rc.at) || 0;
            const stamp = stampOf(latest, rc.poolSize || rc.candidateCount, rc.candidateCount);
            if (stamp) recCard.append(el('p', 'np-muted np-rc-stamp', stamp));
            const list = el('ul', 'np-rc-list');
            // 第 111 节：毫秒 → m:ss；拿不到就返回空串，宁可不显示也别显示 0:00
            const fmtDur = (ms) => {
              const s = Math.round((Number(ms) || 0) / 1000);
              if (s < 30) return '';
              return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            };
            for (const it of rc.items) {
              const row = el('li', 'np-rc-item');
              // 歌名可点：点一下播这首
              const nm = el('span', 'np-rc-name np-playable', `《${it.name}》`);
              nm.title = zh
                ? `点一下播这首《${it.name}》${it.artist ? ` — ${it.artist}` : ''}（会记一次点歌）`
                : `Play ${it.name}`;
              nm.addEventListener('click', () => void playOne({ title: it.name, artist: it.artist, songId: it.id }, nm, 'reco'));
              row.append(nm);
              if (it.artist) row.append(el('span', 'np-rc-artist', it.artist));
              // 0.16.86：专辑名。快照里一直带着 album，只是前端一直没画出来。
              if (it.album) row.append(el('span', 'np-rc-album', it.album));
              // 这首歌多长 + 网易云那边是哪张歌单推过来的（榜单本身就是官方歌单）
              const dur = fmtDur(it.durMs);
              if (dur) row.append(el('span', 'np-rc-dur', dur));
              const srcName = it.from === 'daily' ? (zh ? '每日推荐' : 'Daily') : String(it.from || '');
              if (srcName) row.append(el('span', 'np-rc-from', srcName));
              // 「像《X》」那首也能点 —— 顺着这条线直接听过去
              if (it.basis && it.basis.title) {
                const b = el('span', 'np-rc-basis np-playable', t.recBasis(it.basis.title));
                b.title = zh
                  ? `点一下播《${it.basis.title}》${it.basis.artist ? ` — ${it.basis.artist}` : ''}（会记一次点歌）`
                  : `Play ${it.basis.title}`;
                b.addEventListener('click', (e) => {
                  e.stopPropagation();
                  void playOne({ title: it.basis.title, artist: it.basis.artist }, b, 'reco');
                });
                row.append(b);
              }
              list.append(row);
            }
            recCard.append(list);
          } else {
            const state = st.recommendState || '';
            let note = t.recPending;
            if (state === 'inactive') note = t.inactive;
            else if (state === 'no-daily') note = t.recNoDaily;
            else if (state === 'no-history') note = t.recNoHistory;
            else if (state === 'no-embed' || state === 'no-model') note = t.recNoEmbed;
            else if (state === 'no-candidate') note = t.recNoCandidate;
            else if (state && state !== 'pending' && state !== 'ready') note = t.recFail;
            const p = el('p', 'np-muted', note);
            if (state === 'pending' || !state) p.className = 'np-muted np-hearing';
            recCard.append(p);
            if (st.recommendError) recCard.append(el('p', 'np-err', st.recommendError));
          }

          /* 安静时她主动开的口：0.0.1.6.19 起不在面板上重复了 ——
             那句话和「要放歌吗」的三选项都由桌宠气泡（pet_say + pet_ask）负责，
             面板只留「已经安静 N 分钟」这行小字，说明她还没到点开口。
             旧逻辑（橙线卡片 + 就放《X》+ 是/不用了）整块撤掉，见 RUN-REQUIREMENTS 第四十一节。 */
          if (st.playing === false && st.clientOpen === false) {
            // 0.0.1.6.34：客户端没开时，安静多久都没意义 —— 她会不开口，用户要知道为什么
            // 0.16.42：分两种 —— 进程在只是没开调试端口 / 压根没开
            tailNodes.push(el('p', 'np-muted np-client-off', st.clientRunning ? t.clientNoPort : t.clientOff));
          }
          if (!st.playing && Number(st.idleSec) > 0) {
            tailNodes.push(el('p', 'np-muted np-idle-quiet', t.idleHint(Math.round(st.idleSec))));
          }
          /* 「一直保持安静」（0.0.1.6.36）：她在气泡里选了第二条、或者点了叉，
             她就不再主动开口了。这件事得让用户看得见，并且给一个放开的按钮。 */
          if (st.quiet && st.quiet.on) {
            const wrap = el('div', 'np-quiet-now');
            wrap.append(el('span', 'np-quiet-text', t.quietOn));
            const off = el('button', 'np-quiet-off', t.quietOff);
            off.type = 'button';
            const off2 = async (btn) => {
              btn.disabled = true;
              try { await ctx.invoke('quietSet', [{ on: false }]); } catch { /* 放不开就下次再说 */ }
              btn.disabled = false;
              void tick(true);
            };
            off.addEventListener('click', () => void off2(off));
            wrap.append(off);
            tailNodes.push(wrap);
          }


          /* 接力点歌：她趁这首快放完时自己接了下一首。
             这一块**播放中**也要显示 —— 它的主场景就是「正在放、快完了」。
             面板这里**没有按钮**（0.0.1.6.21 撤掉了）：她报完歌名就自己放，面板只做状态显示。 */
          /* 0.17.43（C3，用户口径）：标签先写清"现在开的是哪一种"——
               接力点歌开启（听歌历史） / 天气点歌开启 / 自动点歌已停止
             然后才是具体状态。以前固定写「接力点歌」，加了天气之后分不清谁在接管。 */
          const cs = st.chainState || {};
          const chainMode = histOn ? t.chainModeHistory : t.chainModeWeather;
          if (cs.kind === 'picking') {
            const wrap = el('div', 'np-chain');
            wrap.append(el('span', 'np-chain-label', chainMode));
            wrap.append(el('span', 'np-chain-say', `「${t.chainPicking}」`));
            tailNodes.push(wrap);
          } else if (cs.kind === 'picked') {
            /* 0.17.48（用户口径）：天气模式这一条合成一句 ——
                 天气点歌已开启｜「天气话」→《挑到的歌》
               历史模式仍是「我挑中了《X》」。
               只显示**确定要播的下一首**（`cs.idle` 的候选预告不显示）。
               0.17.49：天气模式这一行已经挪到天气卡里（常驻天气话），这里不再重复。 */
            if (!wxOn) {
              if (cs.idle) {
                /* 0.17.57（用户口径）：候选预告不显示，但「他已经接下某一首」这行状态要保留，
                   否则卡①下面会空着。其余情况继续不显示。 */
                if (cs.origin === 'her-offer' && cs.baseName) {
                  const wrap = el('div', 'np-chain np-chain-round');
                  wrap.append(el('span', 'np-chain-label', chainMode));
                  wrap.append(el('span', 'np-chain-wait', t.chainStarted(cs.baseName)));
                  tailNodes.push(wrap);
                }
              } else {
                const wrap = el('div', 'np-chain');
                wrap.append(el('span', 'np-chain-label', chainMode));
                const wxLine = String(((st.wxReco && st.wxReco.line) || '')).trim();
                const say = (wxOn && wxLine)
                  ? `「${wxLine}」→《${cs.name}》`
                  : `「${t.chainSay(cs.name)}」`;
                wrap.append(el('span', 'np-chain-say', say));
                // 0.16.58：不再有「最多 6 首」，只报已经接到第几首
                if (Number(cs.count) > 0) {
                  wrap.append(el('span', 'np-chain-count', t.chainCount(Number(cs.count))));
                }
                if (cs.origin === 'her-offer' && cs.baseName) {
                  // 他已经接受了她推的那首 → 这是「面板提示」，不出声（用户口径）
                  wrap.append(el('span', 'np-chain-wait', t.chainStarted(cs.baseName)));
                } else {
                  wrap.append(el('span', 'np-chain-wait', t.chainWait));
                }
                tailNodes.push(wrap);
              }
            }
          } else if (cs.kind === 'stopped') {
            // 关掉接力、或这轮收场 —— 只写结论，不再重复「我挑中了」
            const wrap = el('div', 'np-chain');
            wrap.append(el('span', 'np-chain-label', t.chainStopped));
            tailNodes.push(wrap);
          } else if (st.chainRound && st.chainRound.baseName) {
            // 点了推荐那首（或者答应了她）→ 面板立刻出一句提示，等这首快放完她才接
            // 用户口径：这个提示**不要语音**，面板上有就够。
            const wrap = el('div', 'np-chain np-chain-round');
            wrap.append(el('span', 'np-chain-label', chainMode));
            wrap.append(el('span', 'np-chain-wait', t.chainStarted(st.chainRound.baseName)));
            tailNodes.push(wrap);
          } else if (st.chainFail) {
            // 播报了却没放成 —— 必须让用户看见，不能只挂在语音上
            const wrap = el('div', 'np-chain np-chain-fail');
            wrap.append(el('span', 'np-chain-label', chainMode));
            wrap.append(el('span', 'np-chain-wait', t.chainFailed(st.chainFail)));
            tailNodes.push(wrap);
          }

          /* 0.17.30：卡片5「按天气听点什么」——版式照卡①，数据源换成天气 */
          wxCard.innerHTML = '';
          const wr = st.wxReco || {};
          const wxHead = el('div', 'np-rc-head');
          wxHead.append(el('h3', null, zh ? '按天气听点什么' : 'Pick for this weather'));
          const wxBtn = el('button', 'np-rc-again', wxBusy ? t.recoAgainBusy : t.recoAgain);
          wxBtn.type = 'button';
          wxBtn.disabled = wxBusy || !wxOn;
          wxBtn.title = zh ? '重新算一批（天气仍用最近一次查询结果，后台等一下再出）' : 'Recompute in the background (reuses the last weather snapshot)';
          wxBtn.addEventListener('click', () => void wxAgain(wxBtn));
          wxHead.append(wxBtn);
          wxCard.append(wxHead);
          const wplace = wr.place ? [wr.place.country, wr.place.adm1, wr.place.adm2, wr.place.name].filter(Boolean).join(' / ') : '';
          if (wr.weather) {
            /* 0.17.43（A5/C1）：缓存里的天气如果太久没更新，要写出来 —— 别让旧数据看着像此刻；
               同时把"上次抓取时间"放在旁边，一眼能判断新旧。 */
            const staleNote = Number(wr.staleMin) >= 20
              ? (zh ? `　·　天气数据 ${wr.staleMin} 分钟前` : ` · weather ${wr.staleMin} min old`)
              : '';
            const wxAt = Number(wr.weatherAt) || 0;
            const atNote = wxAt
              ? (zh ? `　·　更新于 ${new Date(wxAt).toLocaleTimeString()}` : ` · updated ${new Date(wxAt).toLocaleTimeString()}`)
              : '';
            /* 0.17.48：天气那句话挪到「天气点歌已开启」那一行（和挑到的歌名一起），这里不再重复 */
            wxCard.append(el('p', 'np-muted np-rc-hint', zh
              ? `按天气挑的${wplace ? `　·　${wplace}` : ''}${atNote}${staleNote}`
              : `Picked by weather${wplace ? ` · ${wplace}` : ''}${atNote}${staleNote}`));
          }
          if (wr.items && wr.items.length) {
            const wlist = el('ul', 'np-rc-list');
            const wfmtDur = (ms) => {
              const sec = Math.round((Number(ms) || 0) / 1000);
              if (sec < 30) return '';
              return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
            };
            for (const it of wr.items) {
              const row = el('li', 'np-rc-item');
              const nm = el('span', 'np-rc-name np-playable', `《${it.name}》`);
              nm.title = zh
                ? `点一下播这首《${it.name}》${it.artist ? ` — ${it.artist}` : ''}（会记一次点歌）`
                : `Play ${it.name}`;
              nm.addEventListener('click', () => void playOne({ title: it.name, artist: it.artist, songId: it.id }, nm, 'wx'));
              row.append(nm);
              if (it.artist) row.append(el('span', 'np-rc-artist', it.artist));
              if (it.album) row.append(el('span', 'np-rc-album', it.album));
              const wdur = wfmtDur(it.durMs);
              if (wdur) row.append(el('span', 'np-rc-dur', wdur));
              const wsrc = it.from || '';
              if (wsrc) row.append(el('span', 'np-rc-from', wsrc));
              // 相似度只给一个百分比小字，方便一眼看出「像不像今天的天气」
              if (it.sim) row.append(el('span', 'np-rc-sim', `${Math.round(it.sim * 100)}%`));
              wlist.append(row);
            }
            wxCard.append(wlist);
            /* 0.17.49（用户口径）：天气那句话**常驻显示**，即使没开接力；
               后面永远跟「计算出来、自动播放会放的那首」——
               已挑定就用挑定的那首，否则用天气名单的顺位第一（pickWxSong 的实际取法）。
               换一批 / 启动刷新后，`wr.line` 和名单更新，这里跟着变。 */
            const wxLine = String(wr.line || '').trim();
            const csWx = st.chainState || {};
            const wxPicked = !!(csWx.kind === 'picked' && !csWx.idle);
            const wxFirst = (wr.next && wr.next.name)
              ? String(wr.next.name)
              : ((wr.items && wr.items[0] && wr.items[0].name) ? String(wr.items[0].name) : '');
            const wxSong = wxPicked ? String(csWx.name || '') : wxFirst;
            if (wxLine) {
              const wbar = el('div', 'np-chain');
              wbar.append(el('span', 'np-chain-label', wxPicked ? t.chainModeWeather : (zh ? '天气推荐' : 'Weather pick')));
              wbar.append(el('span', 'np-chain-say', wxSong ? `「${wxLine}」→《${wxSong}》` : `「${wxLine}」`));
              wxCard.append(wbar);
            }
          } else {
            const why = String(wr.reason || '');
            let wnote = zh ? '正在按天气挑…' : 'Picking by weather…';
            if (why === 'inactive') wnote = t.inactive;
            else if (why === 'weather-fail') wnote = zh ? `天气没查到：${wr.error || '—'}` : `Weather failed: ${wr.error || '—'}`;
            else if (why === 'weather-stale') wnote = zh ? `天气数据 ${wr.staleMin || '?'} 分钟没更新，这张先停用` : `Weather data is ${wr.staleMin || '?'} min old`;
            else if (why === 'no-pool') wnote = zh ? '候选池是空的（先让榜单拉一次歌）' : 'Song pool is empty';
            else if (why === 'no-embed') wnote = zh ? '没选向量模型（设置页挑一个）' : 'No embedding model';
            else if (why === 'fail') wnote = zh ? `算不出来：${wr.error || '—'}` : `Failed: ${wr.error || '—'}`;
            const wp = el('p', 'np-muted', wnote);
            if (why === 'pending' || why === 'stale' || why === 'picking') wp.className = 'np-muted np-hearing';
            wxCard.append(wp);
          }

          /* 0.17.43（D1）：接力/客户端/安静这些共用提示，挂到**当前显示的那张卡**下面。
             选天气时它们就在天气卡里，不会出现「这张已停用却写着我挑中了《X》」。 */
          const activeCard = histOn ? recCard : wxCard;
          for (const n of tailNodes) activeCard.append(n);

          foot.textContent = `${t.refreshNote}　·　${new Date().toLocaleTimeString()}`;
        };

        async function tick(fresh = false) {
          try {
            draw(await ctx.invoke(fresh ? 'refresh' : 'snapshot', [{}]));
          } catch (e) {
            foot.textContent = e instanceof Error ? e.message : String(e);
          }
        }

        void tick();
        /* 3 秒一轮：播放器那边本来就按秒推，再快也没用。 */
        ctx.interval(() => void tick(), 3000);
      },
    },

    model: {
      mount(ctx) {
        /*
         * 「模型」页签：本机 / 云端开关 + 云端填写区。
         *
         * 这一页存在的唯一理由：宿主的设置页做不到「按开关隐藏字段」（没有 x-hidden / x-when），
         * 也没有 password 类型的输入框。这里自己画 DOM，两件事都不受限制：
         *   · 选本机 → 云端整块 hidden，什么都不显示；
         *   · Key 永远是 type=password，而且服务端压根不回传完整 Key，只给尾号。
         */
        const doc = ctx.root.ownerDocument ?? document;
        const zh = String(ctx.language ?? 'zh').toLowerCase().startsWith('zh');
        const el = (tag, cls, text) => {
          const node = doc.createElement(tag);
          if (cls) node.className = cls;
          if (text !== undefined && text !== null) node.textContent = text;
          return node;
        };
        const call = (method, arg) => ctx.invoke(method, [arg ?? {}]);
        const ui = ctx.ui;

        const t = zh
          ? {
            src: '模型来源',
            local: '本机',
            cloud: '云端',
            cloudTitle: '云端模型（OpenAI 兼容）',
            url: '接口地址',
            urlPh: 'https://api.deepseek.com',
            key: 'API Key',
            keyEmpty: '还没填过 Key',
            keyPh: '填新 Key 才会覆盖，留空＝不改',
            show: '显示',
            hide: '隐藏',
            read: '读取模型',
            saving: '保存',
            readOk: (n) => `读到了 ${n} 个模型`,
            saved: '已保存',
            model: '模型',
            modelPh: 'deepseek-flash',
            pickList: '读到的：',
            localTitle: '本机 Ollama',
            localHint: '地址、向量模型、显存模式、小模型都在宿主的设置页里（网易云陪听 · 本机 · 那几项）。这一页只管开关和云端。',
            nowLocal: (m) => `现在生效：本机 · ${m}`,
            nowNone: '现在没有可用的模型，三张卡都不会出话',
            nowCloud: (m) => `现在生效：云端 · ${m}`,
          }
          : {
            src: 'Model source',
            local: 'Local',
            cloud: 'Cloud',
            cloudTitle: 'Cloud model (OpenAI compatible)',
            url: 'Endpoint',
            urlPh: 'https://api.deepseek.com',
            key: 'API key',
            keyEmpty: 'No key yet',
            keyPh: 'Type a new key to replace; leave empty to keep',
            show: 'Show',
            hide: 'Hide',
            read: 'Read models',
            saving: 'Save',
            readOk: (n) => `Found ${n} model(s)`,
            saved: 'Saved',
            model: 'Model',
            modelPh: 'deepseek-flash',
            pickList: 'Found:',
            localTitle: 'Local Ollama',
            localHint: 'Endpoint, embedding model, VRAM mode and chat model live in the host settings page.',
            nowLocal: (m) => `Active: local · ${m}`,
            nowNone: 'No usable model — all three cards stay silent',
            nowCloud: (m) => `Active: cloud · ${m}`,
          };

        let snap = null;
        const draft = { url: '', key: '', model: '' };
        let note = null;   // { text, bad }
        let busy = false;

        const root = el('div', 'np-model');
        const segHost = el('div', 'np-model-src');
        const cloudBox = el('div', 'np-card np-cloud');
        const localBox = el('div', 'np-card np-local');
        const foot = el('p', 'np-muted np-model-foot');

        /* ---------- 云端那一块：建一次，之后只更新 ---------- */
        const urlInput = ui.input({
          cls: 'mono',
          placeholder: t.urlPh,
          onInput: (v) => { draft.url = v; },
        });
        const keyInput = ui.input({
          type: 'password',        // 密文；宿主 fields.ts 直接读 o.type
          cls: 'mono',
          placeholder: t.keyPh,
          onInput: (v) => { draft.key = v; },
        });
        const eyeBtn = ui.button(t.show, {
          size: 'sm',
          onClick: () => {
            const shown = keyInput.type === 'text';
            keyInput.type = shown ? 'password' : 'text';
            eyeBtn.textContent = shown ? t.show : t.hide;
          },
        });
        const readBtn = ui.button(t.read, { size: 'sm', onClick: () => void readModels() });
        const saveBtn = ui.button(t.saving, { size: 'sm', variant: 'primary', onClick: () => void saveCloud() });
        const modelInput = ui.input({
          cls: 'mono',
          placeholder: t.modelPh,
          onInput: (v) => { draft.model = v; },
        });
        const chipsBox = el('div', 'np-chips');
        const statusLine = el('p', 'np-model-status');
        const keyRow = el('div', 'np-key-row', null);
        keyRow.append(keyInput, eyeBtn);
        const acts = el('div', 'np-model-acts', null);
        acts.append(readBtn, saveBtn);

        cloudBox.append(
          el('h3', null, t.cloudTitle),
          ui.field(t.url, urlInput),
          ui.field(t.key, keyRow),
          acts,
          ui.field(t.model, modelInput),
          chipsBox,
          statusLine,
        );

        /* ---------- 本机那一块：只读数 ---------- */
        const localInfo = el('p', 'np-muted');
        localBox.append(el('h3', null, t.localTitle), localInfo, el('p', 'np-muted', t.localHint));

        /* 0.17.67（用户口径）：「模型页面最下面 网易云陪听那个框，当时是弄错了弄上去的，把它删掉。」
           那张只读「扩展信息」卡（包名@版本 / 简介 / 作者 / 安装位置）已整块移除 ——
           快照里的 `about` 仍由后端提供，只是这一页不再画。 */

        /* ---------- 0.17.23：照抄「实时天气」配置页那一整块 ----------
           用户口径：把截图里那一页的内容全抄过来（连接设置、Key 信息、保存密钥、
           测试连接、下面「如何取得密钥」那一整段），位置放在「模型」页，并把这一页
           改成和「设置」页一样的折叠卡片。这一张先只做版式原型，按钮不接后端。 */
        /* 天气卡要等快照回来才填值 —— 先登记画手，render() 里统一调一次。 */
        const cardPainters = [];

        function buildQweatherCard() {
          const opts = {
            title: zh ? '配置' : 'Config',
            en: 'QWeather',
            desc: '',
            defaultOpen: true,
          };
          const c = typeof ui.foldSheet === 'function'
            ? ui.foldSheet.call(ui, 'set-qweather', opts)
            : ui.sheet(opts);

          /* 0.17.28：卡最上面这一块 —— 实况 + 两天每日预报，按下面「实况检查间隔」自动查，也能手动查。 */
          const liveBox = el('div', 'np-qw-live');
          const liveHead = el('div', 'np-qw-live-head');
          liveHead.append(el('div', 'np-qw-live-title', zh ? '实时天气 · 未来两天' : 'Now · next 2 days'));
          /* 0.17.43（D2，用户口径）：面板只读缓存；这个按钮是唯一主动去抓远端的入口。
             自动刷新（下面 scheduleAuto）永远只读缓存，不触发抓取。 */
          const refreshBtn = ui.button(zh ? '刷新（远端）' : 'Refresh (remote)', { size: 'sm', onClick: () => void refreshWeather() });
          liveHead.append(refreshBtn);
          const liveNow = el('div', 'np-qw-live-now'); // 0.17.29：改成三行，放全部实况指标
              liveNow.append(
                el('div', 'np-qw-live-r1', zh ? '还没查过。保存密钥后会自动查一次，也可以随时点「手动查询」。' : 'Not queried yet.'),
                el('div', 'np-qw-live-r2', ''),
                el('div', 'np-qw-live-r3', ''),
              );
          const liveDays = el('div', 'np-qw-live-days', '');
          /* 0.17.43（C1，用户口径）：天气只用来给模型写那句话，不必强求实时 ——
             但要让人看得见"这份数据是什么时候的"。这行只显示缓存里的更新时间，不触发抓取。 */
          const liveUpdated = el('div', 'np-muted np-qw-updated', '');
          liveBox.append(liveHead, liveNow, liveUpdated, liveDays);
          c.body.append(liveBox);

          c.body.append(el('h3', 'np-qw-h', 'QWeather 连接'));

          const hostIn = ui.input({ cls: 'mono' });
          const badge = el('div', 'np-qw-badge', '');
          const keyIn = ui.input({ cls: 'mono', type: 'password', placeholder: '' });
          const gapIn = ui.input({ cls: 'mono' });
          const alignBox = ui.checkbox('检查时间对齐整点', { checked: false, onChange: () => {} });
          const adminIn = ui.input({ cls: 'mono', placeholder: '省、州或所属城市' });
          const codeIn = ui.input({ cls: 'mono', placeholder: 'ISO 国家代码，如 cn、jp、us' });
          const cityIn = ui.input({ cls: 'mono', placeholder: '城市或区划名称' });
          const placePath = el('div', 'np-qw-path', '');
          const result = el('p', 'np-qw-result', '');
          let filled = false;
          let busy = false;
          let timer = null;
          let querying = false;

          c.body.append(el('div', 'np-qw-label', 'QWeather API Host'));
          c.body.append(hostIn);
          c.body.append(badge);
          c.body.append(el('div', 'np-qw-label', 'QWeather API Key'));
          const keyRow = el('div', 'np-qw-keyrow');
          const saveBtn = ui.button(zh ? '保存密钥' : 'Save key', {
            size: 'sm', variant: 'primary', onClick: () => void saveWeather(true),
          });
          keyRow.append(keyIn, saveBtn);
          c.body.append(keyRow);

          const testLink = doc.createElement('button');
          testLink.type = 'button';
          testLink.className = 'np-qw-test';
          testLink.textContent = zh ? '测试连接' : 'Test connection';
          testLink.addEventListener('click', () => void saveWeather(false));
          c.body.append(testLink);
          c.body.append(result);

          /** 把卡上的值写回 worlds."netease-play"（key 留空＝不改），再决定要不要真查一次。 */
          async function saveWeather(onlySave) {
            if (busy) return;
            busy = true;
            result.textContent = '';
            try {
              const items = [
                { key: 'qwApiHost', value: hostIn.value.trim() },
                { key: 'qwInterval', value: Number(gapIn.value) || 15 },
                { key: 'qwAlign', value: alignBox.input.checked === true },
                { key: 'qwAdmin', value: adminIn.value.trim() },
                { key: 'qwCountryCode', value: codeIn.value.trim() },
                { key: 'qwCity', value: cityIn.value.trim() },
              ];
              if (String(keyIn.value || '').trim()) items.push({ key: 'qwApiKey', value: keyIn.value.trim() });
              for (const it of items) await call('set', it);
              keyIn.value = '';
              snap = await call('snapshot');
              filled = false;
              paintWeather();
              if (onlySave) { result.textContent = zh ? '已保存到配置。' : 'Saved.'; return; }
              result.textContent = '';
              await queryWeather(false);
            } catch (e) {
              result.textContent = (zh ? '失败：' : 'Failed: ') + (e instanceof Error ? e.message : String(e));
            } finally {
              busy = false;
            }
          }

          /** 0.17.43（D2）：手动抓一次远端，成功/失败写回文字；抓完从缓存重画这一块。 */
          async function refreshWeather() {
            if (querying) return;
            querying = true;
            result.textContent = zh ? '正在刷新远端天气…' : 'Fetching…';
            try {
              const r = await call('weatherFetch', {});
              result.textContent = r && r.ok
                ? (zh ? `已更新（${new Date().toLocaleTimeString()}）` : 'Updated')
                : ((zh ? '刷新失败：' : 'Failed: ') + ((r && r.error) || '—'));
            } catch (e) {
              result.textContent = (zh ? '刷新失败：' : 'Failed: ') + (e instanceof Error ? e.message : String(e));
            } finally {
              querying = false;
            }
            await queryWeather(true).catch(() => { /* 重画失败就等下一轮自动刷新 */ });
          }

          /** 查一次：填最上面那个框（实况 + 两天预报）。 */
          async function queryWeather(auto) {
            if (querying) return;
            querying = true;
            liveNow.textContent = zh ? '正在查天气…' : 'Checking…';
            try {
              // 0.17.36：只有「手动查询」才真去打接口；自动刷新只读后台那份 15 分钟快照
              const r = await call('weatherNow', { force: !auto });
              if (!r || !r.ok) {
                liveNow.textContent = (zh ? '失败：' : 'Failed: ') + ((r && r.error) || '—');
                if (!auto) result.textContent = liveNow.textContent;
                return;
              }
              const place = [r.place.country, r.place.adm1, r.place.adm2, r.place.name].filter(Boolean).join(' / ');
              placePath.textContent = place;
              const n = r.now || {};
              const dirZh = { n: '北', ne: '东北', e: '东', se: '东南', s: '南', sw: '西南', w: '西', nw: '西北' };
              const ptZh = { none: '无', rain: '雨', snow: '雪', sleet: '雨夹雪', hail: '冰雹', thunderstorm: '雷雨' };
              const f1 = (v) => (v == null || v === '' ? '—' : String(Math.round(Number(v) * 10) / 10));
              const rows = [
                `${r.place.name} · ${n.text || '—'}　${f1(n.temp)}℃（体感 ${f1(n.feelsLike)}℃）　（${place}）`,
                `风 ${dirZh[n.windDir] || n.windDir || '—'} ${n.windScale == null ? '' : n.windScale + '级'} · 风速 ${f1(n.windSpeed)} m/s · 阵风 ${f1(n.windGust)} m/s · 气压 ${f1(n.pressure)} hPa`,
                `湿度 ${n.humidity === '' ? '—' : n.humidity + '%'} · 能见度 ${n.visibility == null ? '—' : (n.visibility / 1000).toFixed(1) + ' km'} · 云量 ${n.cloudCover === '' ? '—' : n.cloudCover + '%'} · 露点 ${f1(n.dewPoint)}℃ · 紫外线 ${n.uvIndex == null ? '—' : n.uvIndex} · 降水 ${f1(n.precipAmount)} mm（${ptZh[n.precipType] || n.precipType || '—'}）`,
              ];
              liveNow.innerHTML = '';
              for (let i = 0; i < rows.length; i += 1) liveNow.append(el('div', `np-qw-live-r${i + 1}`, rows[i]));

              /* 0.17.28：改每日预报，只显示两天。 */
              liveDays.innerHTML = '';
              for (const d of (r.daily || [])) {
                const row = el('div', 'np-qw-daily');
                let label = String(d.date || '');
                try {
                  label = new Date(`${d.date}T00:00:00+08:00`).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', weekday: 'short' });
                } catch { /* 用原字符串 */ }
                row.append(el('div', 'np-qw-daily-d', label));
                const wt = [d.dayText ? `白天 ${d.dayText}` : '', d.nightText ? `夜间 ${d.nightText}` : ''].filter(Boolean).join(' · ');
                row.append(el('div', 'np-qw-daily-w', wt || '—'));
                row.append(el('div', 'np-qw-daily-t', `${Math.round(Number(d.min))}° ~ ${Math.round(Number(d.max))}°`));
                if (Number(d.precip) > 0) row.append(el('div', 'np-qw-daily-p', `降水 ${d.precip}%`));
                liveDays.append(row);
              }
              /* 0.17.43（C1）：写清这份天气是什么时候抓的（缓存里的 at），不是"现在" */
              const wat = Number(r.at) || 0;
              liveUpdated.textContent = wat
                ? (zh ? `上次更新：${new Date(wat).toLocaleString()}` : `Last update: ${new Date(wat).toLocaleString()}`)
                : (zh ? '上次更新：未知' : 'Last update: unknown');
              if (!auto) result.textContent = '';
            } catch (e) {
              liveNow.textContent = (zh ? '失败：' : 'Failed: ') + (e instanceof Error ? e.message : String(e));
            } finally {
              querying = false;
            }
          }

          /** 按「实况检查间隔」自动查；勾了「对齐整点」就先等到下一个整分再起。 */
          function scheduleAuto() {
            if (timer) { clearInterval(timer); timer = null; }
            const w = (snap && snap.weather) || {};
            if (!w.keySet) return;
            const min = Math.max(1, Number(w.interval) || 15);
            const ms = min * 60 * 1000;
            const start = () => {
              if (timer) clearInterval(timer);
              timer = setInterval(() => void queryWeather(true), ms);
            };
            if (w.align) {
              const now = Date.now();
              const wait = ms - (now % ms);
              setTimeout(() => { void queryWeather(true); start(); }, wait);
            } else start();
          }

          /* 首屏填一次；用户改过之后 reload 不再覆盖。 */
          function paintWeather() {
            if (filled) return;
            const w = (snap && snap.weather) || {};
            hostIn.value = w.host || '';
            keyIn.placeholder = w.keySet ? `已配置 ${w.keyMask}，留空＝不改` : '粘贴 API Key';
            badge.textContent = w.keySet ? '密钥已配置' : '还没配置密钥';
            badge.classList.toggle('np-qw-badge-off', !w.keySet);
            gapIn.value = String(w.interval || 15);
            alignBox.setChecked(w.align === true);
            adminIn.value = w.admin || '';
            codeIn.value = w.countryCode || '';
            cityIn.value = w.city || '';
            placePath.textContent = w.keySet ? '' : '';
            filled = true;
            scheduleAuto();
            if (w.keySet) void queryWeather(true);
          }
          cardPainters.push(paintWeather);

          /* 「如何取得密钥」：外面是白的圆角块，右上角一个减号（收起）。 */
          const help = el('div', 'np-qw-help');
          const helpHead = el('div', 'np-qw-help-head');
          helpHead.append(el('div', 'np-qw-help-title', zh ? '如何取得密钥' : 'How to get a key'));
          const minus = el('div', 'np-qw-help-minus', '−');
          helpHead.append(minus);
          help.append(helpHead);
          const helpBody = el('div', 'np-qw-help-body');
          /* 0.17.24：用户口径 —— 这一块只留标题和橙字「注册QWeather账号」，下面七步全删。
             0.1.10（用户口径）：橙字下面再加两段操作提示（就这两段，别的不要）。
             0.1.11（用户口径）：橙字本身要能点，点了打开 QWeather 注册页。
               宿主 Electron 的 setWindowOpenHandler 对 https: 链接走 shell.openExternal，
               所以这里做成 target=_blank 的正常链接就行，不用自己调宿主接口。 */
          const signup = doc.createElement('a');
          signup.className = 'np-qw-step-link';
          signup.href = 'https://dev.qweather.com/';
          signup.target = '_blank';
          signup.rel = 'noopener noreferrer';
          signup.title = zh ? '点一下打开 QWeather 开发者注册页' : 'Open the QWeather signup page';
          signup.textContent = '注册QWeather账号';
          helpBody.append(signup);
          helpBody.append(el('p', 'np-qw-tip', '进入开发服务控制台的「设置」，找到并复制 API Host，填入上方的「QWeather API Host」。'));
          helpBody.append(el('p', 'np-qw-tip', '进入「项目管理」，创建项目；在项目中添加凭据，认证方式选择「API KEY」。'));
          help.append(helpBody);
          helpHead.addEventListener('click', () => {
            const hidden = helpBody.hidden;
            helpBody.hidden = !hidden;
            minus.textContent = hidden ? '−' : '+';
          });
          c.body.append(help);


          /* 图二 —— 实况检查间隔 + 对齐整点（已接配置）。 */
          c.body.append(el('div', 'np-qw-label', '实况检查间隔（分钟）'));
          c.body.append(gapIn);
          c.body.append(alignBox.el);

          /* 图三 —— 地点：上级行政区 / 国家代码 / 城市或区划 + 搜索。 */
          c.body.append(el('h3', 'np-qw-h np-qw-mt', '地点'));
          c.body.append(placePath);
          const cols = el('div', 'np-qw-cols');
          const col1 = el('div', 'np-qw-col');
          col1.append(el('div', 'np-qw-label', '上级行政区（可选）'));
          col1.append(adminIn);
          const col2 = el('div', 'np-qw-col');
          col2.append(el('div', 'np-qw-label', '国家或地区代码（可选）'));
          col2.append(codeIn);
          cols.append(col1, col2);
          c.body.append(cols);

          const searchBtn = ui.button(zh ? '搜索' : 'Search', {
            size: 'sm', variant: 'primary', onClick: () => void saveWeather(false),
          });
          const searchRow = el('div', 'np-qw-searchrow');
          searchRow.append(cityIn, searchBtn);
          c.body.append(searchRow);
          return c;
        }
        const qweatherCard = buildQweatherCard();

        /* 原来的本机 / 云端那一套收进第二张折叠卡，控件和逻辑都不动。 */
        function buildModelCard() {
          const opts = {
            title: zh ? '模型来源' : 'Model source',
            en: zh ? '本机 / 云端' : 'local / cloud',
            desc: '',
            defaultOpen: true,
          };
          const c = typeof ui.foldSheet === 'function'
            ? ui.foldSheet.call(ui, 'set-model-src', opts)
            : ui.sheet(opts);
          c.body.append(segHost, cloudBox, localBox);
          return c;
        }

        const modelCard = buildModelCard();

        root.append(qweatherCard.el, modelCard.el, foot);

        function paintNote() {
          statusLine.textContent = note ? note.text : '';
          statusLine.className = 'np-model-status' + (note && note.bad ? ' bad' : '');
        }

        function paintChips() {
          chipsBox.innerHTML = '';
          const list = (snap && snap.cloud && snap.cloud.modelList) || [];
          if (!list.length) return;
          chipsBox.append(el('span', 'np-chips-label', t.pickList));
          for (const name of list) {
            const chipEl = ui.chip(name, 'plain');
            chipEl.classList.add('np-playable');
            chipEl.addEventListener('click', () => {
              draft.model = name;
              modelInput.value = name;
            });
            chipsBox.append(chipEl);
          }
        }

        function render() {
          const src = (snap && snap.source) === 'cloud' ? 'cloud' : 'local';

          segHost.innerHTML = '';
          const seg = ui.segmented(
            [{ value: 'local', label: t.local }, { value: 'cloud', label: t.cloud }],
            { value: src, onSelect: (v) => void setSource(v) },
          );
          segHost.append(seg.el);

          // 开关就是这里：选本机，云端整块直接不显示
          cloudBox.hidden = src !== 'cloud';
          localBox.hidden = src === 'cloud';

          const cl = (snap && snap.cloud) || {};
          urlInput.value = draft.url || cl.url || '';
          // Key 永远不回填：只把「已设置 · 尾号」写进占位
          keyInput.value = draft.key;
          keyInput.placeholder = cl.keySet ? `${cl.keyMask}（已设置，留空＝不改）` : t.keyPh;
          modelInput.value = draft.model || cl.model || '';

          const lo = (snap && snap.local) || {};
          localInfo.textContent = lo.model
            ? `${lo.url || '-'}　·　${lo.model}${lo.vram ? `　·　${lo.vram}` : ''}`
            : t.nowNone;

          const mode = snap && snap.mode;
          if (mode === 'cloud') foot.textContent = t.nowCloud((snap.cloud && snap.cloud.model) || '-');
          else if (mode === 'local') foot.textContent = t.nowLocal((snap.local && snap.local.model) || '-');
          else foot.textContent = t.nowNone;

          paintChips();
          paintNote();
          for (const f of cardPainters) f();
        }

        async function reload() {
          try {
            snap = await call('snapshot');
            draft.url = (snap.cloud && snap.cloud.url) || '';
            draft.model = (snap.cloud && snap.cloud.model) || '';
            render();
          } catch (e) {
            note = { text: e instanceof Error ? e.message : String(e), bad: true };
            paintNote();
          }
        }

        async function setSource(src) {
          if (busy) return;
          busy = true;
          try {
            snap = await call('setSource', { source: src });
            note = null;
            render();
          } catch (e) {
            note = { text: e instanceof Error ? e.message : String(e), bad: true };
            paintNote();
          } finally {
            busy = false;
          }
        }

        async function readModels() {
          if (busy) return;
          busy = true;
          note = { text: t.read + '…' };
          paintNote();
          try {
            const r = await call('listModels', { url: draft.url, key: draft.key });
            if (r && r.models) snap = {...snap, ...r, cloud: {...(r.cloud || {})}};
            if (r && r.ok) note = { text: t.readOk(r.count ?? (r.models || []).length) };
            else note = { text: (r && r.error) || '读不到', bad: true };
            render();
          } catch (e) {
            note = { text: e instanceof Error ? e.message : String(e), bad: true };
            paintNote();
          } finally {
            busy = false;
          }
        }

        async function saveCloud() {
          if (busy) return;
          busy = true;
          try {
            const r = await call('saveCloud', { url: draft.url, key: draft.key, model: draft.model });
            if (r && r.ok) {
              draft.key = '';
              keyInput.value = '';
              snap = r.source ? r : (await call('snapshot'));
              note = { text: t.saved };
              render();
            } else {
              note = { text: (r && r.error) || '保存失败', bad: true };
              paintNote();
            }
          } catch (e) {
            note = { text: e instanceof Error ? e.message : String(e), bad: true };
            paintNote();
          } finally {
            busy = false;
          }
        }

        ctx.root.append(root);
        void reload();
      },
    },

    /**
     * 「设置」页签（0.16.50）：四张折叠卡。
     *
     * 照「大肥鱼语音全能包」那一页的结构：一张卡 = 一个功能块，标题 + 英文小字，
     * 右上 ±，折叠时右侧那行摘要（card.note）仍然可见 —— 收起状态也能一眼看到开着没有。
     * 折叠态由宿主的 ui.foldSheet 存进面板 memo，切页回来还是原来的开合。
     *
     * 老宿主没有 foldSheet 时退回 ui.sheet（平铺），不白屏。
     * 改一项存一项（call('set') 打后端，ctx.persist 落盘），保存成功只重画摘要与控件，
     * 不整页重建 —— 否则正在填的输入框会被清空。
     */
    settings: {
      mount(ctx) {
        const ui = ctx.ui;
        const zh = String(ctx.language ?? 'zh').toLowerCase().startsWith('zh');
        const call = (method, arg) => ctx.invoke(method, [arg ?? {}]);
        const doc = ctx.root.ownerDocument;
        const el = (tag, cls, text) => {
          const node = doc.createElement(tag);
          if (cls) node.className = cls;
          if (text !== undefined && text !== null) node.textContent = text;
          return node;
        };

        /* 0.17.13：默认原文兜底。宿主快照里没带 aiPlayPromptDefault 时（老版本后端、
           字段被裁剪）就用这份本地副本 —— 用户打开设置必须看得见文字，不能空着。 */
        const AI_PLAY_PROMPT_FALLBACK = '点歌。按歌名搜，把这批歌排到歌单最前面，然后从这批的第一首开始连续播放。'
          + '对方明确说"放某首歌""听某首歌"时用它（auto=false，会记次数，同一首点两次会自动加进"我喜欢的音乐"）。'
          + '他说"放几首"但没给歌名时，你自己先挑好再调，并传 auto=true（歌是你选的，不记账）。'
          + '你自己主动挑的歌也必须传 auto=true。'
          + '一次可以给一到多首，会按给的顺序连续播放。'
          + '放好以后只回一句「现在为你播放{歌手}的《{歌名}》」；'
          + '不知道歌手就说「现在为你播放《{歌名}》」。';
        const data = { values: {}, options: {}, known: {}, chainChartNames: '', chainChartMax: 8, texts: {}, quiet: {} };
        const root = el('div', 'np-set');
        const hint = ui.msgline(zh ? '改一项存一项，存完立刻生效，不用重启。' : 'Each change is saved on the spot and takes effect immediately.');
        let note = null;
        let busy = false;

        const GROUPS = [
          {
            id: 'accompany',
            title: zh ? '陪听开关' : 'Companion switches',
            en: 'the three cards',
            desc: zh
              ? '「今天听点什么」下面那三张卡，加上到点出声，全在这张卡里。关掉的那张不调模型、不抓评论、到点也不出声，面板上只留一句「打开单独开关就显示内容」。'
              : 'Every switch behind the three detail cards and the spoken lines.',
            items: [
              { key: 'cardsOn', kind: 'bool' },
              { key: 'showLiked', kind: 'bool', group: 'hear', groupLabel: zh ? '卡② 她听这首歌时 · 下面两项只管这张卡' : 'Card ② only' },
              { key: 'sayBody', kind: 'bool', group: 'hear' },
              { key: 'sayBodyFirst', kind: 'bool', group: 'hear' },
              { key: 'cardFeel', kind: 'bool', group: 'feel', groupLabel: zh ? '卡③ 她听完什么感觉 · 下面只管这张卡' : 'Card ③ only' },
              { key: 'cardComment', kind: 'bool', group: 'comment', groupLabel: zh ? '卡④ 别人怎么说 · 下面只管这张卡' : 'Card ④ only' },
              { key: 'cardsPreview', kind: 'bool' },
              { key: 'announce', kind: 'bool' },
              /* 0.17.11：安静时间（开始 / 结束 / 开关）。窗口内一句都不出声，
                 自动推歌也不触发；推荐刷新、榜单缓存这些后台动作照常跑。 */
              { key: 'quietStart', kind: 'time', group: 'quiet', groupLabel: zh ? '安静时间 · 起始 / 结束 / 开关（窗口内一句都不出声）' : 'Quiet hours' },
              { key: 'quietEnd', kind: 'time', group: 'quiet' },
              { key: 'quietOn', kind: 'bool', group: 'quiet' },
            ],
          },
          {
            id: 'ai',
            title: zh ? 'AI 设置' : 'AI behaviour',
            en: 'AI takeover',
            desc: zh
              ? '收到「随机播放」的请求时怎么办。打开后不再随便抽一首，而是按「今天听点什么」的第一首开局，并把接力点歌打开；回话固定是一句「正在为你播放……并自动开启接力点歌」。'
              : 'What happens when a random-play request arrives.',
            items: [
              { key: 'aiRandomChain', kind: 'bool' },
              /* 0.17.10：发给 AI 的前置语句（netease_play 的工具说明）改成可写。
                 默认原文当占位符，清空即回默认。 */
              { key: 'aiPlayPrompt', kind: 'text', rows: 8 },
            ],
          },
          /* 0.16.58：接力点歌单独一张卡（原来只有一个小勾挂在「此刻设置」末尾）。
             这里的项和卡②③④ 一样用分组小方框圈起来，以后继续往里加就行。 */
          {
            id: 'chain',
            title: zh ? '接力点歌' : 'Chain the next song',
            en: 'chaining',
            desc: zh
              ? '这首歌快放完时，她把下一首也挑好递过来，一首接一首。只在你「接受了她推的那首」之后才接 —— 你自己叫她放的歌、程序自己放的，一律不接。递出一首之后会立刻刷新推荐，再从新推荐里读下一首。'
              : 'She hands over the next song before this one ends. Only after you accept a song she offered; songs you asked for never chain.',
            items: [
              { key: 'chainPick', kind: 'bool' },
              /* 0.17.33：接力挑歌的来源二选一（用户口径：点一个开，另一个自动关）。
                 「今天听点什么」= 卡① 推荐名单；「按天气听点什么」= 卡片5 天气名单。
                 自动接力这一路完全跟着这个开关走，播报那一句也跟着换。 */
              {
                key: 'chainSource',
                kind: 'choice',
                options: [
                  { value: 'reco', label: zh ? '今天听点什么' : 'Daily card' },
                  { value: 'wx', label: zh ? '按天气听点什么' : 'Weather card' },
                ],
              },
              /* 0.16.89：接力那声「即将播放…」单独一个勾（用户口径：语音播报要能关） */
              { key: 'chainSpeak', kind: 'bool' },
              { key: 'chainCharts', kind: 'multi', group: 'chartSrc', groupLabel: zh ? '候选从哪些榜取 · 下面这一项就是勾榜' : 'Charts to pick from' },
              { key: 'chainPlaylist', kind: 'bool', group: 'recoList', groupLabel: zh ? '接力落进「AI 推荐歌单」· 下面三项只管这张歌单' : 'The AI playlist' },
              { key: 'chainClearDaily', kind: 'bool', group: 'recoList' },
              { key: 'chainClearHour', kind: 'int', group: 'recoList' },
              /* 0.16.86：原来「此刻设置」那一整组搬进来了（用户 2026-11-23 要求「整组过去，打个括号」）。
              这四项还是用 group 打一个括号圈住，一眼看得出它们是一整块，不是接力本身的项。 */
              { key: 'selfPick', group: 'idle', groupLabel: zh ? '此刻设置（整块从上面挪进来的）' : 'While idle', kind: 'bool' },
              { key: 'idleFirstMin', group: 'idle', kind: 'int' },
              { key: 'idleRepeatMin', group: 'idle', kind: 'int' },
              { key: 'askTwoOnly', group: 'idle', kind: 'bool' },
              ],
          },
          {
            id: 'music',
            title: zh ? '听歌设置' : 'Listening',
            en: 'playlists & client',
            desc: zh
              ? '歌单、加喜欢、以及跟网易云客户端打交道的方式。数据库和出声软件那一摊在第④张卡里。'
              : 'Playlists, favourites, and how she talks to the client.',
            items: [
              { key: 'playlist', kind: 'select' },
              { key: 'autoFav', kind: 'bool' },
              { key: 'favThreshold', kind: 'int' },
              { key: 'allowRestart', kind: 'bool' },
              { key: 'cdpPort', kind: 'int' },
              { key: 'clientExe', kind: 'line' },
            ],
          },
          {
            id: 'store',
            title: zh ? '模型与语音' : 'Model & voice',
            en: 'models & tts',
            desc: zh
              ? '模型从哪来、用哪个、显存怎么省，以及用哪种方式出声。这一块改完第一次调用会重新加载模型，会多等几秒。'
              : 'Where the model comes from, which one to use, and how she speaks.',
            items: [
              { key: 'modelSource', kind: 'select' },
              { key: 'ollamaUrl', kind: 'line' },
              { key: 'embedModel', kind: 'select' },
              { key: 'vramMode', kind: 'select' },
              { key: 'chatModel', kind: 'select' },
              /* 0.1.07：选项不再写死，改成从后端登记表（settingsOptions.ttsEngine）取，
                 以后加引擎只改后端一处。音色紧跟引擎后面，地址放最后。
                 0.1.08（用户口径）：音色框只在「这一路真有多个音色可选」时才出现 ——
                 选 GPT-SoVITS 时它只有一项（随语音包配置），画出来是废的，直接不画；
                 地址框同理，引擎标了不需要地址的不画。 */
              {
                key: 'ttsEngine',
                kind: 'choice',
                optionsKey: 'ttsEngine',
              },
              { key: 'ttsVoice', kind: 'select', showIf: (_v, o) => o.ttsVoicePickable === true },
              { key: 'ttsUrl', kind: 'line', showIf: (_v, o) => o.ttsUrlNeeded !== false },
            ],
          },
        ];

        /**
         * 第 5 张卡「提示词」（0.16.52）。
         *
         * 三张卡每次开口都是同一套开头和结尾，听多了会腻。这里把「说之前怎么引导」
         * 和「说完要求什么（字数、别复述歌词）」拆出来让人自己写；歌词、歌名、热评原文
         * 还是程序拼，所以他改不到数据，只能改腔调。
         * 0.16.91：输入框里**预填**的就是程序默认原文（不再是灰字 / 空格子），可以直接在上面改；
         * 改回和默认一模一样再保存，仍然算「用默认」，不会被记成自定义。
         * 这张卡不「改一项存一项」：六段长文本边打边存太闹，攒好点一次「保存」。
         */
        const PROMPT_SECTIONS = [
          {
            id: 'hear',
            title: zh ? '② 她听这首歌时' : '② When she hears it',
            desc: zh
              ? '程序把歌词塞进来，她说一个画面或一种情绪。字数那类硬要求留在「结尾」，不然容易只吐半句。'
              : 'Program inserts the lyric; you say what comes before and after.',
            head: 'promptHearHead',
            headLabel: zh ? '开头怎么说（引导她的角度）' : 'Opening (the angle)',
            tail: 'promptHearTail',
            tailLabel: zh ? '结尾怎么要求（字数 / 不许做什么 / 输出格式）' : 'Requirements (length, format, bans)',
          },
          {
            id: 'feel',
            title: zh ? '③ 她听完什么感觉' : '③ What it felt like',
            desc: zh
              ? '引一句歌词写「感觉：…」再给一个「喜欢/一般/不喜欢」。本机和云端默认不一样，你写过就用你写的。'
              : 'A lyric, a feeling line, and a like/so-so/no verdict.',
            head: 'promptFeelHead',
            headLabel: zh ? '开头怎么说（引导她的角度）' : 'Opening (the angle)',
            tail: 'promptFeelTail',
            tailLabel: zh ? '结尾怎么要求（两行格式 / 字数 / 不许做什么）' : 'Requirements (two lines, length, bans)',
          },
          {
            id: 'comment',
            title: zh ? '④ 别人怎么说' : '④ What others say',
            desc: zh
              ? '程序把一条热评原文塞进来，她再说两三句自己的看法。想让她别一开口就「我觉得」，改这里就行。'
              : 'Program inserts one hot comment; she replies with her own take.',
            head: 'promptCommentHead',
            headLabel: zh ? '开头怎么说（引导她的角度）' : 'Opening (the angle)',
            tail: 'promptCommentTail',
            tailLabel: zh ? '结尾怎么要求（开头词 / 字数 / 不许做什么）' : 'Requirements (opening word, length, bans)',
          },
        ];

        /** 0.16.96：标题与说明一律按 ID 从 data.texts 取（后端 strings.js 是唯一来源）。
         * 取不到就退回条目里残留的 _title / _desc（理论上已经没有），再退回空串。 */
        const lore = (it, f) => (data.texts && data.texts['set.' + it.key + '.' + f]) || it['_' + f] || '';

        /** 建卡：有 foldSheet 就折叠（默认收起），没有就平铺。 */
        const card = (g) => {
          const opts = { title: g.title, en: g.en, desc: g.desc, defaultOpen: g.open === true };
          const fold = ui.foldSheet;
          if (typeof fold === 'function') return fold.call(ui, 'set-' + g.id, opts);
          return ui.sheet(opts);
        };

        /** 一行：左边标题，右边控件，下面一行灰字说明。 */
        const row = (it) => {
          const line = el('div', 'np-setrow');
          const head = el('div', 'np-sethead');
          head.append(el('div', 'np-setlabel', lore(it, 'title')));
          line.append(head);
          const noteText = lore(it, 'desc');
          if (noteText) line.append(el('p', 'np-muted np-setnote', noteText));
          return line;
        };

        const ctrls = new Map();   // key -> { sync(value, enabled) }
        const cards = [];
        const pInputs = new Map(); // 提示词 key -> textarea
        let promptCard = null;     // 第 5 张卡的句柄（摘要单独刷）
        let dirty = false;         // 提示词有没有还没保存的改动

        const makeControl = (it, line) => {
          const value = data.values[it.key];
          /* 0.17.33：二选一（互斥）。点一个就把另一个的「开」去掉 —— 只存一个值，
             不用两个布尔各存一份，省得以后出现「两个都开」。 */
          if (it.kind === 'choice') {
            const wrap = el('div', 'np-choice');
            const btns = [];
            /* 0.1.02：原来这里写死 chainSource 的两个值（wx/reco），加第三个二选一就会串。
               现在按 options 自己的 value 画，值不认识就落到第一个选项。
               0.1.07：也可以给 optionsKey，从快照的 options 表里取（引擎登记表在后端）。 */
            const opts = Array.isArray(it.options) ? it.options
              : ((data.options && Array.isArray(data.options[it.optionsKey])) ? data.options[it.optionsKey] : []);
            const normV = (v) => (opts.some((o) => o.value === v) ? v : (opts[0] && opts[0].value));
            const paintSel = (v) => {
              const nv = normV(v);
              for (const b of btns) b.el.classList.toggle('on', b.value === nv);
            };
            const commit = (v, n = 0) => {
              if (busy && n < 10) { setTimeout(() => commit(v, n + 1), 300); return; }
              void save(it.key, v);
              /* 0.17.62（用户口径）：切到「按天气听点什么」时，第一次开口不到 5 分钟的，
                 直接顶成 5 分钟并存下去（天气名单/向量还没算完，早问没用）。 */
              if (it.key === 'chainSource' && v === 'wx') {
                const cur = Number(data.values.idleFirstMin);
                if (!Number.isFinite(cur) || cur < 5) {
                  data.values.idleFirstMin = 5;
                  const ctl = ctrls.get('idleFirstMin');
                  if (ctl && typeof ctl.sync === 'function') ctl.sync(5);
                  void save('idleFirstMin', 5);
                }
                const ctl2 = ctrls.get('idleFirstMin');
                if (ctl2 && typeof ctl.sync === 'function') ctl2.sync(Number(data.values.idleFirstMin));
              }
            };
            for (const one of opts) {
              const b = ui.button(one.label, {
                size: 'sm',
                variant: 'plain',
                onClick: () => { paintSel(one.value); commit(one.value); },
              });
              b.classList.add('np-choice-btn');
              btns.push({ value: one.value, el: b });
              wrap.append(b);
            }
            paintSel(data.values[it.key]);
            ctrls.set(it.key, { sync: (v) => paintSel(v) });
            return wrap;
          }
          if (it.kind === 'bool') {
            const box = ui.checkbox('', {
              checked: value === true,
              onChange: (v) => void save(it.key, v),
            });
            box.input.setAttribute('aria-label', lore(it, 'title'));
            const wrap = el('div', 'switchbox');
            wrap.append(box.el);
            ctrls.set(it.key, { sync: (v, enabled) => { box.setChecked(v === true); box.input.disabled = enabled === false; } });
            return wrap;
          }
          if (it.kind === 'int') {
            /* 0.17.62（用户口径）：天气源时「安静多少分钟后开口」最少 5 分钟 ——
               输入框直接给 min=5，填 1~4 一律顶到 5 再存。其他数字项不受影响。 */
            const isFirstAsk = it.key === 'idleFirstMin';
            const floor = () => (isFirstAsk && data.values.chainSource === 'wx' ? 5 : 1);
            const inp = ui.input({
              type: 'number',
              cls: 'mono np-num',
              value: value == null ? '' : String(value),
              onChange: (v) => {
                let n = Number(v);
                if (!Number.isFinite(n)) return;
                const min = floor();
                if (n < min) n = min;
                if (String(n) !== String(v)) inp.value = String(n);
                data.values[it.key] = n;
                void save(it.key, n);
              },
            });
            if (isFirstAsk) inp.setAttribute('min', String(floor()));
            ctrls.set(it.key, {
              sync: (v) => {
                inp.value = v == null ? '' : String(v);
                if (isFirstAsk) inp.setAttribute('min', String(floor()));
              },
            });
            return inp;
          }
          /* 0.17.10：长文本（发给 AI 的前置语句）。0.17.14 起改成「保存 / 取消 / 设为默认」
             三个按钮，不再边打边存 —— 有「取消」就必须能真的撤销，自动存会让它失效。 */
          if (it.kind === 'text') {
            const def = String((it.key === 'aiPlayPrompt')
              ? (data.aiPlayPromptDefault || AI_PLAY_PROMPT_FALLBACK)
              : ((data.promptDefaults && data.promptDefaults[it.key]) || ''));
            const ta = doc.createElement('textarea');
            ta.className = 'np-prompt mono';
            ta.rows = Number(it.rows) || 6;
            ta.spellcheck = false;
            ta.placeholder = def;
            ta.title = def;
            // 0.17.12（用户口径：默认文本放进去，让知道怎么改）：没自定义过时直接把默认原文
            // 填进框里，而不是只留一行灰字 —— 看着就知道从哪句开始改。
            ta.value = (typeof value === 'string' && value.trim()) ? value : def;

            const wrap = el('div', 'np-promptwrap');
            wrap.append(ta);
            const bar = el('div', 'np-promptbar');
            bar.append(
              ui.button(zh ? '保存' : 'Save', { size: 'sm', variant: 'primary', onClick: () => void save(it.key, ta.value) }),
              ui.button(zh ? '取消' : 'Cancel', { size: 'sm', variant: 'plain', onClick: () => {
                const saved = data.values[it.key];
                ta.value = (typeof saved === 'string' && saved.trim()) ? saved : def;
                note = { text: zh ? '已取消，框里回到最近一次保存的内容。' : 'Reverted.' };
                paint();
              } }),
              ui.button(zh ? '设为默认' : 'Defaults', { size: 'sm', variant: 'plain', onClick: () => {
                ta.value = def;
                void save(it.key, '');
              } }),
            );
            wrap.append(bar);

            ctrls.set(it.key, { sync: (v) => {
              const s = typeof v === 'string' && v.trim() ? v : def;
              if (ta.value !== s && doc.activeElement !== ta) ta.value = s;
            } });
            return wrap;
          }
          /* 0.17.11：HH:MM（安静时间的开始 / 结束）。只收 24 小时制的「23:00」「7:30」，
             写错就退回上一次的值，不让一个手滑把整晚静音搞成 0000。 */
          if (it.kind === 'time') {
            const norm = (v) => {
              const m = /^([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)$/.exec(String(v == null ? '' : v).trim());
              if (!m) return '';
              return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
            };
            let last = norm(value) || '';
            const inp = ui.input({
              type: 'text',
              cls: 'mono np-time',
              value: String(value == null ? '' : value),
              placeholder: 'HH:MM',
              onChange: (v) => {
                const n = norm(v);
                if (!n) {
                  inp.value = last;
                  note = { text: zh ? '时间要写成 HH:MM（24 小时制，例如 23:00）。' : 'Use HH:MM (24h).', bad: true };
                  paint();
                  return;
                }
                last = n;
                inp.value = n;
                void save(it.key, n);
              },
            });
            inp.maxLength = 5;
            ctrls.set(it.key, { sync: (v) => {
              const n = norm(v);
              last = n || last;
              if (doc.activeElement !== inp) inp.value = String(v == null ? '' : v);
            } });
            return inp;
          }
          /* 多选（0.16.60）：按钮显示「已选 N 个 · 热歌榜、飙升榜 ›」，点开在下面展成
             七组可勾列表。没用宿主 select —— 那是单选的；也没做「三个下拉」，那要存三个值。
             展开区挂在整行末尾（文档流），不做浮层：卡片有自己的 overflow，浮层会被裁。 */
          if (it.kind === 'multi') {
            const groups = Array.isArray(data.options[it.key]) ? data.options[it.key] : [];
            const maxN = Number(data.chainChartMax) || 8;
            const wrap = el('div', 'np-multi');
            const btnEl = el('button', 'np-btn np-multi-btn');
            btnEl.type = 'button';
            const panel = el('div', 'np-multi-panel');
            panel.hidden = true;
            const boxes = [];

            const readIds = () => String(data.values[it.key] ?? '')
              .split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
            const labelOf = (id) => {
              for (const g of groups) {
                const hit = (g.items || []).find((x) => x.value === id);
                if (hit) return hit.label;
              }
              return '';
            };
            const setBtn = (ids) => {
              if (!ids.length) {
                btnEl.textContent = zh ? '一个都没勾（按默认两个榜） ›' : 'none (defaults) ›';
                return;
              }
              const names = ids.map(labelOf).filter(Boolean);
              const head = names.slice(0, 2).join('、');
              btnEl.textContent = zh
                ? `已选 ${ids.length} 个 · ${head}${names.length > 2 ? ' 等' : ''} ›`
                : `${ids.length} selected ›`;
            };
            const syncBoxes = (ids) => {
              for (const b of boxes) b.setChecked(ids.includes(b.id));
            };
            /**
             * 勾完就存。`save` 有 busy 闸（一次只写一项），连点两下时第二个勾会被吞掉 ——
             * 界面勾着、盘上没存，这种「勾了没反应」最难查，所以这里排队重试。
             */
            const commit = (ids, n = 0) => {
              if (busy && n < 10) {
                setTimeout(() => commit(ids, n + 1), 300);
                return;
              }
              void save(it.key, ids.join(','));
            };

            for (const g of groups) {
              const gtitle = el('div', 'np-multi-g', g.label);
              panel.append(gtitle);
              for (const one of g.items || []) {
                const box = ui.checkbox(one.label, {
                  checked: false,
                  onChange: (on) => {
                    const ids = readIds();
                    let next;
                    if (on) {
                      if (ids.includes(one.value)) return;
                      if (ids.length >= maxN) {
                        note = { text: zh ? `最多勾 ${maxN} 个榜，再多算推荐就慢得没法用了。` : `Up to ${maxN} charts.`, bad: true };
                        paint();
                        box.setChecked(false);
                        return;
                      }
                      next = [...ids, one.value];
                    } else {
                      next = ids.filter((x) => x !== one.value);
                      if (!next.length) {
                        note = { text: zh ? '至少要留一个榜 —— 全不勾就按默认两个榜算。' : 'Keep at least one chart.', bad: true };
                        paint();
                        box.setChecked(true);
                        return;
                      }
                    }
                    void commit(next);
                  },
                });
                const itemRow = el('div', 'np-multi-item');
                itemRow.append(box.el);
                panel.append(itemRow);
                boxes.push({ id: one.value, setChecked: (v) => box.setChecked(v) });
              }
            }

            btnEl.addEventListener('click', (e) => {
              if (e && e.preventDefault) e.preventDefault();
              panel.hidden = !panel.hidden;
              wrap.classList.toggle('open', !panel.hidden);
            });

            wrap.append(btnEl);
            if (line) line.append(panel);
            const ids0 = readIds();
            setBtn(ids0);
            syncBoxes(ids0);
            ctrls.set(it.key, { sync: (v) => {
              const ids = String(v ?? '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
              setBtn(ids);
              syncBoxes(ids);
            } });
            return wrap;
          }
          if (it.kind === 'select') {
            const opts = Array.isArray(data.options[it.key]) && data.options[it.key].length
              ? data.options[it.key]
              : [{ value: '', label: zh ? '（没有可选项）' : '(none)' }];
            const sel = ui.select({
              cls: 'np-sel',
              options: opts,
              value: value == null ? '' : String(value),
              onChange: (v) => void save(it.key, v),
            });
            ctrls.set(it.key, { sync: (v) => { sel.value = v == null ? '' : String(v); } });
            return sel;
          }
          /* 0.1.02（用户口径）：地址 / 路径这类框压成单行高。 */
          const ADDR_KEYS = new Set(['ollamaUrl', 'ttsUrl', 'clientExe', 'qwApiHost']);
          const inp = ui.input({
            cls: ADDR_KEYS.has(it.key) ? 'mono np-addr' : 'mono',
            value: value == null ? '' : String(value),
            onChange: (v) => void save(it.key, v),
          });
          ctrls.set(it.key, { sync: (v) => { inp.value = v == null ? '' : String(v); } });
          return inp;
        };

        /** 每张卡右侧那行摘要：折叠着也看得到「现在是开是关」。 */
        const summary = (id) => {
          const v = data.values;
          if (id === 'accompany') {
            if (v.cardsOn !== true) return zh ? '陪听：全部关闭' : 'cards: all off';
            // 卡② 两个勾只要有一个开着，这张卡就算在开
            const hear2 = (v.showLiked === true || v.sayBody === true) ? 1 : 0;
            const sub = hear2 + ['cardFeel', 'cardComment', 'cardsPreview'].filter((k) => v[k] === true).length;
            return zh
              ? `陪听：开 · 三张卡 ${sub}/4 · 出声：${v.announce === true ? '开' : '关'}`
              : `cards: ${sub}/4 · voice: ${v.announce === true ? 'on' : 'off'}`;
          }
          if (id === 'idle') {
            return zh
              ? `自选：${v.selfPick === true ? '开' : '关'} · ${v.idleFirstMin} 分钟开口`
              : `pick: ${v.selfPick === true ? 'on' : 'off'} · ${v.idleFirstMin} min`;
          }
          // 0.16.58：接力点歌单独一张卡了，摘要也搬过来
          if (id === 'chain') {
            if (v.chainPick !== true) return zh ? '接力：关' : 'chain: off';
            const charts = data.chainChartNames || '';
            const list = v.chainPlaylist === true
              ? (zh
                ? `落进「AI 推荐歌单」${v.chainClearDaily === true ? `· 每天 ${v.chainClearHour} 点清零` : ''}`
                : `into the AI playlist${v.chainClearDaily === true ? ` · cleared at ${v.chainClearHour}:00` : ''}`)
              : (zh ? '推荐页点了也走默认歌单' : 'picks go to the default playlist');
            return zh
              ? `接力：开 · 来源：${v.chainSource === 'wx' ? '按天气听点什么' : '今天听点什么'}（只刷新这一张） · 播报：${v.chainSpeak === false ? '关' : '开'} · 榜：${charts} · ${list}`
              : `chain: on · from: ${v.chainSource === 'wx' ? 'weather card' : 'daily card'} (only this one refreshes) · announce: ${v.chainSpeak === false ? 'off' : 'on'} · charts: ${charts} · ${list}`;
          }
          if (id === 'music') {
            const name = data.playlistName || (v.playlist ? String(v.playlist) : (zh ? '默认歌单' : 'default'));
            return zh
              ? `歌单：${name} · 加喜欢：${v.autoFav === true ? `满 ${v.favThreshold} 次` : '关'}`
              : `list: ${name} · fav: ${v.autoFav === true ? 'on' : 'off'}`;
          }
          if (id === 'store') {
            const src = v.modelSource === 'cloud' ? (zh ? '云端' : 'cloud') : (zh ? '本机' : 'local');
            const m = src === (zh ? '云端' : 'cloud') ? (data.cloudModel || '') : (v.chatModel || '');
            return zh
              ? `${src}${m ? ' · ' + m : ' · 没选模型'} · 出声：${v.ttsUrl ? '已配' : '未配'}`
              : `${src}${m ? ' · ' + m : ' · no model'} · tts: ${v.ttsUrl ? 'set' : 'none'}`;
          }
          return '';
        };

        /** 六段里已经自己写过几段（空 = 用默认，所以只数非空）。 */
        const promptCount = () => PROMPT_SECTIONS.reduce(
          (n, s) => n + [s.head, s.tail].filter((k) => String(data.values[k] ?? '').trim()).length,
          0,
        );

        /** 提示词卡右上那行摘要：折叠着也能看出「改了没存 / 改了几段」。 */
        const promptNote = () => {
          const base = zh ? `已自定义 ${promptCount()}/6 段` : `${promptCount()}/6 custom`;
          return dirty ? (zh ? `未保存 · ${base}` : `unsaved · ${base}`) : base;
        };

        /** 输入时只刷这张卡的摘要，别整页 sync —— 否则正在别的框里打字会被拽回旧值。 */
        const touchPrompt = () => {
          dirty = true;
          if (promptCard) promptCard.note.textContent = promptNote();
        };

        const btn = (label, cls, fn) => {
          const b = doc.createElement('button');
          b.type = 'button';
          b.className = 'np-btn' + (cls ? ' ' + cls : '');
          b.textContent = label;
          b.addEventListener('click', fn);
          return b;
        };

        /** 某一格的程序默认原文（预填和「改没改」的比对都用它）。 */
        const pDefault = (key) => String((data.promptDefaults && data.promptDefaults[key]) || '');

        /**
         * 把值填回输入框（首次建卡、取消、存完都用这一处）。
         * 0.16.91（第 144 节）：没存过自定义值的格子**填默认原文**，不再是空格子 ——
         * 用户要的是「照着现在默认的改」，不是「全部重新输入一遍」。
         */
        function fillPrompts() {
          for (const [key, ta] of pInputs) ta.value = String(data.values[key] ?? '') || pDefault(key);
          dirty = false;
          if (promptCard) promptCard.note.textContent = promptNote();
        }

        /**
         * 收六格的值交给 setMany。
         * 和默认原文一样（包括「改完又改回去」）就交空串 —— 仍是「用默认」：
         * 既不占自定义名额，将来默认换了也跟着换。
         */
        const collectPrompts = () => {
          const items = [];
          for (const [key, ta] of pInputs) {
            const v = String(ta.value || '');
            items.push({ key, value: v.trim() === pDefault(key).trim() ? '' : v });
          }
          return items;
        };

        /** 六段一起落盘（setMany），空串 = 回到默认。半套写进去的情况不会发生。 */
        async function writePrompts(items, okText) {
          if (busy) return;
          busy = true;
          try {
            const r = await call('setMany', { items });
            if (r && r.ok) {
              data.values = r.values;
              data.promptDefaults = r.promptDefaults || data.promptDefaults;
              data.aiPlayPromptDefault = r.aiPlayPromptDefault || data.aiPlayPromptDefault || '';
              note = { text: okText };
              fillPrompts();
              paint();
            } else {
              note = { text: (r && r.error) || (zh ? '没保存上' : 'not saved'), bad: true };
              paint();
            }
          } catch (e) {
            note = { text: e instanceof Error ? e.message : String(e), bad: true };
            paint();
          } finally {
            busy = false;
          }
        }

        /** 建第 5 张卡：三组 ×（开头 + 结尾），底下保存 / 取消 / 还原默认。 */
        function buildPromptCard() {
          const opts = {
            title: zh ? '提示词' : 'Prompts',
            en: 'what she is told',
            desc: zh
              ? '三张卡每次开口都是同一个腔调，听多了会腻 —— 这里可以自己改开头和结尾。框里已经是程序原来的默认，直接在框里改就行（不用先把字删光重打）；改回和默认一样也仍算用默认。改完点「保存」才生效。'
              : 'Every box comes pre-filled with the built-in default, so you edit it in place. Leaving it unchanged still counts as using the default.',
            defaultOpen: false,
          };
          const c = typeof ui.foldSheet === 'function'
            ? ui.foldSheet.call(ui, 'set-prompt', opts)
            : ui.sheet(opts);

          for (const s of PROMPT_SECTIONS) {
            const box = el('div', 'np-promptbox');
            box.append(el('div', 'np-prompttitle', s.title));
            if (s.desc) box.append(el('p', 'np-muted np-setnote', s.desc));
            for (const [key, label, rows] of [[s.head, s.headLabel, 2], [s.tail, s.tailLabel, 4]]) {
              const field = el('div', 'np-promptfield');
              field.append(el('div', 'np-muted np-promptsublabel', label));
              const ta = doc.createElement('textarea');
              ta.className = 'np-prompt mono';
              ta.rows = rows;
              ta.spellcheck = false;
              const def = (data.promptDefaults && data.promptDefaults[key]) || '';
              ta.placeholder = def;
              ta.title = def;
              ta.addEventListener('input', touchPrompt);
              field.append(ta);
              pInputs.set(key, ta);
              box.append(field);
            }
            c.body.append(box);
          }

          const bar = el('div', 'np-promptbar');
          bar.append(
            btn(zh ? '保存' : 'Save', 'primary', () => void writePrompts(
              collectPrompts(),
              zh ? '提示词已保存，下一次生成就用新的。' : 'Saved. Next line uses it.',
            )),
            btn(zh ? '取消' : 'Cancel', '', () => {
              fillPrompts();
              note = { text: zh ? '已取消，输入框回到保存过的值。' : 'Reverted to saved values.' };
              paint();
            }),
            btn(zh ? '还原默认' : 'Defaults', 'ghost', () => void writePrompts(
              PROMPT_SECTIONS.flatMap((s) => [{ key: s.head, value: '' }, { key: s.tail, value: '' }]),
              zh ? '已恢复默认，六段都回到程序原文。' : 'All six back to defaults.',
            )),
          );
          c.body.append(bar);
          fillPrompts();   // 先备好值，避免首屏一闪是空的
          return c;
        }

        const paint = () => {
          for (const { g, card: c } of cards) {
            c.note.textContent = summary(g.id);
          }
          if (promptCard) promptCard.note.textContent = promptNote();
          // 总闸关掉时，四个子项置灰 —— 一眼看出「现在点了也没用」。
          const gate = data.values.cardsOn === true;
          const GATED = ['showLiked', 'sayBody', 'sayBodyFirst', 'cardFeel', 'cardComment', 'cardsPreview'];
          for (const key of GATED) {
            const s = ctrls.get(key);
            if (s) s.sync(data.values[key], gate);
          }
          for (const [key, s] of ctrls) {
            if (GATED.includes(key)) continue;
            s.sync(data.values[key], true);
          }
          hint.textContent = note && note.text ? note.text : (zh ? '改一项存一项，存完立刻生效，不用重启。' : 'Each change is saved on the spot.');
          hint.classList.toggle('bad', !!(note && note.bad));
        };

        async function reload() {
          try {
            const r = await call('snapshot');
            if (!r || !r.values) throw new Error((r && r.error) || '读不到设置');
            data.values = r.values;
            data.options = r.options || {};
            data.known = r.known || {};
            data.playlistName = r.playlistName || '';
            data.chainChartNames = r.chainChartNames || '';
            data.chainChartMax = r.chainChartMax || data.chainChartMax;
            data.promptDefaults = r.promptDefaults || data.promptDefaults || {};
            data.aiPlayPromptDefault = r.aiPlayPromptDefault || data.aiPlayPromptDefault || '';
            data.texts = r.texts || data.texts || {};
            data.quiet = r.quiet || {};
            render();
            fillPrompts();   // 二次 reload（保存失败时）要把输入框拉回盘上值
            paint();
          } catch (e) {
            hint.textContent = e instanceof Error ? e.message : String(e);
            hint.classList.add('bad');
          }
        }

        async function save(key, value) {
          if (busy) return;
          busy = true;
          try {
            const r = await call('set', { key, value });
            if (r && r.ok) {
              data.values = r.values;
              data.options = r.options || data.options;
              data.playlistName = r.playlistName || '';
              data.chainChartNames = r.chainChartNames || data.chainChartNames || '';
              data.chainChartMax = r.chainChartMax || data.chainChartMax;
              note = null;
              paint();
            } else {
              note = { text: (r && r.error) || (zh ? '没保存上' : 'not saved'), bad: true };
              paint();
              await reload();   // 控件回到盘上的真实值，别显示一个没存进去的数
            }
          } catch (e) {
            note = { text: e instanceof Error ? e.message : String(e), bad: true };
            paint();
          } finally {
            busy = false;
          }
        }

        /**
         * 0.17.43（C4，用户口径）：临时的「她现在保持安静」也要有设置入口，
         * 不只面板上那个小按钮。切换走现有 `quietSet`，不新增配置键（它本来就不落盘）。
         */
        function quietRow() {
          const q = data.quiet || {};
          const row = el('div', 'np-setrow');
          const head = el('div', 'np-sethead');
          head.append(el('div', 'np-setlabel', zh ? '安静状态（临时）' : 'Quiet now'));
          const btn = ui.button(
            q.on ? (zh ? '恢复主动开口' : 'Resume speaking') : (zh ? '让她先安静' : 'Stay quiet'),
            {
              size: 'sm',
              onClick: async () => {
                btn.disabled = true;
                try { await call('quietSet', [{ on: !q.on }]); } catch { /* 下次再试 */ }
                btn.disabled = false;
                await reload();
              },
            },
          );
          head.append(btn);
          row.append(head);
          row.append(el('div', 'np-setdesc', q.on
            ? (zh ? '她这会儿不会主动开口；你下次操作、或重启她，就恢复正常。' : 'She will not speak up until you act or restart.')
            : (zh ? '安静够久时她会主动开口问要不要放歌。' : 'She may speak up when it has been quiet for a while.')));
          return row;
        }

        /** 建控件：只建一次，之后靠 sync 改值。 */
        function render() {
          if (promptCard) return;   // 已经建过（reload 会再进来一次，别重复叠卡片）
          for (const g of GROUPS) {
            const c = card(g);
            /* 0.16.57：items 可以带 `group` —— 同一组的连着几项会被框进一个带标签的小方框，
               一眼能看出「这几项都是在改同一张卡」（用户要的卡② 那个框）。 */
            const boxes = new Map();
            for (const it of g.items) {
              /* 0.1.08：showIf —— 这一项在当前取值下没意义就不画（音色 / 地址跟着引擎走）。
                 判定拿 values + options，false 直接跳过，别留空行。 */
              if (typeof it.showIf === 'function' && !it.showIf(data.values, data.options || {})) continue;
              const line = row(it);
              /* 0.17.15：长文本框（前置语句）改成整行宽度 —— 标签在上、输入框和三个按钮占满一行。
                 以前它和别的开关挤在同一行右侧，只剩一百多像素宽，字都挤成一竖列。 */
              /* 0.1.02：地址类（kind:'line'）也要占整行宽度，但高度仍是单行 —— 长 URL 需要横向空间。 */
              if (it.kind === 'text' || it.kind === 'line') line.classList.add('np-setrow-wide');
              line.querySelector('.np-sethead').append(makeControl(it, line));
              if (!it.group) { c.body.append(line); continue; }
              let box = boxes.get(it.group);
              if (!box) {
                box = el('div', 'np-subgroup');
                box.append(el('div', 'np-subgroup-tag', it.groupLabel || it.group));
                boxes.set(it.group, box);
                c.body.append(box);
              }
              box.append(line);
            }
            /* 0.17.43（C4）：「陪听开关」这张卡末尾追加一个临时安静开关 */
            if (g.id === 'accompany') c.body.append(quietRow());
            cards.push({ g, card: c });
            root.append(c.el);
          }
          promptCard = buildPromptCard();
          root.append(promptCard.el);
        }

        root.prepend(hint);
        ctx.root.append(root);
        void reload();
      },
    },
  },
};



