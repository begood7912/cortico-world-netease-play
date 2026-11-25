# 网易云陪听（cortico-world-netease-play）

Coopanion 的一个 World 插件（`kind: world`，`api: 6`）：在桌面陪听里点歌、报幕、记账，
并把「点歌 / 查账 / 查她想听什么 / 换一批推荐」交给主 AI 的四个工具。

当前版本见 `package.json`（0.1.11）。开发记录与历史改动日志不随包发布（备份在 F 盘 `coopanion-world-netease-play.bak-*/开发记录-后续\`）。
**要装给别人用 → 看 `INSTALL.md`**（装什么、按什么顺序装、装完怎么自检，AI 可直接照着执行）。

## 它做什么

- **点歌**：按歌名搜 → 排到歌单最前 → 从这批第一首连续播放 → 记点歌次数；第 2 次自动进「我喜欢的音乐」。
- **陪听三张卡**：听满 30 / 60 / 90 秒，各用本机语音说一句（`announce` 是总闸）。
- **接力点歌**：一首接一首，剩约 30 秒播报、剩约 10 秒切；只在「她推、你接受」那条路上接。
- **推荐来源开关**（设置里二选一）：听歌历史 / 按天气。
  **只有被选中的那一路在刷新**；另一张卡显示「已停用」，不拉榜、不算向量。
  接力挑歌、语音播报、安静提议都跟着这个开关走。
- **天气**：后台按固定间隔抓一次，落 `data/weather-cache.json`；其余所有读天气的地方只读这份缓存。
- **面板四个页签**：点歌排名 / 此刻 / 模型 / 设置。

## 目录

```
package.json      World 声明（kind=world, api=6, webUiClient=webui/panel.js）
describe.json     工具/事件自描述（扩展市场 / 宿主自检用，不参与运行；由 _gen_describe.mjs 生成）
ENV_PROMPT.md     用法提示词模板（带 {{song.port}} 等占位符，由宿主渲染）
src/              宿主侧代码：L1 接口 / L2 业务 / L3 服务 / L4 基础
  manifest.js     分层总表（新增模块必须在这里登记，_t_manifest.mjs 会查）
py/               子进程脚本（Python / Node / PowerShell），随包走
webui/            客户端面板（panel.js + panel.css）
```

## 四个工具

| 工具 | 作用 |
|---|---|
| `netease_play` | 点歌：`songs[]` / `playlist` / `auto` / `random` |
| `netease_ledger` | 查点歌次数账本 |
| `netease_quiet` | 她安静时说了想听哪首 / 接力接到哪首 |
| `netease_reco` | 看当前来源的推荐；`refresh:true` 立刻返回并后台重算 |

## 配置

全部 54 项定义在 `src/settings.schema.js`（唯一的类型/默认值/范围来源），
在面板「设置」页与「模型」页里改，宿主设置页不再挂配置组。

最常用的几项：

| 键 | 说明 |
|---|---|
| `chainSource` | `reco`（听歌历史）/ `wx`（按天气）。**来源总开关**：接力挑歌 + 播报 + 只刷新这一路 |
| `chainPick` / `chainSpeak` | 接力总闸 / 是否念「即将播放…」 |
| `chainCharts` | 候选从哪几个榜取（最多 8 个榜、300 首） |
| `qwInterval` 等 `qw*` | 天气抓取（固定间隔，不受其他动作影响） |
| `modelSource` / `chatModel` / `embedModel` | 本机 Ollama 或云端 |
| `ttsEngine` | `gpt`（GPT-SoVITS 服务，默认）/ `windows`（系统自带语音）/ `edge`（微软在线神经语音：晓晓/云希…，需 `pip install edge-tts` 且联网） |
| `ttsUrl` | GPT-SoVITS 地址（随大肥鱼全能语音包，默认 9880） |
| `ttsVoice` | 音色（下拉，跟着引擎走）。Windows TTS 列系统已装语音；微软在线语音列中文神经音色（晓晓、晓伊、云希…）；GPT-SoVITS 随大肥鱼全能语音包配置，此值不生效 |
| `cdpPort` | 网易云调试端口（默认 9229） |
| `autoFav` / `favThreshold` | 点满几次进「我喜欢的音乐」 |

## 数据放在哪

- 状态/缓存：`data/`（`shelf` 相关、`recommend.json`、`weather-cache.json`、`lyric-cache.json`…）
- 日志：`data/log/events.jsonl`（内部事件）、`data/log/external.log`（对端失败）
- 账本：`…\Coopanion\data\home\companion\workspace\notes\`（`点歌次数.json` / `点歌记录.md` / `点歌计数.md`）

## 运行依赖

| 组件 | 用途 |
|---|---|
| Python 3.12 + `requests` / `websocket-client` | `py/` 下的脚本 |
| Node ≥ 22 | `py/` 下的 JS 脚本（全局 fetch / WebSocket） |
| 网易云 PC 客户端 + CDP 9229 | 播放、搜歌、歌单 |
| GPT-SoVITS（9880，随大肥鱼全能语音包） | 本机语音 |
| Ollama（11434）可选 | 三张卡的模型；云端 OpenAI 兼容接口二选一 |
| 和风天气 Key | 「按天气」来源 |

## 安装

给新机器/别人装：照 `INSTALL.md` 走（含逐条命令、可选组件、自检脚本 `node _check_env.mjs`）。
这里只留最短版本：`data\extensions\` 里 `pnpm add <包目录绝对路径>`（或设置页「手动安装」填路径）→
`config.json` 的 `worlds.netease-play.enabled = true` → 重启 Coopanion。
`world-owners.json` 由宿主加载成功后自己维护，一般不用手写。

## 自测

```
node _t_manifest.mjs     # manifest 分层/归属/对端声明
node _t_source.mjs       # 来源开关：翻译、门控、天气只读缓存
node _t_schema.mjs       # 设置项 schema
node _t_smoke.mjs        # 冒烟
```

`_t_source.mjs` 默认不碰 `data/`；要在本包目录里跑「设置页切换」那一段，设 `NCM_TEST_LIVE=1`。
