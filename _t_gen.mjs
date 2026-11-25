/**
 * 0.17.54 自测：世代号（换歌/重播）相关的边界。
 * 跑：node _t_gen.mjs
 */
import { rotateLike, peekLike } from './src/like.js';
import { peekTake } from './src/take.js';
import { peekComment } from './src/comment.js';
import { trackGen } from './src/listening.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(`${m}（${JSON.stringify(a)}）`) : fail(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

// 不存在的歌：三个 peek/rotate 都不能崩，统一返回 null
eq(peekTake('__gen_test__', 'x', null, 1), null, '没缓存时 peekTake(gen) 返回 null');
eq(peekLike('__gen_test__', 'x', {}, 1), null, '没缓存时 peekLike(gen) 返回 null');
eq(peekComment('__gen_test__', 'x', 1), null, '没缓存时 peekComment(gen) 返回 null');
eq(rotateLike('__gen_test__', 'x', {}, 1), null, '没缓存时 rotateLike(gen) 不崩');

eq(typeof trackGen(), 'number', 'trackGen() 返回数字');

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
