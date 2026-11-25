/**
 * 「推荐页点的歌，要不要落到 AI 推荐歌单」（0.16.62）
 *
 * 用户口径（原话）：
 *   > 榜单页那一个就是走默认歌单……推荐页呢，就用那个勾控制：打勾就走推荐歌单，不打勾就走默认歌单。
 *   > 走推荐歌单的话就是不走默认歌单，就是用那个开关控制。
 *
 * 所以这里是**目标歌单的二选一**，不是「两张都进」。判据只有两样：
 *   1. 这次点歌**来自哪个页面**（`panel === 'now'` 就是推荐那页，`'rank'` 是榜单页）；
 *   2. 设置里的那个勾（`chainPlaylist`）。
 *
 * 为什么单独一个文件：以后要改「哪些点击算数 / 加不加 / 加哪张歌单」只动这里，
 * `panel.js` 那边只保留一行调用，判来源那段（接力认人用的 `markOrigin`）一个字都不碰。
 *
 * 落地方式很省事：**不额外调加歌接口**。播放链自己就会把目标歌单收好 ——
 *   - 快路径 `py\fastplay.js` 第 296 行那段是「先 del 再 add，把歌顶到目标歌单第一位」，天然幂等；
 *   - 慢路径 `addplay.py` 本来就是「先加进歌单再放」。
 * 所以只要把 `cfg.playlist` 换成 AI 推荐歌单，加歌和播放一趟就都完成了。
 */

import { RECO_PLAYLIST_NAME } from './recoPlaylist.js';

/** 「此刻」页（推荐卡那一页）在宿主里的 panel 名。 */
export const PANEL_NOW = 'now';

/**
 * 这一次点歌该落到哪张歌单。返回空串 = 不干预，照原来的默认歌单走。
 *
 * 第 121 节（用户口径，修正 0.16.62 的旧判据）：
 *   「只有 1 号面板需要看那个勾，其他的面板不要看那个勾 —— 它们默认就是那个默认歌单。」
 *   「接力点歌和 1 号窗口点歌是同一个东西。」
 *
 * 所以两个条件同时成立才换成「AI 推荐歌单」：
 *   1. 来源是 1 号窗口（`now`，「此刻」页）；**接力也按 1 号窗口算**（见 `world.js` 的 `applyPick(c, PANEL_NOW)`）
 *   2. 那个勾 `chainPlaylist` 是开着的
 *
 * 榜单页、其他面板：一律不干预 → 走 `DEFAULT_PLAYLIST`。
 *
 * 为什么要补这一条：原来 `pickTargetPlaylist` 只被 `panel.js` 调用，判据里的
 * `from !== 'now'` 把**接力**挡在外面（接力没有页面来源），于是快路径把歌加进默认歌单、
 * 第 ⑧ 步又加进 AI 推荐歌单 —— 同一首被塞进两张歌单。
 */
export function pickTargetPlaylist(cfg, fromPanel) {
  const from = String(fromPanel || '').trim();
  if (from !== PANEL_NOW) return '';
  if (!cfg) return '';
  // 第 123 节（用户口径）：**自动接歌那个勾是总闸** —— 总闸不勾，两个勾都当没勾。
  // 「如果这个勾没勾上，那个是全部走默认歌单。」原来这里只看 `chainPlaylist`，
  // 于是总闸关着、歌单勾着的时候，面板点歌还会往 AI 推荐歌单里加，和口径不符。
  if (cfg.chainPick !== true) return '';
  if (cfg.chainPlaylist !== true) return '';
  return RECO_PLAYLIST_NAME;
}

/**
 * 把配置改好再交给 `playSong`。
 * 传名字而不是歌单 id：`nameById()` 只认 id → 名字，反过来会把名字当 id 用，
 * 万一歌单缓存里还没这张，数字串会被当成歌单名去建一张新歌单。
 */
export function applyPick(cfg, fromPanel) {
  const pl = pickTargetPlaylist(cfg, fromPanel);
  if (!pl) return cfg || {};
  return { ...(cfg || {}), playlist: pl };
}
