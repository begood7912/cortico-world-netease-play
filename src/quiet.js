/**
 * 「一直保持安静」（0.0.1.6.36，0.0.1.6.38 改成临时开关）。
 *
 * 用户口径（0.0.1.6.38 原话）：「一直保持安静的话，你应该是做一个临时开关，
 * 安静到下次指令，下次语音指令或者重启，重启后再重新生效。不能关掉以后再也不开了。」
 *
 * 所以：
 *   - **不落盘** —— 只存在进程内存里，世界一重启就自动失效，她又会照常开口；
 *   - 任何一次「他有动作」都清掉它：点歌、面板上按东西、真的放起一首歌；
 *   - 面板上那个「让她继续开口」按钮也是同一个清除。
 *
 * 和「等一会再说」的区别没变：那个靠 `idleRepeatMin` 冷却，这个是一次性停用。
 */
let quiet = { on: false, at: 0, why: '' };

/** 现在是不是被叫停了。`cfg` 参数保留只为不破老调用，已经不看配置了。 */
export function isQuietForever(_cfg) {
  return !!quiet.on;
}

/** 叫停；`why` 只用于排查（'choice' / 'dismissed' / ...）。 */
export function setQuietForever(on, why = '') {
  quiet = { on: !!on, at: Date.now(), why: String(why) };
  return { ...quiet };
}

/** 他有任何动作 → 解除。默认静默，返回是否真的变过。 */
export function clearQuiet(why = '') {
  if (!quiet.on) return false;
  quiet = { on: false, at: Date.now(), why: `clear:${why}` };
  return true;
}

/** 面板渲染用（同步，纯内存）。 */
export function peekQuiet(_cfg) {
  return { ...quiet };
}

export const PATHS = { QUIET_FILE: '' };
