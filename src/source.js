/**
 * 推荐来源的唯一真源（0.17.39）。
 *
 * 用户口径（11-25）：
 *   「卡1 和卡5 下面的接力点歌和天气推荐，统一由设置里『接力按哪张卡挑』那个 2 选 1 开关控制，
 *     包括出来的语音播报；选择以后，另外一张卡的刷新动作完全停止。」
 *
 * 所以这个开关（`chainSource`）现在同时决定三件事：
 *   ① 接力从哪张卡挑下一首（world.pickNext）
 *   ② 语音播报用哪套话术（sayChain 的天气垫句）
 *   ③ **只有被选中的那一路允许刷新**（recommend / wxreco 的计算门控）
 *
 * 规矩：全包只在这里把 `chainSource` 翻译成语义值，别处一律 `activeSource(cfg)`，
 * 不要再自己写 `c.chainSource === 'wx'` —— 以前散在 5 处，漏一处就是「选了天气，历史还在刷」。
 */

/** 语义值：跟设置里的 reco/wx 对应，但读起来不会混。 */
export const HISTORY = 'history';
export const WEATHER = 'weather';

/** 设置值 → 语义值。默认（缺省 / 写歪）一律「听歌历史」，与 settingspanel 的规整一致。 */
export function activeSource(cfg) {
  return cfg && cfg.chainSource === 'wx' ? WEATHER : HISTORY;
}

export function isHistoryActive(cfg) {
  return activeSource(cfg) === HISTORY;
}

export function isWeatherActive(cfg) {
  return activeSource(cfg) === WEATHER;
}

/** chain.json / 旧日志里存过 'wx' / 'reco'，读回来时统一。空串 = 不知道。 */
export function normalizeSource(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'wx' || s === 'weather') return WEATHER;
  if (s === 'reco' || s === 'history') return HISTORY;
  return '';
}
