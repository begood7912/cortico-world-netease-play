# 安装指南（AI 可直接照着执行）

> 目标读者：**帮用户装这个插件的 AI**，以及愿意自己动手的人。
> 这个包是 Coopanion 的一个 World 扩展（`cortico-world-netease-play`，world id `netease-play`，契约 `api: 6`）。
> 它**不是**独立程序：必须有 Coopanion 宿主才能跑。

---

## 0. 给 AI 的一句话指令（用户复制这句就行）

```
把这个文件夹装成 Coopanion 的 World 扩展：先读 INSTALL.md，按 §2 的顺序执行，
每步做完跑 node _check_env.mjs 看结果；§5 里列的本机路径常量如果对不上，先问我要不要改；
需要点界面（安装扩展、重启进程、激活电源）的地方停下来告诉我点哪里。
```

---

## 1. 硬性前提（缺一项就跑不起来）

| 组件 | 要求 | 用途 / 说明 |
|---|---|---|
| 操作系统 | **Windows 10 / 11 x64** | 用了 `cloudmusic.exe`、`taskkill`、PowerShell `SoundPlayer`，没有跨平台实现 |
| Coopanion | 能加载 `api: 6` 的 World（本机实测 0.2.23） | 宿主；扩展根在它的数据目录下 |
| Node.js | **≥ 22**（`package.json` 里 `engines`） | `py/*.js` 子脚本要用全局 `fetch` / `WebSocket` |
| Python | **3.12**（3.10+ 一般也行） | `py/*.py` 子脚本 |
| Python 包 | `requests`、`websocket-client`、`pypinyin` | 缺任何一个，点歌主链路直接失败 |
| 网易云音乐 PC 客户端 | 官方客户端，**必须能以调试端口启动** | 播放/搜歌/歌单全靠 CDP（默认 `9229`） |
| PowerShell | 系统自带 5.1（`System32\WindowsPowerShell\v1.0`） | 兜底读播放状态、播 wav |

| python 包（可选） | `edge-tts` | 「微软在线语音」那一路（晓晓/云希…）要用；不用就留着不装 |

一条命令装 Python 包：

```powershell
python -m pip install --upgrade requests websocket-client pypinyin
# 想用微软在线神经语音（晓晓、晓伊、云希…）再加一句
python -m pip install --upgrade edge-tts
```

---

## 2. 安装步骤（按顺序）

### 2.1 把包放到一个固定目录

例如 `D:\Worlds\coopanion-world-netease-play`。
**不要**放进 `data\extensions\node_modules` 里手改 —— 那个目录由 pnpm 管。

### 2.2 用宿主的「手动安装」登记这个目录（推荐，GUI）

1. 打开 Coopanion 设置窗口 → **World 扩展** → **手动安装**；
2. 填**文件夹的绝对路径**（上面那个目录），安装；
3. 装完会在「待生效」里出现 → 点 **重启进程**；
4. 在「我的 World」里找到「网易云陪听」，点电源按钮**激活**（首次默认是停用的）。

宿主做的就是：在 `data\extensions` 里 `pnpm add <绝对路径>`，把依赖写进 `extensions\package.json`。

### 2.3 等价的命令行做法（不想点界面时）

```powershell
cd "D:\Programs\Coopanion\data\extensions"      # 换成你的 Coopanion 数据目录
pnpm add "D:\Worlds\coopanion-world-netease-play"
pnpm install
```

> 没有 pnpm：`corepack enable pnpm` 或 `npm i -g pnpm@9`。

然后确认 `extensions\package.json` 的 `dependencies` 里有：

```json
"cortico-world-netease-play": "link:D:/Worlds/coopanion-world-netease-play"
```

### 2.4 在配置里启用这个世界

编辑 `data\home\companion\config.json`（**先备份**），确保有：

```json
"worlds": {
  "netease-play": { "enabled": true }
}
```

`world-owners.json` 里的 `"netease-play": "cortico-world-netease-play"` 宿主会自己维护，不必手写。

### 2.5 重启

「重启进程」按钮，或退出 Coopanion 再打开（`src/*.js` 不热更，新文件要重启才加载）。

### 2.6 让网易云客户端带调试端口

插件会用 `--remote-debugging-port=9229` 启动/重启客户端（`src/client.js`、`py/addplay.py`）。
先确认端口通：

```powershell
Invoke-WebRequest http://127.0.0.1:9229/json/version -UseBasicParsing | Select-Object -ExpandProperty Content
```

打不通时：关掉网易云 → 手动用带参数的方式启动一次，或直接在面板里点一次「点歌」让它自己拉起来（客户端路径要在 §5 的候选列表里）。

### 2.7 面板里做一次最小配置

打开「网易云陪听」→ **设置** 页：

| 项 | 建议值 |
|---|---|
| 歌单 `playlist` | 你的歌单名或歌单 ID（默认落「小菱的歌单」） |
| `cdpPort` | 9229（跟客户端一致） |
| `chainSource` | `reco`（按听歌历史）或 `wx`（按天气） |
| `chainPick` / `chainSpeak` | 按需打开接力与播报 |

---

## 3. 可选组件（不装也能点歌，只是少功能）

### 3.1 语音（本机念出来）

- 装扩展 **大肥鱼语音全能包**（`@wocwang/cortico-world-gpt-sovits-for-coopanion`，市场搜「大肥鱼」/「GPTSovits」）；
  它自带运行时与模型（首次下载约 4–7 GB），在本机 **9880** 提供 OpenAI 兼容的 `POST /audio/speech`。
- 或任何提供 `POST {base}/audio/speech`（body `{input}`，返回 wav）的服务，把面板 `ttsUrl` 指过去。
- 自检：`Invoke-WebRequest http://127.0.0.1:9880/audio/speech -Method Post ...` 或跑 `node _check_env.mjs`。
- 不装语音：把 `announce` 关掉即可，点歌/接力/记账全部照常。

### 3.2 卡片与推荐用的模型（二选一）

| 方式 | 怎么配 | 说明 |
|---|---|---|
| 本机 **Ollama**（11434） | 面板「模型」页：`modelSource=local`，选 `chatModel` + `embedModel`；Ollama 里先 `ollama pull` 好 | 卡②③④与天气推荐要它；纯 CPU 会很慢 |
| **云端 OpenAI 兼容** | `modelSource=cloud`，填 `openaiUrl` / `openaiKey` / `openaiModel` | 填完点模型下拉会去拉一次模型表 |

都不配：点歌、接力、账本照常，只是三张卡与天气推荐出不来。

### 3.3 和风天气 Key（只有「按天气」来源要）

面板设置里填 `qwApiKey`（和风天气控制台申请），`qwApiHost` 默认 `&lt;你的和风 Host&gt;`，`qwCity` 填城市名。

---

## 4. 装完自检

```powershell
node _check_env.mjs
```

它会逐项检查并给出「OK / 缺什么 / 怎么补」：Node 版本、Python 版本与三个包、9229 / 9880 / 11434 端口、宿主数据目录、扩展是否登记、`config.json` 是否启用、`proc.js` 的本机路径常量是否对得上。

真机验收（人工）：

1. 面板「此刻」页能显示当前在播（说明 CDP + 采样通了）；
2. 说「放《晴天》」→ 歌单最前出现并开始播（说明 Python 链路通了）；
3. 面板「点歌排名」出现这条记录（说明账本写入路径对）；
4. 装语音时，能听到「现在为你播放…」。

---

## 5. 必须按机器改的常量（这是最容易被忽略的一步）

包里为了不依赖环境变量，把几处本机路径写死了。装到别的机器时**对不上就要改**：

| 文件:行 | 常量 | 应该改成 |
|---|---|---|
| `src/proc.js:58` | `WORK_DIR` = `D:\Programs\Coopanion\data\home\companion\workspace` | 你这台机器的 `<Coopanion数据目录>\home\companion\workspace` |
| `src/proc.js:44-47` | `PY_CANDIDATES` 首选 `C:\Users\begoo\...\Python312\python.exe` | 你的 Python 绝对路径；或保证 `python` 在 PATH（会自动退到它） |
| `src/proc.js:33-37` | `NODE_CANDIDATES` 首选 `D:\Dev\node\node.exe` | 你的 node 绝对路径；或保证 `node` 在 PATH |
| `src/client.js:59-70` | 网易云客户端路径候选 | 加上你的 `cloudmusic.exe` 位置（`LOCALAPPDATA` 已自动兜底） |
| `py/addplay.py:57` | `EXE` 同上 | 同上（脚本会重启客户端，必须找得到） |
| `py/addplay.py:60` / `py/pick_ledger.py:25` | 兜底工作区路径 | 与 `WORK_DIR` 保持一致 |

改完不需要重启宿主才生效的只有纯 Python 脚本；`src/*.js` 的改动**要重启**。

`_check_env.mjs` 会把上面每一项跟本机实际情况比一遍。

---

## 6. 卸载

1. 「我的 World」里先**停用** 网易云陪听；
2. 在扩展详情点**卸载**（或 `pnpm remove cortico-world-netease-play`）；
3. 重启进程；
4. 插件自己的数据在包目录 `data\` 下，账本在 `<工作区>\notes\`，需要一起清就手动删。

---

## 7. 常见问题（按报错找）

| 现象 | 原因 | 处理 |
|---|---|---|
| 扩展显示「已安装，未加载」 | 还没重启进程 | 点「重启进程」 |
| 显示「已停用」 | `config.json` 里 `enabled` 是 false | 点电源激活 |
| 点歌返回「后端不可用 / 起不来脚本」 | Python 或三个包缺 | `pip install requests websocket-client pypinyin` |
| 提示「连不上客户端或抓不到 cookie」 | 客户端没带调试端口 | 见 §2.6；确认 `cloudmusic.exe` 路径在候选里 |
| 面板没有「此刻」数据 | CDP 不通或采样没跑 | 看 `data\log\external.log` 里 `endpoint:"listening"` |
| 一句话都没有声音 | `ttsUrl` 不通 / 没装语音扩展 | 见 §3.1；或关 `announce` |
| 三张卡一直是空的 | 没配模型 | 见 §3.2 |
| 天气卡空白 | 没填和风 Key | 见 §3.3 |
| 账本写不进 | `WORK_DIR` 不对 | 见 §5 |

---

## 8. 发布前（现在没做，先记着）

`package.json` 还缺三样发布元数据：`os`（应为 `["win32"]`）、`cortico.tags`、根目录 `CHANGELOG.md`。
等决定发布时再补，不影响本机安装。
