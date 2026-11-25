/**
 * 0.17.43 自测：用户动作闸门（A8）+ 天气推荐只按数据版本重算（A4 的纯逻辑部分）。
 *
 * 跑：node _t_useraction.mjs
 */
import { markUserAction, blockingUserAction, lastUserAction, clearUserAction } from './src/userAction.js';

let bad = 0;
const ok = (m) => console.log('[ OK ] ' + m);
const fail = (m) => { console.log('[FAIL] ' + m); bad += 1; };
const eq = (a, b, m) => (a === b ? ok(`${m}（${JSON.stringify(a)}）`) : fail(`${m}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`));

clearUserAction();
eq(blockingUserAction(), false, '没有动作时不拦');

markUserAction('play', '七里香');
eq(blockingUserAction(), true, '点歌后拦');
eq(lastUserAction().kind, 'play', '记下了类型');

clearUserAction();
markUserAction('panel', 'quietSet');
eq(blockingUserAction(), false, '面板动作只记不拦');

clearUserAction();
markUserAction('switch', '手动切歌');
eq(blockingUserAction(), true, '手动切歌后拦');

clearUserAction();
markUserAction('source', 'wx');
eq(blockingUserAction(), true, '换来源后拦');

clearUserAction();
eq(blockingUserAction(0), false, '清零后不拦');

console.log('\n' + (bad ? `${bad} 项未通过` : '全部通过'));
process.exit(bad ? 1 : 0);
