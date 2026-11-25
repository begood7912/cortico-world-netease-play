/**
 * 包入口：宿主取 default 导出的 WorldDefinition（cortico world api 6）。
 */
import { LEDGER_DECL, PLAY_DECL, QUIET_DECL, RECO_DECL } from './tools.js';
import { OPTIONS_KIND, options } from './playlists.js';
import { modelNames, cloudModelNames, cloudCacheState, refreshCloudLazy, cloudHintState, EMBED_KIND, CHAT_KIND, MODEL_SOURCE_KIND, CLOUD_MODEL_KIND, VRAM_MODE_KIND } from './ollama.js';
import { NeteasePlayWorld } from './world.js';
import { EVENT_DECLS } from './events.js';
import { DEFAULTS } from './settings.schema.js';

const toDescribe = (decl, summary) => ({
  name: decl.name,
  description: decl.description,
  parameters: decl.parameters,
  tags: decl.tags,
  summary,
});

/** 0.17.58：事件的自描述。声明正文在 events.js，推送与 describe 共用一份，避免两处漂移。 */
const toEvent = (decl) => ({
  type: decl.type,
  description: decl.description,
  trigger: decl.trigger,
  tags: decl.tags,
});

export default {
  id: 'netease-play',
  label: '网易云陪听',
  defaults: () => ({
    enabled: false,
    // 全部键的默认值都来自 settings.schema.js（唯一来源，目前 51 项）。
    // 0.16.96 起与设置页共用一份；此前这里 vramMode 写 auto、设置页写 eco，是已知的漂移。
    ...DEFAULTS,
    // 宿主设置页专属（不在我们自己那一页里）
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiModelManual: '',
  }),
  /**
   * 动态下拉：WebUI 打开下拉前会调这里。
   *   OPTIONS_KIND  —— 网易云歌单（存的是歌单 ID）
   *   EMBED_KIND    —— Ollama 里能出向量的模型
   *   CHAT_KIND     —— Ollama 里能生成文字的模型
   * 模型表是启动时后台预热的缓存（configOptions 是同步契约，这里不能 await）。
   */
  configOptions(kind, language) {
    if (kind === OPTIONS_KIND) return options();
    if (kind === MODEL_SOURCE_KIND) {
      const zh = !language || String(language).toLowerCase().startsWith('zh');
      return [
        { value: 'local', label: zh ? '本机 Ollama' : 'Local Ollama' },
        { value: 'cloud', label: zh ? '云端（OpenAI 兼容）' : 'Cloud (OpenAI compatible)' },
      ];
    }
    if (kind === VRAM_MODE_KIND) {
      const zh = !language || String(language).toLowerCase().startsWith('zh');
      return [
        { value: 'auto', label: zh ? '全塞 GPU（最快，约 2.6 GB）' : 'Full GPU (fastest, ~2.6 GB)' },
        { value: 'eco', label: zh ? '省显存（约 0.9 GB，慢 1 秒）' : 'Low VRAM (~0.9 GB, +1 s)' },
        { value: 'cpu', label: zh ? '纯 CPU（不占显存，慢 1.3 秒）' : 'CPU only (no VRAM, +1.3 s)' },
      ];
    }
    if (kind === EMBED_KIND || kind === CHAT_KIND) {
      const zh = !language || String(language).toLowerCase().startsWith('zh');
      const none = { value: '', label: zh ? '不使用' : 'Not used' };
      return [none, ...modelNames(kind).map((name) => ({ value: name, label: name }))];
    }
    if (kind === CLOUD_MODEL_KIND) {
      // 每一次被点开都会走到这里：顺手用上次读到的地址/Key 去云端刷一遍模型表
      // （不 await，本次仍返回旧缓存；关掉再点一次就有新的了）。
      const zh = !language || String(language).toLowerCase().startsWith('zh');
      const hint = cloudHintState();
      refreshCloudLazy(hint.url, hint.key);
      const list = cloudModelNames();
      if (!list.length) {
        // 空表分三种情况，别让用户猜：没填、读失败（把原因带出来）、刚发出去还没回来
        const st = cloudCacheState();
        if (!hint.url || !hint.key) {
          return [{ value: '', label: zh ? '（先在上面填地址和 Key 并保存）' : '(fill URL + key first)' }];
        }
        if (st.error) {
          const cut = st.error.length > 90 ? `${st.error.slice(0, 90)}…` : st.error;
          return [{ value: '', label: zh ? `（读取失败：${cut}）` : `(read failed: ${cut})` }];
        }
        return [{ value: '', label: zh ? '（正在读取，关掉这个下拉再点一次）' : '(loading, close and reopen)' }];
      }
      return list.map((name) => ({ value: name, label: name }));
    }
    return [];
  },
  create: (ctx) => new NeteasePlayWorld(ctx),
  describe: {
    tools: [
      toDescribe(PLAY_DECL, {
        zh: '点歌：搜歌、排到歌单最前、从这批第一首连续播放、记点歌次数。',
        en: 'Play songs: search, move to the top of the playlist, play from the first, log counts.',
      }),
      toDescribe(LEDGER_DECL, {
        zh: '查点歌次数账本，看某首点过几次、哪首快够两次。',
        en: 'Read the play-count ledger.',
      }),
      // 0.17.41：describe 少了这两个工具 → 扩展市场的工具表只有 2 个，
      // 宿主的 `check:extension` 也会因为「tools() 返回的工具没在 describe.tools 里」报红。
      toDescribe(QUIET_DECL, {
        zh: '看她安静时想听哪首、接力刚接到哪首（她亲口说的，不是猜的）。',
        en: 'What she said she wants to hear while it is quiet.',
      }),
      toDescribe(RECO_DECL, {
        zh: '看当前来源（天气 / 听歌历史）推荐了什么；refresh 重算一批并立刻返回。',
        en: 'Read or refresh the current recommendation shelf.',
      }),
    ],
    // 0.17.58：补齐 events —— 宿主的 describe-export 会展开 `def.describe.events`，
    // 缺这个字段在导出时直接 TypeError；运行时还会被 undeclared-names 警告「type 不在 describe.events 里」。
    events: EVENT_DECLS.map(toEvent),
  },
};
