import { playSongs } from './src/python.js';

const run = async (label, songs) => {
  const r = await playSongs({ playlist: '小菱的歌单', songs, auto: false, dryRun: true, cdpPort: 9229, autoFav: false });
  console.log('==', label, 'code', r.code);
  console.log((r.out || '').trim().split(/\r?\n/).slice(-6).join('\n'));
  console.log('RESULT', JSON.stringify(r.result).slice(0, 300));
};

await run('只有 id', [{ name: '童年', artist: '罗大佑', id: '109530' }]);
await run('只有歌名', [{ name: '起风了', artist: '买辣椒也用券' }]);
