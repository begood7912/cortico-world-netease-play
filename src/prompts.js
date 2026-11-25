/**
 * 三张卡发给模型的系统提示词（0.16.52 起可自定义）。
 *
 * 用户口径：「卡一卡二卡三的内容，每次的开头结尾都是一样的，听多了会腻……
 * 可不可以把它那个和服务器交换数据的那个提示词变成可以自定义的？前面开头要怎么说，
 * 后面怎么弄……和本地模型去说话控制那些东西可以自己手动设置。」
 *
 * 所以每条提示词拆成两段，各自一个配置键：
 *   head —— 开头引导（场景、身份、要它干什么）
 *   tail —— 结尾要求（长度、格式、禁止项）
 * 中间那些动态数据（歌名、歌词那一句、热评原文）仍由程序拼，用户改不到也不该改。
 *
 * 六个键：
 *   worlds.netease-play.promptHearHead / promptHearTail         卡② 她怎么听这首
 *   worlds.netease-play.promptFeelHead / promptFeelTail         卡③ 她听完什么感觉（本机/云端共用）
 *   worlds.netease-play.promptCommentHead / promptCommentTail   卡④ 别人怎么说
 *
 * 留空 = 用这里的默认文案，一个字都不会丢。默认值必须和原来的硬编码逐字一致，
 * 否则用户什么都没改却发现输出变了，会以为升级改坏了他的口味。
 */

export const HEAR_HEAD = '你在听歌。用一个短句说出歌词给你的一个画面或一种情绪。';
export const HEAR_TAIL = '只输出这一句。15到30个字之间。不复述歌词，不解释，不加引号。';

export const FEEL_HEAD = '就这一句说说你的感觉。';
/** 云端那套的开头多一个逗号 —— 原文就是「就这一句，说说你自己的感觉。」，保持逐字一致。 */
export const FEEL_HEAD_CLOUD = '就这一句，说说你自己的感觉。';
/** 本机小模型那套（短、直白）。字数「30到60个字」，与 like.js 的 MIN_FEEL=30 / MAX_FEEL=60 对齐（改那边记得同步这里）。 */
export const FEEL_TAIL_LOCAL = '只输出两行：'
  + '第一行：感觉：两个字加冒号，后面写30到60个字，说说这句让你想到什么、心里怎么样；'
  + '第二行：只写「喜欢」或「一般」或「不喜欢」。'
  + '不要评价歌词写得好不好，不要再抄歌词，不要加引号。';
/** 云端那套（同一件事说得更细，模型更大能听懂「不要写成什么样」）。 */
export const FEEL_TAIL_CLOUD = '只输出两行，不要别的东西：\n'
  + '第一行：感觉：<30到60个字。接着这句说，说你听着它想到什么、心里什么反应、联想到自己的什么事。'
  + '不要说「歌词写得好」「很有意境」，不要评价唱功，不要复述歌词>\n'
  + '第二行：喜欢，或 一般，或 不喜欢（只写一个词）\n'
  + '第一行要像跟人聊天那样说，不用「本首歌表达了」这种腔调。';

export const COMMENT_HEAD = '你在听歌，看到评论区一条热评。就着这条评论说两三句你自己的看法：\n';
export const COMMENT_TAIL = '开口第一句话用「我觉得」或「我认为」开头，然后再讲下去。\n'
  + '同意就讲同意在哪，不同意就讲为什么。说大白话，像跟朋友聊天。\n'
  + '不要复述评论原文，不要评价文笔好不好，不要扯到别的歌。\n'
  + '评论里那个人的经历是那个人的，不要写成你自己的经历。\n'
  + '不少于30个字，不多于60个字。只输出这几句话，不加引号，不写名字。';

/** 取自定义值；空串/非字符串一律退回默认（用户清空后应该回到默认，而不是发一条空提示）。 */
const pick = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

/** 卡② 的系统提示：无动态数据，head + tail 直接拼。 */
export function hearSys(cfg) {
  const c = cfg || {};
  return `${pick(c.promptHearHead, HEAR_HEAD)}${pick(c.promptHearTail, HEAR_TAIL)}`;
}

/** 卡③ 的两段，调用方负责把它俩塞进「你正在听《X》，刚刚唱到这一句……」那句话后面。 */
export function feelParts(cfg, cloud) {
  const c = cfg || {};
  return {
    head: pick(c.promptFeelHead, cloud ? FEEL_HEAD_CLOUD : FEEL_HEAD),
    tail: pick(c.promptFeelTail, cloud ? FEEL_TAIL_CLOUD : FEEL_TAIL_LOCAL),
  };
}

/** 卡④ 的系统提示：head + tail 直接拼（热评原文在 user 里）。 */
export function commentSys(cfg) {
  const c = cfg || {};
  return `${pick(c.promptCommentHead, COMMENT_HEAD)}${pick(c.promptCommentTail, COMMENT_TAIL)}`;
}

/** 用户到底改没改卡④的结尾 —— 「我觉得」兜底只在没自定义时生效（见 her-reply.js ensureOpener）。 */
export function commentTailCustomized(cfg) {
  const c = cfg || {};
  return typeof c.promptCommentTail === 'string' && c.promptCommentTail.trim() !== '';
}

/** 六个键的默认文案（设置页「还原默认」和占位符都用它）。 */
export function promptDefaults() {
  return {
    promptHearHead: HEAR_HEAD,
    promptHearTail: HEAR_TAIL,
    promptFeelHead: FEEL_HEAD,
    promptFeelTail: FEEL_TAIL_LOCAL,   // 设置页里显示本机那套；云端时若留空会自己用云端默认
    promptCommentHead: COMMENT_HEAD,
    promptCommentTail: COMMENT_TAIL,
  };
}
