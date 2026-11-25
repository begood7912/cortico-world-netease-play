/**
 * 0.17.60 自测：接受她「安静提议」的判定（A 方案）。
 *
 * 只测纯函数 `isOfferAccept` —— 它决定一次 `netease_play` 是 her-offer（接力开着）
 * 还是 user-ask（接力不接）。判错两边都难受：错判成接受 → 用户自己点的歌也会接力；
 * 错判成拒绝 → 就是这次修的 bug（点了「放《X》」链路一句话也不接）。
 *
 * 用法：node _t_offer.mjs
 */
import { isOfferAccept, OFFER_WINDOW_MS } from './src/tools.js';

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`[ OK ] ${name}`); } else {
    fail += 1;
    console.log(`[FAIL] ${name}\n       期望 ${JSON.stringify(want)}\n       实际 ${JSON.stringify(got)}`);
  }
}

const offer = { pick: { name: '不见', artist: '丁芙妮', id: '3454346727' }, at: Date.now() - 5000, ageMs: 5000 };

check('歌名一致（单曲）', isOfferAccept([{ name: '不见' }], offer), true);
check('带歌手也算同一首', isOfferAccept([{ name: '不见', artist: '丁芙妮' }], offer), true);
check('播放条拼了歌手也能认', isOfferAccept([{ name: '不见丁芙妮' }], offer), true);
check('歌名不一致 → 不接', isOfferAccept([{ name: '十年' }], offer), false);
check('多首一起放 → 不算接受', isOfferAccept([{ name: '不见' }, { name: '十年' }], offer), false);
check('没有提议（过期/没问过）→ 不接', isOfferAccept([{ name: '不见' }], null), false);
check('提议里没有歌名 → 不接', isOfferAccept([{ name: '不见' }], { pick: { name: '' } }), false);
check('空歌曲列表 → 不接', isOfferAccept([], offer), false);
check('窗口是 30 秒', OFFER_WINDOW_MS, 30000);

console.log(`\n${fail ? '有失败' : '全部通过'}：${pass} 通过，${fail} 失败。`);
process.exit(fail ? 1 : 0);
