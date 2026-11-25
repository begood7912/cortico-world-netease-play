# 发布说明 / 安装说明

包名：**`cortico-world-netease-play`**（World id `netease-play`，对外名「网易云陪听」，作者 `ailing`）
npm：https://www.npmjs.com/package/cortico-world-netease-play
仓库：https://github.com/begood7912/cortico-world-netease-play

---

## 一句话：直接让大肥鱼帮你装

不用自己找文件、不用记命令。在 Coopanion 里对 AI 说这一句就行：

```
帮我装「网易云陪听」这个 World 扩展，npm 包名 cortico-world-netease-play，
先读它的 INSTALL.md，照着装好并跑一遍自检；需要我点界面的地方告诉我点哪里。
```

AI 会自己做这些事：在 `data\extensions` 里装包 → 把 `worlds["netease-play"].enabled` 打开 → 让你点「重启进程」和电源激活 → 跑 `node _check_env.mjs` 逐项核对 → 缺 Python 包就 `pip install`，缺调试端口就帮你把网易云拉起来。

---

## 手动装（三步）

**前提**：Windows 10/11 x64、Coopanion（支持 `api: 6` 的 World）、Node ≥ 22、Python 3.10+（含 `requests` `websocket-client` `pypinyin`）、本机装了官方网易云音乐 PC 客户端。

1. **装包**：Coopanion 设置 → **World 扩展** → 搜索框填完整包名 `cortico-world-netease-play` → 安装。
   （扩展页的源必须是 `https://registry.npmjs.org`；搜不到时直接填完整包名，npm 搜索索引对新包有延迟。）
2. **启用**：装完点「重启进程」，然后在「我的 World」里找到「网易云陪听」，点电源按钮**激活**（首次默认停用）。
3. **最小配置**：面板 → 设置页，填歌单名/ID、确认 `cdpPort=9229`（跟客户端一致）。

命令行等价做法：

```powershell
cd "D:\Programs\Coopanion\data\extensions"
pnpm add cortico-world-netease-play
```

装不上（网络/Python/端口有问题）看 `INSTALL.md`，里面有逐条排查表和 `node _check_env.mjs` 自检脚本。

---

## 可选组件（不装也能点歌）

| 组件 | 作用 | 说明 |
|---|---|---|
| 大肥鱼语音全能包 | 本机念「现在为你播放…」 | 市场搜「大肥鱼」，本机 9880 提供 `POST /audio/speech` |
| `edge-tts`（pip） | 微软在线神经语音（晓晓/云希…） | 面板 `ttsEngine` 切到「微软在线语音」，需联网 |
| Ollama 或云端 OpenAI 兼容接口 | 三张卡与天气推荐 | 面板「模型」页二选一 |
| 和风天气 Key | 「按天气」推荐来源 | 面板填 `qwApiKey` |

---

## 版本与发布记录

版本号只在 `package.json` 里维护，本文档不写「当前版本是多少」；下表只是历史记录。

| 版本 | 内容 |
|---|---|
| **0.1.17** | B2 慢路径按「包内 op3.py 优先」加载（修运行期旧副本顶掉新模块）；B3 快路径超时 2.5s→4.5s，并在冷态先等页面标题/侧栏渲染；B4 加歌不可用时不再先删歌、加失败自动回滚；B5 天气「刷新（远端）」改成最后一次点击后 30 秒防抖刷新；README 不再写死版本号 |
| 0.1.16 | 新增本文件（发布/安装说明）；README 安装段改为 npm 优先；旧发布元数据的遗留说明清掉 |
| 0.1.15 | `cortico.tags` 换成宿主规范 id：`apps` `companion` `memory` `voice` `sensitive-data` `unofficial-api`（界面显示：应用程序 / 陪伴 / 记忆 / 语音 / 读取隐私 / 非官方接口） |
| 0.1.14 | 作者改为 `ailing`；`py\playmp3.ps1` 转 UTF-8 带 BOM，修 Windows 下微软在线语音（晓晓）不出声 |
| 0.1.13 | 简介改为「让大肥鱼帮你点歌，不动鼠标键盘…仅支持网易云音乐，仅限 Windows」 |
| 0.1.12 | npm 首发版本 |

## 发布流程（照这个清单走，不用回忆）

> 这一段是自包含的：上下文被清掉、换台机器、或者让别的 AI 接手，只读这一段就能发一个版本。

### 0. 前置（一次性，已经配好了）

| 项 | 值 |
|---|---|
| 包名 | `cortico-world-netease-play`（World id `netease-play`） |
| npm 账号 | `begood7912`（`104105@qq.com`），已开 2FA |
| 发布专用配置 | `C:\Users\begoo\.npmrc-npmjs`（含 bypass-2FA 的 granular token；**token 会过期，过期就重新生成**） |
| Node / npm | `D:\Dev\node\node.exe`、`D:\Dev\node\npm.cmd`（v22 / npm 12） |
| Git | `D:\Git\cmd\git.exe`，远端 `https://github.com/begood7912/cortico-world-netease-play.git` |
| 开发目录 | `D:\Dev\coopanion-world-netease-play`（宿主以 `link:D:/Dev/...` 挂载，改完重载插件即生效） |
| 宿主扩展目录 | `D:\Programs\Coopanion\data\extensions`（`package.json` 里那条 `link:` 就是挂载点） |

### 1. 发版前自检（在开发目录跑）

```powershell
cd D:\Dev\coopanion-world-netease-play
D:\Dev\node\node.exe --check src\proc.js
D:\Dev\node\node.exe --check py\fastplay.js
D:\Dev\node\node.exe --check webui\panel.js
& 'C:\Users\begoo\AppData\Local\Programs\Python\Python312\python.exe' -m py_compile py\addplay.py
D:\Dev\node\node.exe _t_manifest.mjs   # 内部块/对端块引用
D:\Dev\node\node.exe _t_schema.mjs     # 设置项校验
D:\Dev\node\node.exe _t_source.mjs     # 来源/天气缓存
D:\Dev\node\node.exe _t_addplay.mjs    # 慢路径 dry-run
D:\Dev\node\node.exe _t_fast.mjs       # 快路径负例（不存在的歌 → ok:false 属正常）
D:\Dev\node\npm.cmd pack --dry-run     # 末尾看 total files / package size
```

### 2. 升版本号

**版本号只在 `package.json` 里维护**——README / PUBLISH / INSTALL 一律不写死版本（写死了就会像 0.1.15 那次一样对不上真实版本）。

```powershell
(Get-Content package.json -Raw) -replace '"version": "旧版本"','"version": "新版本"' | Set-Content package.json -NoNewline -Encoding utf8
```

### 3. 暂存发布

```powershell
cd D:\Dev\coopanion-world-netease-play
D:\Dev\node\npm.cmd stage publish --userconfig='C:\Users\begoo\.npmrc-npmjs'
```

成功会打印 `has been staged with id <uuid>`、`status: validating`。

- **别用 `npm publish`**：当前这个 token 只能进暂存区，直发必然 `E403 E_STAGE_REQUIRED`。
- **别用镜像 registry**：`extensions\.npmrc` 里是 `registry=https://registry.npmjs.org`，发布也走官方。

核对暂存：

```powershell
D:\Dev\node\npm.cmd stage list --userconfig='C:\Users\begoo\.npmrc-npmjs'
```

### 4. 网页点批准（只能人点）

1. https://www.npmjs.com/settings/begood7912/staged-packages
2. 找到新版本 → **Approve** → 弹框再点 **Approve packages**
3. 页面出现 `x.y.z published successfully` 即完成

坑：

- 自动审核没跑完时 Approve 是灰的，等几分钟刷新。
- 命令行 `npm stage approve` 要 WebAuthn（EOTP），日志里 auth URL 被打码，实操只能网页点。
- 忘了 2FA 恢复码就只能走账号申诉，恢复码自己存好。

### 5. 发完核对

```powershell
D:\Dev\node\npm.cmd view cortico-world-netease-play version dist-tags author --userconfig='C:\Users\begoo\.npmrc-npmjs'
# 期望：version = 新版本，dist-tags.latest = 新版本

# 下载量（新版本刚发时接口可能返回 not found＝0，属正常）
curl.exe -s "https://api.npmjs.org/downloads/point/last-week/cortico-world-netease-play"
curl.exe -s "https://api.npmjs.org/downloads/point/last-month/cortico-world-netease-play"
```

下载量只统计 tarball 拉取次数（含机器人/CI），公开可见、有延迟，**没有独立的访问 PV 或真实装机人数**。

### 6. 推源码

```powershell
cd D:\Dev\coopanion-world-netease-play
D:\Git\cmd\git.exe add -A
D:\Git\cmd\git.exe commit -m "x.y.z: 改动摘要"
D:\Git\cmd\git.exe push origin main
```

- 提交信息首段写版本号 + 一句话摘要，和 PUBLISH 表里那行对应。
- 若报 `Failed to connect to github.com:443` / `schannel: server closed abruptly`，是本地到 GitHub 网络问题：提交已在本地，网络恢复后补 `push` 即可，别重做提交。

### 7. 市场里什么时候能看到

宿主缓存：`D:\Programs\Coopanion\data\extensions\market-catalog.json`（含 `version` / `description` / `tags` / `discussion` / `downloads`）。

- 发布后要等宿主自己刷一次目录（几十分钟级），市场卡片版本号才会变。
- **市场只显示 `package.json` 里的 `description`（一两句话），不显示 README / 本文件的长文**——所以「安装说明」想让别人在市场里看到，只能压缩进 `description`；长说明靠卡片上的 npm / 仓库链接点过去。
- 讨论区（💬/▲▼）来自 `Pal-AI-Lab/cortico-extensions` Discussions，包进市场索引后会自动建一条线程。

### 常见报错对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `E403 ... E_STAGE_REQUIRED` | 用了 `npm publish` 直发 | 改 `npm stage publish` |
| `E404` / `404 Not Found` on PUT | 包名拼错、或 token 无该包权限 | 核对包名、token 权限（Packages: read and write） |
| `EOTP` / `Authentication requires a one-time password` | token 没勾 bypass-2FA 或已过期 | 重新生成 granular token 写进 `.npmrc-npmjs` |
| `npm search` 搜不到 | 新包索引延迟 | 等；用 `npm view` 核对，别据此判断发布失败 |
| 市场卡片还是旧版本/看不到 | 宿主目录缓存未刷新 / 未收录 | 等刷新；必要时重启宿主 |

