/**
 * 安静时间（0.17.11）：在这段时间里**一句都不出声**，但后台照常跑。
 *
 * 用户口径：「陪听开关设置一个安静时间 开始 结束 两个输入框 XX：XX 形式，后面一个确认开关。
 * 如果在安静时间，所有的语音播报都不发出，包括设置的自动推歌 AI 提示也不触发，
 * 但是后台的刷新还是正常。」
 *
 * 所以这里只回答一个问题：现在是不是安静时间。拦的是「出声 + 生成那句话」，
 * 推荐重算、榜单/推荐缓存、听歌采样一律不经过这里。
 *
 * 时间口径：
 *   - 只认 HH:MM（24 小时制），`23:00 - 07:00` 这种跨零点算「跨夜窗口」；
 *   - 起止相同（如都是 00:00）视为没设窗口 —— 不然一下就变成 24 小时全静音；
 *   - 起止写错也视为没设，宁可出声也别整晚哑掉。
 */

const RE_HM = /^([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)$/;

/** 'HH:MM' → 当天第几分钟；不合法返回 null。 */
export function parseHM(v) {
  const m = RE_HM.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 规整成 'HH:MM'；写错就用 fallback。 */
export function normHM(v, fallback = '') {
  const n = parseHM(v);
  if (n == null) return fallback;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** 现在（默认此刻）是否落在安静时间里。开关没开、时间写错、起止相同 → false。 */
export function inQuietHours(cfg, now = Date.now()) {
  const c = cfg || {};
  if (c.quietOn !== true) return false;
  const a = parseHM(c.quietStart);
  const b = parseHM(c.quietEnd);
  if (a == null || b == null || a === b) return false;
  const d = now instanceof Date ? now : new Date(Number(now));
  const cur = d.getHours() * 60 + d.getMinutes();
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

/** 「23:00 – 07:00」这种给面板/日志看的短句；没设返回空串。 */
export function quietLabel(cfg) {
  const c = cfg || {};
  const a = normHM(c.quietStart);
  const b = normHM(c.quietEnd);
  if (!a || !b) return '';
  return `${a} – ${b}`;
}
