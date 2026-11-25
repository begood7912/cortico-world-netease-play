/**
 * 全部说明文字的注册表（0.16.96）。
 *
 * 一条一个固定 ID：三段式 `域.对象.字段`。这里先收设置页的 title / desc（键名即对象名，
 * 所以 ID 可以机械推导：set.<键>.title）。以后三卡话术、提示、用法卡按同样格式往这里加。
 *
 * 读法：
 *   text('set.chainSpeak.desc')                 → 当前语言的一句
 *   text('set.chainSpeak.desc', { lang: 'en' })  → 指定语言
 *   texts('zh')                                  → 整包（给前端/文档生成一次性取走）
 *
 * 规矩：
 *   1. 键发布即冻结，改文案不改 ID；
 *   2. 取不到时返回 ID 本身，界面会直接显示 set.xxx.desc，一眼看得出漏了，不会白屏；
 *   3. 中文与英文必须同时存在，缺一个 lint 会报。
 */

export const TEXT = {
  'set.aiRandomChain.title': {"zh": "随机播放交给 AI（并按推荐开局）", "en": "Let AI handle random play"},
  'set.aiRandomChain.desc': {"zh": "打开：外面发来「随机播放」的请求时，不再随便抽一首，而是按「今天听点什么」的第一首放，同时把接力点歌打开，之后一首接一首。关掉：随机播放照普通点歌走，不碰推荐、也不动接力开关。回话固定是「正在为你播放X的《X》，并自动开启接力点歌。」", "en": "When a random-play request arrives, start from the top daily pick and turn chaining on."},
  'set.cardsOn.title': {"zh": "②③④ 一起开关（总闸）", "en": "All three at once"},
  'set.cardsOn.desc': {"zh": "关掉之后三张卡都只显示「打开单独开关就显示内容」，本机模型不再被调用，评论区也不再抓。下面各张卡的单项只在它开着时才有效；数据不会丢，打开就回来。", "en": "Off hides all three cards and stops every model call behind them."},
  'set.showLiked.title': {"zh": "② 顶上显示「多少人点赞」", "en": "Show like count on ②"},
  'set.showLiked.desc': {"zh": "在这一卡标题下加一行「XX的《XX》歌 XX人点赞」，听满 30 秒念这句时开头也先这么点一句。数字从客户端界面读（红心按钮的计数）：一万以上只有量级，一万以下才是精确数。读不到（客户端没开 / 没在放歌）就整行不出现、播报也只点歌名。关掉就整行不读、不显示、不点。", "en": "Shows \"how many people like it\" under card ②, and opens the spoken line with it."},
  'set.sayBody.title': {"zh": "② 后面那段她怎么说", "en": "② Say her take"},
  'set.sayBody.desc': {"zh": "接着念的那段听感正文。取消勾选就不念它 —— 面板上照旧显示，只是不出声。两个都不勾 = 这张卡整个不生成、也不出声（省一次本机模型调用）。", "en": "The feeling line itself. Both unchecked = this card does nothing at all."},
  'set.sayBodyFirst.title': {"zh": "② 先说话，再播歌名", "en": "② Her line before the title"},
  'set.sayBodyFirst.desc': {"zh": "只管到点出声时这两段的先后。勾上：先念她那句话，再念「歌手《歌名》，有 N 万多人点赞。」；不勾（默认）：先念歌名那句，再念她的话。上面两项谁关了，谁那段就不出现，顺序也就无所谓了。", "en": "On = her line first, then the title. Off (default) = title first."},
  'set.cardFeel.title': {"zh": "③ 她听完什么感觉", "en": "③ What it felt like"},
  'set.cardFeel.desc': {"zh": "引一句歌词，再写「从这句歌词我感觉……」，不念歌名。听满一分钟念出来。关掉就不生成。", "en": "A lyric plus \"from that line I feel…\", never naming the song."},
  'set.cardComment.title': {"zh": "④ 别人怎么说", "en": "④ What others say"},
  'set.cardComment.desc': {"zh": "从这首歌点赞前五里随机抽一条原文，再加一句她自己的评价。听满一分半念出来。关掉就不拉评论区（省一次网络抓取），也不生成那几句。", "en": "One of the top-liked comments plus her own take on it."},
  'set.cardsPreview.title': {"zh": "没在放歌时，先按第一首推荐说", "en": "Follow the top pick while idle"},
  'set.cardsPreview.desc': {"zh": "客户端没开、也没在放歌时，三张卡拿「今天听点什么」第一首当对象。关掉就退回「—／还没说过／没找到这首歌的评论」。", "en": "While nothing is playing, the cards talk about the top daily pick."},
  'set.announce.title': {"zh": "到点出声（三张卡共用）", "en": "Speak the lines"},
  'set.announce.desc': {"zh": "听满 30 秒念「她听这首歌时」、满一分钟念「她听完什么感觉」、满一分半念「别人怎么说」。这一项一关就全都不出声，只在面板上显示。", "en": "When on, each card is spoken once at 30 s / 60 s / 90 s. Off = panel only."},
  'set.chainPick.title': {"zh": "接力点歌（一首接一首）", "en": "Chain the next song"},
  'set.chainPick.desc': {"zh": "关掉就完全不接力。打开时：你点了推荐卡里那首（或者答应了她安静时说的那首），剩半分钟左右她先报一句「即将播放……」，剩约 10 秒时直接放。没有「最多几首」的限制。播报一出口，这首就定下来了：不再换、不再作废，就算这首提前放完、或者你换了别的歌，她也照样把它放出来；只有还没播报就换歌，接力才会断。", "en": "Announces the next song ~30 s before the end, plays it ~10 s ahead. No cap. Once announced, that song is locked in."},
  'set.chainSpeak.title': {"zh": "接力时念一句「即将播放…」", "en": "Announce the next song"},
  'set.chainSpeak.desc': {"zh": "打开：接力递歌时先用本机语音念一句「即将播放某某的《X》」，念完再切。关掉：安静切歌，这一声不出；挑中的是哪首、什么时候切都照旧，面板上照样看得到。只剪这一声 —— 卡② 和安静提醒的出声不受影响。", "en": "When on, she announces \"Up next: <song>\" with local TTS. Off = silent handover."},
  'set.chainSource.title': {"zh": "推荐来源（接力 + 播报 + 只刷新这一张）", "en": "Recommendation source (chain, speech, refresh)"},
  'set.chainSource.desc': {"zh": "二选一。选中的那张卡是**唯一在刷新的**：接力从它挑下一首、播报按它的说法、安静时想听哪首也从它取；另一张卡显示「已停用」，不再拉榜、不再算向量。选「按天气」时，天气数据由后台按下面设的间隔固定获取，不受这里影响；切换来源会作废上一来源已经播报出去的那首。", "en": "The selected card is the only one that refreshes: the chain picks from it, the spoken line follows it, and the idle offer too. The other card shows \"off\" and stops all work. Weather fetching keeps its own fixed interval regardless."},
  'set.chainCharts.title': {"zh": "从哪几个榜里挑歌", "en": "Charts to pick from"},
  'set.chainCharts.desc': {"zh": "接力递出的下一首、以及「今天听点什么」里的歌，候选都从勾的这几个榜里挑。点右边按钮展开：主力榜 / 曲风语言榜 / 黑胶 VIP / 实时趋势 / 外部榜 / 平台合作榜 / 车友榜 七组，一共 65 个榜，可以勾多个。默认勾着「热歌榜 + 飙升榜」。总数最多 300 首，按勾的这几个榜平均分配（只勾一个就给满一整榜）—— 勾太多只会让算推荐变慢。改了勾选会立刻重算；一直不动的话，1 小时刷新一次。", "en": "Which charts feed the pool: 7 groups, 65 charts. 300 songs max, split evenly across the selected ones. Changing the selection re-picks right away; otherwise it refreshes hourly."},
  'set.chainPlaylist.title': {"zh": "接力点歌歌单（AI 推荐歌单）", "en": "Chain into the AI playlist"},
  'set.chainPlaylist.desc': {"zh": "勾上：接力递出去的歌、以及「此刻」页推荐卡里点的那一手，都落进账号里那张「AI 推荐歌单」。榜单页点的歌不受这个勾影响，还是进默认歌单。账号里有这张就直接用；没有就当场建一张。不勾：推荐页点歌也走默认歌单，只播放不动 AI 歌单。", "en": "Chained songs and picks from the recommendation card go into the \"AI 推荐歌单\" playlist, created if it is missing."},
  'set.chainClearDaily.title': {"zh": "这张歌单每天清零", "en": "Clear this playlist daily"},
  'set.chainClearDaily.desc': {"zh": "打开：到下面那个整点，就算新的一天，把「AI 推荐歌单」里的歌全部清空，清完重新往里放。到点时电脑没开、也没在听歌 —— 不管它，等你下次点歌触发接力时先清再跑。关掉就永远不清。", "en": "Empties the AI playlist once a day at the hour below."},
  'set.chainClearHour.title': {"zh": "几点清零（只填小时）", "en": "Clear hour (hour only)"},
  'set.chainClearHour.desc': {"zh": "只填小时，0 到 23，不填分钟。默认 6 = 早上六点算新的一天。", "en": "Hour only, 0-23. Default 6."},
  'set.selfPick.title': {"zh": "允许她自己去找歌挑歌", "en": "Let her pick songs herself"},
  'set.selfPick.desc': {"zh": "关着的时候她只评价你在放的，不会去翻别的，也不会主动开口。打开后：安静够久她会自己问一句想听哪首，挑中的那首还会记进「她想听什么」清单。", "en": "When off she only comments on what is playing."},
  'set.idleFirstMin.title': {"zh": "安静多少分钟后开口", "en": "Minutes before asking"},
  'set.idleFirstMin.desc': {"zh": "没放歌连续这么久，她弹一次提问气泡。默认 5 分钟；选了「按天气听点什么」时最少 5 分钟，填更小的会按 5 算。", "en": "Minutes of silence before she asks. Min 5 when the weather source is on."},
  'set.idleBootGuardMin.title': {"zh": "开机后先静默（分钟）", "en": "Silent after boot (min)"},
  'set.idleBootGuardMin.desc': {"zh": "刚开机时模型和候选歌单还没加载完，这段时间不发安静提示。默认 5 分钟，0 = 不拦。", "en": "Skip idle asks right after boot while models load. 5 by default; 0 = off."},
  'set.idleRepeatMin.title': {"zh": "没动静多久后再问一次", "en": "Ask again after"},
  'set.idleRepeatMin.desc': {"zh": "开过一次口之后不追问。等到这里设的分钟数、期间仍然没在放歌，才问第二次。填 0 = 只问第一次，以后再也不问。", "en": "0 = ask once and never again."},
  'set.askTwoOnly.title': {"zh": "弹窗只给两项（放 / 先安静）", "en": "Only two choices"},
  'set.askTwoOnly.desc': {"zh": "打开后选项只剩「放《X》」和「先安静」；关着是三项，多一个「等一会再说」。不管几项，点叉都等于「先安静」。", "en": "Two options instead of three."},
  'set.playlist.title': {"zh": "默认歌单", "en": "Default playlist"},
  'set.playlist.desc': {"zh": "没说放哪个歌单时就放这张。下拉的列表来自你网易云账号，存的是歌单 ID，不会因为重名选错。", "en": "Where songs go when no playlist is named."},
  'set.autoFav.title': {"zh": "自动加进「我喜欢的音乐」", "en": "Auto-add to favourites"},
  'set.autoFav.desc': {"zh": "打开时，同一首点满设定次数就自动加进「我喜欢的音乐」；关掉就只记账、不动歌单。", "en": "When on, songs reaching the threshold are added to favourites."},
  'set.favThreshold.title': {"zh": "点几次后自动加喜欢", "en": "Favourite threshold"},
  'set.favThreshold.desc': {"zh": "同一首点满这么多次进「我喜欢的音乐」，默认 2 次。只在上面开关打开时有用。", "en": "How many times before a song is added. Default 2."},
  'set.allowRestart.title': {"zh": "允许脚本重启网易云", "en": "Allow restarting the client"},
  'set.allowRestart.desc': {"zh": "关着：只连你手动开的那个端口，端口不通就报错，绝不杀客户端。打开后端口不通时脚本会退掉客户端再带端口重启（会打断当前播放）。", "en": "When on, the script may kill and relaunch the client to open the debug port."},
  'set.cdpPort.title': {"zh": "网易云调试端口（CDP）", "en": "NetEase CDP port"},
  'set.cdpPort.desc': {"zh": "你自己开客户端时带的调试端口，默认 9229。改完下一次点歌就生效。", "en": "Debug port of the running client. Default 9229."},
  'set.clientExe.title': {"zh": "网易云客户端路径（可选）", "en": "NetEase client path"},
  'set.clientExe.desc': {"zh": "客户端没开时，她会用这个路径自己启动它。留空就用默认安装位置。", "en": "Used to launch the client when it is closed. Empty = default path."},
  'set.modelSource.title': {"zh": "模型来源（本机 / 云端）", "en": "Model source"},
  'set.modelSource.desc': {"zh": "二选一，选哪边就只用哪边，不会偷偷换过去。选「云端」而云端报错时三张卡会一起停摆并显示原因，这是故意的。云端地址 / Key 在「模型」页签里填。", "en": "Pick one source. Cloud errors stop all three cards instead of falling back."},
  'set.ollamaUrl.title': {"zh": "本机 · Ollama 地址", "en": "Local · Ollama endpoint"},
  'set.ollamaUrl.desc': {"zh": "选模型用的就是这台机器上的 Ollama，默认 http://127.0.0.1:11434。", "en": "Where the local Ollama listens."},
  'set.embedModel.title': {"zh": "本机 · 向量模型（算相似度用）", "en": "Local · Embedding model"},
  'set.embedModel.desc': {"zh": "从本机 Ollama 已装的模型里选一个能出向量的（bge 那类）。留空 = 不使用。", "en": "An embedding model installed in Ollama. Empty means unused."},
  'set.vramMode.title': {"zh": "本机 · 显存模式", "en": "Local · VRAM mode"},
  'set.vramMode.desc': {"zh": "「省显存」只把部分层塞进 GPU，显存降到约 0.9 GB，代价是一句话变慢；「纯 CPU」显存归零，更慢。句子质量实测没差别。", "en": "Trim VRAM by offloading fewer layers. Same sentences, just slower."},
  'set.chatModel.title': {"zh": "本机 · 小模型（三张卡都用它）", "en": "Local · Chat model"},
  'set.chatModel.desc': {"zh": "卡①②③ 共用这一个模型。留空 = 不使用。", "en": "One model shared by all three cards."},
  'set.aiPlayPrompt.title': {"zh": "发给 AI 的前置语句（工具说明）", "en": "Prompt sent to the AI"},
  'set.aiPlayPrompt.desc': {"zh": "这段话每一轮都会贴着 netease_play 这个工具一起进 AI 的上下文：告诉它什么时候点歌、自己挑的歌要不要记账，以及放好以后该怎么说（「现在为你播放某某的《某某》」）。想改口吻、改回话句式、加自己的规矩，直接改这里；清空就回到程序默认那段（灰字就是默认原文）。", "en": "This text rides along with the netease_play tool every turn: when to play, how to mark self-picked songs, and what to say afterwards. Clear it to fall back to the default."},
  'set.quietStart.title': {"zh": "安静时间 · 开始", "en": "Quiet from"},
  'set.quietStart.desc': {"zh": "HH:MM，24 小时制。比如 23:00。和结束时间一起决定「一点声音都不出」的窗口，窗口可以跨零点（23:00 → 07:00）。", "en": "HH:MM, 24h. Window may cross midnight."},
  'set.quietEnd.title': {"zh": "安静时间 · 结束", "en": "Quiet until"},
  'set.quietEnd.desc': {"zh": "HH:MM，24 小时制。到点之后恢复出声。开始和结束写成一样等于没设，不会整晚静音。", "en": "HH:MM, 24h. Same as start = disabled."},
  'set.quietOn.title': {"zh": "安静时间生效", "en": "Enable quiet hours"},
  'set.quietOn.desc': {"zh": "打开后，窗口内所有语音播报都不出，自动推歌（她主动开口问要不要听某首）也不触发；但推荐重算、榜单/每日推荐缓存刷新、听歌统计照常跑，一开声就是新的。", "en": "No speech and no idle nudges inside the window; refreshes keep running."},
  'set.ttsUrl.title': {"zh": "本机语音（GPT-SoVITS）地址", "en": "Local TTS endpoint"},
  'set.ttsUrl.desc': {"zh": "随「大肥鱼全能语音包」配置，默认 http://127.0.0.1:9880。引擎选「GPT-SoVITS」时才用它。", "en": "Follows the local GPT-SoVITS voice pack. Default http://127.0.0.1:9880."},
  'set.ttsEngine.title': {"zh": "本机语音引擎", "en": "TTS engine"},
  'set.ttsEngine.desc': {"zh": "「GPT-SoVITS」随大肥鱼全能语音包配置；「Windows TTS」用系统自带老语音（Huihui/Kangkang/Yaoyao），不用开任何服务；「微软在线语音」是晓晓、晓伊、云希这些神经音色，免费但要联网，本机需装 python 的 edge-tts（pip install edge-tts）。", "en": "GPT-SoVITS follows the local voice pack; Windows TTS uses built-in SAPI voices; Microsoft online voices (Xiaoxiao, Yunxi …) are free neural voices but need network and edge-tts installed."},
  'set.ttsVoice.title': {"zh": "音色（下拉）", "en": "Voice (dropdown)"},
  'set.ttsVoice.desc': {"zh": "跟着上面选的引擎走：Windows TTS 列系统已装的语音；微软在线语音列中文神经音色（晓晓、晓伊、云希…）；GPT-SoVITS 随大肥鱼全能语音包配置，这里不生效。", "en": "Follows the engine above: Windows SAPI voices, or Chinese neural voices (Xiaoxiao, Yunxi …). GPT-SoVITS follows the local voice pack."},
};

/** 语言归一：除了 en 之外一律按中文。 */
const norm = (lang) => (String(lang || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh');

/** 取一句。缺键返回 ID 本身（显眼，不静默留白）。 */
export function text(id, { lang } = {}) {
  const row = TEXT[id];
  if (!row) return id;
  return row[norm(lang)] ?? row.zh ?? id;
}

/** 按语言取整包，前端一份就够。 */
export function texts(lang) {
  const l = norm(lang);
  const out = {};
  for (const [id, row] of Object.entries(TEXT)) out[id] = row[l] ?? row.zh ?? '';
  return out;
}

/** 自检：ID 唯一、中英齐全、格式合规。返回问题数组（空 = 通过）。 */
export function lintStrings() {
  const problems = [];
  for (const [id, row] of Object.entries(TEXT)) {
    if (!/^[a-z]+(\.[A-Za-z0-9]+){1,2}$/.test(id)) problems.push('ID 格式不合规：' + id);
    if (!row.zh || !row.en) problems.push('中英不全：' + id);
    if (typeof row.zh !== 'string' || typeof row.en !== 'string') problems.push('文案类型不对：' + id);
  }
  return problems;
}
