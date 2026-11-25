/**
 * 卡片开关的判定（0.16.58 起，0.16.61 加第三项）。
 *
 * 卡②「她听这首歌时」设置里三个勾：
 *   showLiked     —— 顶上那行「XX的《XX》歌 XX人喜欢」（面板 + 播报开头那句）
 *   sayBody       —— 后面那段正文（生成 + 念）
 *   sayBodyFirst  —— **只管顺序**：勾上先说话再播歌名，不勾先播歌名再说话（拼句见 composeHear）
 * 前两个都不勾 = 这张卡整个不工作（面板上显示「关掉了」）；第三个不参与开关判定。
 *
 * `cardHear` 是老键（0.16.44 那一版的一个勾），设置页不再显示，但**仍然尊重**：
 * 以前把它关掉的用户，升级后不能因为新键默认开就自己又开口。
 * `sayHead`（0.16.56 拆出来的那个）已不参与任何判定，只留在盘上不报错。
 */
export function cardsBaseOn(cfg) {
  const c = cfg || {};
  return c.cardsOn !== false && c.cardHear !== false;
}

/** 这张卡整体开不开（两个勾有一个就行）。 */
export function hearCardOn(cfg) {
  const c = cfg || {};
  if (!cardsBaseOn(c)) return false;
  return c.showLiked !== false || c.sayBody !== false;
}

/** 正文那一段要不要算（生成 + 念）。 */
export function takeBodyOn(cfg) {
  return cardsBaseOn(cfg) && (cfg || {}).sayBody !== false;
}

/** 顶上那行人数要不要显示（面板 + 播报开头）。 */
export function likedRowOn(cfg) {
  return cardsBaseOn(cfg) && (cfg || {}).showLiked !== false;
}

/**
 * 卡② 播报的拼句（0.16.61）：两段谁先说。
 *
 * 用户口径：
 *   打开 `sayBodyFirst` → 先说话、再播歌名；
 *   关上（默认）       → 先播歌名、再说话（0.16.54 之后一直是这个顺序）。
 *
 * 正文在前时补一个「。」—— 正文一般不带句末标点，直接接「歌手《歌名》，有…」
 * 会念成一句黏在一起的话。哪一段关掉了就只剩另一段，顺序自然不起作用。
 */
export function composeHear(head, text, bodyFirst) {
  const h = String(head || '').trim();
  const t = String(text || '').trim();
  if (!t) return h;
  if (!h) return t;
  if (!bodyFirst) return `${h}${t}`;
  const end = /[。！？…~～!?.]$/.test(t) ? '' : '。';
  return `${t}${end}${h}`;
}
