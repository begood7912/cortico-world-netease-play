/**
 * 0.17.58：两个「世界 → 宿主」事件的自描述，唯一真源。
 *
 * 为什么单独成文件：以前 `type / trigger / tags` 全写死在 `world.js` 的 pushEvent 里，
 * `describe` 里一条都没声明 —— 同一件事写两处，必然漂移（宿主 `undeclared-names.ts`
 * 还会在运行时警告「事件 type 不在 describe.events 里，照常推送」）。
 * 现在：`world.js` 推送取这里，`index.js` 的 `describe.events` 也取这里，只有一份。
 *
 * 宿主契约（cortico `core/types.ts`）：
 *   - `EventDescribe = { type, description, trigger?, tags? }`，声明里的 trigger/tags 是推送缺省值；
 *   - `type` 惯例 `<world>.<name>`（对照 `realtime-weather.summary` / `music.start` / `desktop-pet.message`）；
 *   - `EventTag` 只有两个值：`snapshot`（状态类，交接时只留最后一条）、`speak`（对外发言，只留最近一段）；
 *   - `TriggerMode` 里 `interrupt` 会取消在途模型轮、丢掉尚未开始的工具调用 —— 播报不该有这种权限，
 *     两个事件都取 `flush`（立即投递整批积压，不取消轮次）。
 */

export const ASK_EVENT = {
  type: 'netease-play.ask',
  description: {
    zh: '她安静太久、播放器确实停着：请她先开口说一句，再弹「要放歌吗」选择题。状态类事件。',
    en: 'The room stayed quiet too long: say one line, then show the "play it?" picker. State event.',
  },
  trigger: 'flush',
  tags: ['snapshot'],
};

export const HER_LINE_EVENT = {
  type: 'netease-play.her-line',
  description: {
    zh: '她自己要说的一句话（接力接下、换了一批、没放上等）：原样念出来，不用回答。发言类事件。',
    en: 'One line she wants to say (chain pick, new batch, failed to play): voice it as-is, do not answer it.',
  },
  trigger: 'flush',
  tags: ['speak'],
};

export const EVENT_DECLS = [ASK_EVENT, HER_LINE_EVENT];

/**
 * senderKey：契约要求「产生方定义的稳定过滤键」。
 * 以前两个事件各用一个和 type 同值的常量，同类型事件全同键 = 没有区分度
 * （《有我呢》和《Letting Go》会被并成同一条）。这里按具体对象拼：
 *   netease-play.ask:1758612597 / netease-play.her-line:chain-fail
 */
export function senderKeyOf(decl, key) {
  const k = key == null ? '' : String(key).trim();
  return k ? `${decl.type}:${k}` : decl.type;
}
