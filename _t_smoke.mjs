import { readNow } from './src/nowplaying.js';
import { readProgress } from './src/progress.js';
import { getLiked } from './src/liked.js';
import { readLyric } from './src/lyric.js';
import { refresh } from './src/playlists.js';
import { peekRecoPlaylist } from './src/recoPlaylist.js';
import { ensureChart } from './src/chart.js';
const cfg = { cdpPort: 9229, playlist: '', favThreshold: 2 };
const safe = async (name, fn) => {
  try { const v = await fn(); console.log(name, '->', JSON.stringify(v).slice(0, 160)); }
  catch (e) { console.log(name, '-> 异常', e && e.message); }
};
await safe('nowplaying', () => readNow({ fresh: true }));
await safe('progress', () => readProgress({ cdpPort: 9229, fresh: true }));
await safe('liked', () => getLiked({ title: '起风了', artist: '买辣椒也用券', cdpPort: 9229 }));
await safe('lyric', () => readLyric({ title: '起风了', artist: '买辣椒也用券', cdpPort: 9229 }));
await safe('playlists', () => refresh(9229));
await safe('recoList', () => peekRecoPlaylist());
await safe('chart', () => ensureChart(cfg, { force: true }).then((r) => ({ ok: r.ok, n: (r.charts || []).length, err: r.error })));
