/**
 * 榜单目录 + 多选解析（0.16.60）。
 *
 * 用户口径（原话）：
 *   「打开这个设置的时候…可以设置三个榜，主力榜下面哪几个，曲风榜哪几个，
 *     然后再设一个什么榜…是用三个榜里面选，或者全部榜里面选，然后去那里面勾。」
 *
 * 所以这里做一份**全部 65 个榜的目录**，按人群能认得的类别分七组，设置页里一个按钮点开
 * 就是这七组、每组一条条可勾。勾上的榜就是「接力点歌 / 今天听点什么」的候选来源。
 *
 * 为什么把目录写死在代码里、不每次去网上拉：
 *   榜单 id 十年不变，只有名字偶尔改（乐夏榜、星云榜这种带期数的还会换标题）。
 *   目录是给下拉当选项用的，宁可能离线画出来，也别因为客户端没开就整块空着。
 *   真要刷新，见 `py/chart.js`：它按 id 去取，名字以服务端回的为准。
 *
 * 来源：GET /api/toplist（2026-05 实测回 65 条，`D:\Dev\_probe_top.py` 可复跑）。
 */
/** [分组, 名字, id] —— 顺序就是设置页里的顺序。 */
const RAW = [
  // ① 主力榜：网易云自己天天更的那四张，默认就开这两个（热歌 + 飙升）
  ['main', '热歌榜', '3778678'],
  ['main', '飙升榜', '19723756'],
  ['main', '新歌榜', '3779629'],
  ['main', '原创榜', '2884035'],

  // ② 曲风 / 语言榜：想只吃某一路的时候用
  ['style', '网易云国风榜', '5059642708'],
  ['style', '网易云民谣榜', '5059661515'],
  ['style', '网易云摇滚榜', '5059633707'],
  ['style', '网易云古典榜', '71384707'],
  ['style', '网易云电音榜', '1978921795'],
  ['style', '网易云中文说唱榜', '991319590'],
  ['style', '网易云全球说唱榜', '14028249541'],
  ['style', '网易云ACG榜', '71385702'],
  ['style', '网易云ACG动画榜', '3001835560'],
  ['style', '网易云ACG游戏榜', '3001795926'],
  ['style', '网易云ACG VOCALOID榜', '3001890046'],
  ['style', '网易云欧美热歌榜', '2809513713'],
  ['style', '网易云欧美新歌榜', '2809577409'],
  ['style', '欧美R&B榜', '12225155968'],
  ['style', '网易云日语榜', '5059644681'],
  ['style', '网易云韩语榜', '745956260'],
  ['style', '泰语榜', '7095271308'],
  ['style', '越南语榜', '6732014811'],
  ['style', '俄语榜', '6732051320'],

  // ③ 黑胶 VIP 榜
  ['vip', '黑胶VIP热歌榜', '7785066739'],
  ['vip', '黑胶VIP新歌榜', '7785123708'],
  ['vip', '黑胶VIP爱听榜', '5453912201'],
  ['vip', '黑胶VIP爱搜榜', '7785091694'],
  ['vip', '黑胶VIP限免榜', '12344472377'],

  // ④ 实时 / 趋势榜：变化快，适合想要「刚火起来的」
  ['live', '实时热度榜', '8246775932'],
  ['live', '实时分享榜', '18176153161'],
  ['live', '潮流风向榜', '13372522766'],
  ['live', '潜力爆款榜', '5338990334'],
  ['live', '赏音榜', '7775163417'],
  ['live', '网络热歌榜', '6723173524'],
  ['live', 'BEAT排行榜', '7356827205'],
  ['live', '中文慢摇DJ榜', '6886768100'],

  // ⑤ 外部榜：别的国家 / 平台的周榜
  ['outer', '美国Billboard榜', '60198'],
  ['outer', 'UK排行榜周榜', '180106'],
  ['outer', '日本Oricon榜', '60131'],
  ['outer', 'Beatport全球电子舞曲榜', '3812895'],
  ['outer', '法国 NRJ Vos Hits 周榜', '27135204'],
  ['outer', '俄罗斯top hit流行音乐榜', '6939992364'],
  ['outer', 'KTV唛榜', '21845217'],
  ['outer', '乐夏榜', '8661209031'],

  // ⑥ 平台合作榜：冠名 / 联名 / 活动榜，标题会换
  ['brand', '音乐合伙人推荐榜', '12911403728'],
  ['brand', '音乐合伙人热歌榜', '12911589513'],
  ['brand', '音乐合伙人留名榜', '12911619970'],
  ['brand', '音乐合伙人高分新歌榜', '12911379734'],
  ['brand', '音乐合伙人高分榜', '12768855486'],
  ['brand', 'AI歌曲榜', '9651277674'],
  ['brand', '荣耀音乐热歌榜', '18512097939'],
  ['brand', '小天才热歌榜', '18478568150'],
  ['brand', 'LOOK直播歌曲榜', '7603212484'],
  ['brand', '听歌识曲榜', '6688069460'],
  ['brand', '星云榜', '7325478166'],
  ['brand', '蛋仔派对听歌榜', '8532443277'],
  ['brand', '喜力®星电音派对潮音榜', '8537588450'],

  // ⑦ 车友榜：按车机厂牌分的
  ['car', '特斯拉车友爱听榜', '8703179781'],
  ['car', '理想车友爱听榜', '8703052295'],
  ['car', '比亚迪车友爱听榜', '8702582160'],
  ['car', '蔚来车友爱听榜', '8703220480'],
  ['car', '极氪车友爱听榜', '8702982391'],
  ['car', '昊铂车友爱听榜', '10131772880'],
  ['car', '埃安车友爱听榜', '10162841534'],
  ['car', '吉利车友爱听榜', '12717025277'],
];

/** 七个分组（设置页里的小标题）。 */
export const CHART_GROUPS = [
  { key: 'main', zh: '主力榜', en: 'Main' },
  { key: 'style', zh: '曲风 / 语言榜', en: 'Genre & language' },
  { key: 'vip', zh: '黑胶 VIP 榜', en: 'VIP' },
  { key: 'live', zh: '实时 / 趋势榜', en: 'Live & trending' },
  { key: 'outer', zh: '外部榜', en: 'Charts from outside' },
  { key: 'brand', zh: '平台合作榜', en: 'Partner charts' },
  { key: 'car', zh: '车友榜', en: 'Car brand' },
];

/** 全部榜单：[{ id, name, group }]，顺序同 RAW。 */
export const CHARTS = RAW.map(([group, name, id]) => ({ id: String(id), name, group }));

const BY_ID = new Map(CHARTS.map((c) => [c.id, c]));

/** 默认：热歌榜 + 飙升榜 —— 和 0.16.59 之前写死的那两个完全一致，升级不改变原有行为。 */
export const DEFAULT_CHART_IDS = ['3778678', '19723756'];

/** 最多能勾几个榜（再多候选池就太大，向量算不过来）。 */
export const MAX_CHARTS = 8;
/**
 * 取榜时向脚本要多少首 —— 直接要满 300，**不在取数侧剪**。
 * 0.16.62：原来这里是 `PER_CHART_TAKE = 30`（每榜只取 30），
 * 现在改成「取的时候拿满、分配放到 chartSongs() 里做」：
 * 单榜要整榜、多榜要均分 300，这些规则都得看「勾了几个」才知道，
 * 取数那一步看不见这个，所以只能拿满回来再切。
 */
export const FETCH_TAKE = 300;
/**
 * 合并去重后的候选池上限（0.16.62 从 200 提到 300，用户口径：凑满 300 首做推荐）。
 * bge-m3 实测 47ms/条，300 条首次约 14 秒，有缓存后基本无感。
 */
export const POOL_CAP = 300;

/**
 * 勾了 `n` 个榜时，每个榜先取前多少首。
 * - 只勾 1 个 → Infinity（整榜全取，有 300 取 300，只有 180 就给 180）；
 * - 勾 2 个 → 150、勾 3 个 → 100、勾 4 个 → 75 …… 依次均分 300。
 * 这只是**第一轮**的分法：某一榜不够配额时，`chartSongs()` 会从别的榜续进来把 300 凑满。
 */
export function perChartTake(n) {
  const k = Math.max(1, Number(n) || 1);
  return k === 1 ? Infinity : Math.floor(POOL_CAP / k);
}

export function chartById(id) {
  return BY_ID.get(String(id)) || null;
}

/** 榜 id → 名字；查不到就空串（别把一串数字怼到界面上）。 */
export function chartName(id) {
  const c = BY_ID.get(String(id));
  return c ? c.name : '';
}

/** 单数名字列表：`热歌榜、飙升榜`。 */
export function chartNames(ids) {
  return (Array.isArray(ids) ? ids : []).map(chartName).filter(Boolean).join('、');
}

/**
 * 把配置里那个「逗号串」解析成 id 数组。
 *
 * 容错到「怎么存都能用」：逗号 / 空格 / 顿号分隔都认，存成数组也认，
 * 中间夹了已经不存在的榜 id 直接丢掉（换榜、下线都不是用户的错）。
 * 解析完是空 → 回默认两个，绝不能出现「一个榜都没选」把候选池清空。
 */
export function parseChartIds(v) {
  let list = [];
  if (Array.isArray(v)) list = v.map(String);
  else if (typeof v === 'string') list = v.split(/[,，、\s]+/);
  else if (typeof v === 'number') list = [String(v)];
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (!id || !BY_ID.has(id) || out.includes(id)) continue;
    out.push(id);
    // 超出上限的静默丢掉 —— 界面上勾不到第 9 个，只有手改配置文件才会撞到
    if (out.length >= MAX_CHARTS) break;
  }
  return out.length ? out : [...DEFAULT_CHART_IDS];
}

/** 存回配置的形状：逗号串。 */
export function joinChartIds(ids) {
  return parseChartIds(ids).join(',');
}

/**
 * 设置页下拉用的选项：按分组返回，前端一层层画成「组标题 + 可勾的条目」。
 * 前端不传 language 就出中文（这份目录本来只有中文名，榜单官方就叫中文）。
 */
export function chartOptions() {
  return CHART_GROUPS.map((g) => ({
    key: g.key,
    label: g.zh,
    labelEn: g.en,
    items: CHARTS.filter((c) => c.group === g.key).map((c) => ({ value: c.id, label: c.name })),
  }));
}

/** 目录里有多少个榜（自测、面板排查用）。 */
export function chartCount() {
  return CHARTS.length;
}
