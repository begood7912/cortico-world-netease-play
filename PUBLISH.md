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

| 版本 | 内容 |
|---|---|
| **0.1.16** | 新增本文件（发布/安装说明）；README 安装段改为 npm 优先；旧发布元数据的遗留说明清掉 |
| 0.1.15 | `cortico.tags` 换成宿主规范 id：`apps` `companion` `memory` `voice` `sensitive-data` `unofficial-api`（界面显示：应用程序 / 陪伴 / 记忆 / 语音 / 读取隐私 / 非官方接口） |
| 0.1.14 | 作者改为 `ailing`；`py\playmp3.ps1` 转 UTF-8 带 BOM，修 Windows 下微软在线语音（晓晓）不出声 |
| 0.1.13 | 简介改为「让大肥鱼帮你点歌，不动鼠标键盘…仅支持网易云音乐，仅限 Windows」 |
| 0.1.12 | npm 首发版本 |

发布流程（作者自己用）：

```powershell
# 1) 改完代码，升 package.json 版本号
# 2) 暂存发布（官方 registry，别用镜像）
npm stage publish --access public --userconfig='C:\Users\begoo\.npmrc-npmjs'
# 3) 打开 https://www.npmjs.com/settings/begood7912/staged-packages 点 Approve（要 Windows Hello 验证）
#    自动审核没跑完前 Approve 按钮是灰的，等几分钟刷新
# 4) 推送源码
git push origin main
```

> npm 现在强制「分阶段发布（staged publish）」：`npm publish` 直接发会被拒，必须 `npm stage publish` + 网页 Approve。
> 命令行 `npm stage approve` 会要求 WebAuthn，日志里 auth URL 被打码，实操只能走网页点。
