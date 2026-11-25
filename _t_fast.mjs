import { fastPlay } from './src/fastplay.js';
const r = await fastPlay({ cdpPort: 9229, title: '这个歌不存在zzz', artist: '没人', playlist: '小菱的歌单' });
console.log(JSON.stringify(r).slice(0, 300));
