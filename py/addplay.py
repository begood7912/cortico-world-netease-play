# -*- coding: utf-8 -*-
"""把歌加进指定歌单，并按顺序从这批第一首开始连播（2026-11-21 起：1 首 / 10 首 / 100 首 全走同一套）。

流程固定三步：先把这批歌从歌单里删掉（有就删、没有也照过）→ 反序加回最前面 →
切到该歌单双击第一行，队列=整张歌单，从这批第一首开始连续播。

底层复用 2026-11-13 实测通的老实现 run/tools/op3.py：
  9229 CDP 抓 cookie -> 明文 music.163.com api 搜歌/加歌 -> CDP 点侧栏歌单 + 「播放全部」

挑歌打分（2026-11-18 加）：标题是否等于歌名、歌手是否对得上、originCoverType(1=原唱 2=翻唱)、
popularity(热度 0-100)、MV、时长、以及 cover/翻唱/伴奏/钢琴版/DJ/女声版/Live 这类减分词。

用法：
  python addplay.py "晴天" "1111111"
  python addplay.py "晴天" "1111111" "周杰伦"
  python addplay.py "晴天" "1111111" "周杰伦" --cand    # 只看候选评分，不加不播
  python addplay.py "晴天" "1111111" --pick 2           # 手动指定候选序号
  python addplay.py --list                              # 看我能加的歌单

批量（2026-11-18 加）：
  python addplay.py "起风了+漠河舞厅+后来" "1111111"            # 用 + 或 ; 分隔多首
  python addplay.py "起风了|冯沁苑+后来|刘若英" "周六"           # 每首单独指定歌手
  python addplay.py --file songs.txt "周六"                    # 从 txt 读清单，一行一首
  python addplay.py --file songs.txt "周六" --no-play          # 只加不播
  python addplay.py "起风了" "周六" --auto                     # AI 自己挑的：只播不记账
  python addplay.py "id:1330348068" "1111111"           # 已知 id 直接加

给 Copilot / DeepSeek 用的 JSON 批量模式（2026-11-20 加）：
  python addplay.py "周六" --json songs.json
  python addplay.py "周六" --json -                # 从标准输入读 JSON
  python addplay.py "周六" --json songs.json --dry-run    # 只搜不写，安全的预演
  python addplay.py "周六" --json songs.json --no-play    # 只加进歌单，不播

  JSON 支持这些写法（都行）：
    [{"name":"七里香","artist":"周杰伦","score":9.2,"alt":["七里香 钢琴版"]},
     {"name":"江南","artist":"林俊杰"}]
    ["七里香","江南"]                       # 纯歌名数组
    {"songs":[{"name":"七里香","artist":"周杰伦"}]}

  行为（2026-11-21 统一，1 首 / 10 首 / 100 首 都这样）：
    · 每首歌按「歌名+歌手」搜，主结果搜不到时依次试 alt 里的候选
    · 解析成功后：先把这批歌从歌单里删掉（有就删、没有也照过），再反序加回最前面
      —— 这样这批歌一定是「按你点的顺序、连续排在最前」，不受「已在歌单里的歌不挪位置」影响
    · 然后切到该歌单双击第一行：队列=整张歌单，从这批第一首开始连续播下去
    · 最后一行为机器可读结果：RESULT_JSON {...}（Copilot 读这一行就能拿到全量结果）

"""
import difflib
import os
import re
import sys
import json
import socket
import subprocess
import time

EXE = r"C:\Program Files\NetEase\CloudMusic\cloudmusic.exe"
NOWIN = 0x08000000  # CREATE_NO_WINDOW

TOOLS = os.environ.get("NCM_TOOLS_DIR") or r"D:\Programs\Coopanion\data\home\companion\workspace\run\tools"
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

try:
    import op3
except Exception as e:
    print("加载 op3.py 失败：%s" % e)
    sys.exit(1)


# CDP 端口：默认 9229，可用环境变量 NCM_CDP_PORT 换（World 面板里配的那个就是它）
CDP_PORT = int(os.environ.get("NCM_CDP_PORT") or 9229)


def port_open(port=None, wait=1.0):
    port = CDP_PORT if port is None else port
    s = socket.socket()
    s.settimeout(wait)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except BaseException:
        return False
    finally:
        try:
            s.close()
        except BaseException:
            pass


def _cloudmusic_running():
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq cloudmusic.exe", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace",
                             creationflags=NOWIN, timeout=20)
        return "cloudmusic.exe" in (out.stdout or "").lower()
    except BaseException:
        return False


def _launch(with_port=True):
    args = [EXE]
    if with_port:
        args += ["--remote-debugging-port=%d" % CDP_PORT, "--remote-debugging-address=127.0.0.1"]
    return subprocess.Popen(args, creationflags=NOWIN)


def ensure_client(allow_restart=True):
    """9229 不通就用带调试端口的参数拉起客户端。
    网易云是单实例的：已经以「无端口」方式开着时，再起一个进程不会开端口，
    所以必须先把它退干净再重新带端口启动（--no-restart 可禁止这一步）。"""
    if port_open():
        return "%d 已开" % CDP_PORT
    if not os.path.exists(EXE):
        return "找不到 cloudmusic.exe"

    restarted = False
    if _cloudmusic_running():
        if not allow_restart:
            return "客户端在运行但没 9229；已加 --no-restart，不自动重启（请手动退掉客户端后重跑）"
        restarted = True
        print("[客户端] 检测到客户端已在运行但没有 9229，正在重启（会短暂中断当前播放）…")
        print("[客户端] 检测到客户端已在运行但没有 9229，正在重启（会短暂中断当前播放）…")
        try:
            subprocess.run(["taskkill", "/F", "/IM", "cloudmusic.exe"],
                           capture_output=True, creationflags=NOWIN, timeout=30)
        except BaseException as e:
            return "关闭旧客户端失败：%s（请手动退出网易云后重跑）" % e
        for _ in range(20):
            time.sleep(0.5)
            if not _cloudmusic_running():
                break
        if _cloudmusic_running():
            return "旧客户端没退干净，9229 起不来（请手动退出网易云后重跑）"

    try:
        _launch(True)
    except Exception as e:
        return "拉起客户端失败：%s" % e
    for _ in range(24):
        time.sleep(0.5)
        if port_open(wait=0.5):
            return "已重启客户端并带 9229" if restarted else "已启动客户端并带 9229"
    return "拉起后 9229 仍不通"

API = "https://music.163.com"
BAD_WORDS = ["cover", "翻唱", "翻自", "片段", "伴奏", "钢琴", "纯音乐", "吉他", "口琴",
             "dj", "remix", "女声", "男声", "慢速", "降调", "升调", "live", "现场",
             "铃声", "消音", "和声", "八音盒", "童声", "变调", "加速", "电音", "抖音",
             "acoustic", "instrumental", "karaoke", "demo", "伴奏版", "纯享"]


def die(msg, code=2):
    print(msg)
    sys.exit(code)


def norm(text):
    """去掉括号里的内容、空格、大小写差异，用于判断是不是同一首歌名。"""
    t = (text or "").lower()
    t = re.sub(r"[\(\（\[\【].*?[\)\）\]\】]", "", t)
    t = re.sub(r"[^\w\u4e00-\u9fff]+", "", t)
    return t


# ---------- 语音听错纠偏（2026-11-21 加） ----------
# 语音转文字常把歌名转成同音字（如愿→如怨、稻香→盗香），字面一比就查无此歌。
# 拿拼音去比就能对上。字典只从本地点过的账本取，不额外发请求。

try:
    from pypinyin import lazy_pinyin
    _HAS_PINYIN = True
except Exception:
    _HAS_PINYIN = False
    print("[提示] 没装 pypinyin，语音纠错只能用字面近似（pip install pypinyin 更好用）")

_TITLES_CACHE = None


def _py(text):
    """转成无声调拼音串；没装 pypinyin 就退回原文小写。"""
    t = norm(text)
    if not t:
        return ""
    if _HAS_PINYIN:
        try:
            return "".join(lazy_pinyin(t)).lower()
        except Exception:
            return t.lower()
    return t.lower()


def _known_titles():
    """账本里点过的歌名 {拼音: 官方名}，当纠错字典用。读本地文件，零请求。"""
    global _TITLES_CACHE
    if _TITLES_CACHE is not None:
        return _TITLES_CACHE
    out = {}
    try:
        import pick_ledger
        led = pick_ledger._load()
        for rec in (led.get("songs") or {}).values():
            n = (rec.get("name") or "").strip()
            if n:
                out.setdefault(_py(n), n)
    except Exception as e:
        print("    [纠错字典] 读账本失败：%r" % (e,))
    _TITLES_CACHE = out
    return out


def fuzzy_title(name, cut=0.80):
    """把「如怨」这种听错的歌名纠成账本里的官方名。返回 (官方名, 相似度) 或 None。"""
    py = _py(name)
    if not py:
        return None
    known = _known_titles()
    best, best_ratio = None, 0.0
    for kpy, kname in known.items():
        if not kpy:
            continue
        r = difflib.SequenceMatcher(None, py, kpy).ratio()
        if r > best_ratio:
            best, best_ratio = kname, r
    if best and best_ratio >= cut and norm(best) != norm(name):
        return best, best_ratio
    return None



def fetch_details(s, ids):
    if not ids:
        return {}
    try:
        r = s.get(API + "/api/song/detail", params={"ids": json.dumps(ids)},
                  headers=op3.HEADERS, timeout=20)
        songs = (r.json() or {}).get("songs") or []
    except Exception:
        return {}
    return {so.get("id"): so for so in songs}


def score_song(so, detail, want_name, want_artist):
    """返回 (分数, 理由列表)。"""
    reasons = []
    pts = 0.0

    raw_name = so.get("name") or ""
    name_n = norm(raw_name)
    want_n = norm(want_name)

    if name_n == want_n:
        pts += 45
        reasons.append("歌名一致 +45")
    elif want_n and want_n in name_n:
        pts += 20
        reasons.append("歌名包含 +20")
    else:
        pts -= 60
        reasons.append("歌名不一致 -60")

    artists = [a.get("name") or "" for a in (so.get("artists") or [])]
    joined = "/".join(artists).lower()
    if want_artist:
        if want_artist.lower() in joined:
            pts += 25
            reasons.append("歌手命中 +25")
        else:
            pts -= 20
            reasons.append("歌手不对(%s) -20" % "/".join(artists))

    # originCoverType: 1=原唱 2=翻唱
    oct_ = (detail or {}).get("originCoverType") or so.get("originCoverType")
    if oct_ == 1:
        pts += 25
        reasons.append("原唱标记 +25")
    elif oct_ == 2:
        pts -= 20
        reasons.append("翻唱标记 -20")

    pop = (detail or {}).get("popularity")
    if isinstance(pop, (int, float)):
        add = round(float(pop) * 0.2, 1)
        pts += add
        reasons.append("热度 %.0f +%.1f" % (pop, add))

    if (so.get("mvid") or 0) > 0:
        pts += 6
        reasons.append("有 MV +6")

    dur = (so.get("duration") or 0) / 1000.0
    if dur and dur < 60:
        pts -= 35
        reasons.append("时长 %.0fs 太短 -35" % dur)
    elif dur < 150:
        pts -= 25
        reasons.append("时长 %.0fs 疑似片段 -25" % dur)
    elif dur >= 150:
        pts += 8
        reasons.append("时长正常 +8")

    low = raw_name.lower()
    hits = [w for w in BAD_WORDS if w in low]
    if hits:
        penalty = min(45, 15 * len(hits))
        pts -= penalty
        reasons.append("版本词(%s) -%d" % (",".join(hits), penalty))

    # 名字里带括号备注（如「起风了 (Acoustic)」「七里香 (MV版)」）通常是衍生版本
    if re.search(r"[\(\（\[\【]", raw_name or ""):
        pts -= 8
        reasons.append("带括号版本备注 -8")

    if (so.get("fee") or 0) == 8:
        pts -= 5
        reasons.append("付费/无版权(fee=8) -5")

    return round(pts, 1), reasons


class RateLimited(Exception):
    """网易云搜索接口被限流(200 里带 code 405)。"""
    pass


# 2026-11-21 加：第一遍查询就搜到这个分数（且歌手对得上）时，后面的查询不再搜。
# 75 分大致等于「歌名完全一致 + 有原唱标记 + 时长正常」，够用了。
EARLY_STOP_SCORE = 75.0

# 网易云明文接口大约「每秒 5 次」就限流，超了大概锁 10 秒。
# 所以自己先排队：每次请求之间至少隔 API_GAP 秒(≈3.3 次/秒，留余量)，
# 真撞上 405 就等 RATE_BACKOFF 秒再重试一次。
API_GAP = 0.30
RATE_BACKOFF = 10.0
_last_req = [0.0]


def _throttle():
    gap = API_GAP - (time.time() - _last_req[0])
    if gap > 0:
        time.sleep(gap)
    _last_req[0] = time.time()


def api_get(s, path, params=None, tries=2):
    """带节流的 GET。
    撞到 405 先等 10 秒重试；还不行就换**匿名会话**再查一次 ——
    实测网易云的 405 是**按账号**算的（带 MUSIC_U 才被锁，不带 cookie 照样能搜），
    而搜索/详情本来就不需要登录，所以切匿名就等于绕过这把锁，
    真正需要登录的只有最后 add_tracks（那一步仍然用带 cookie 的会话）。"""
    if _anon_mode[0]:
        return _raw_get(_anon_session(), path, params)

    last = ""
    for i in range(tries):
        _throttle()
        try:
            r = s.get(op3.API + path, params=params or {}, headers=op3.HEADERS, timeout=15)
            d = r.json()
        except Exception as e:
            last = str(e)
            continue
        if d.get("code") == 405 or "频繁" in str(d.get("message") or d.get("msg") or ""):
            last = "code=405 %s" % (d.get("message") or d.get("msg") or "")
            # 2026-11-21 改：不再原地等 10 秒重试 —— 那把锁是按账号算的，
            # 原地等完照样锁，白等 10 秒；直接切匿名会话（搜索/详情不需要登录）。
            print("     （账号被限流，直接切匿名查）")
            break
        return d

    # 账号被锁：切匿名查（搜索/详情不需要登录）
    try:
        _throttle()
        d = _raw_get(_anon_session(), path, params)
        if not _anon_mode[0]:
            _anon_mode[0] = True
            print("     （搜索被账号限流了，已切匿名查询；加歌仍然用登录态）")
        return d
    except Exception:
        raise RateLimited("网易云接口限流（%s）" % last)


_anon_mode = [False]
_anon_sess = [None]


def _anon_session():
    if _anon_sess[0] is None:
        import requests
        _anon_sess[0] = requests.Session()
    return _anon_sess[0]


def _raw_get(sess, path, params=None):
    r = sess.get(op3.API + path, params=params or {}, headers=op3.HEADERS, timeout=15)
    d = r.json()
    if d.get("code") == 405 or "频繁" in str(d.get("message") or d.get("msg") or ""):
        raise RateLimited("匿名查询也被限流")
    return d


def api_search(s, query, limit=20):
    """op3.search 的替身：能分辨「真没搜到」和「被限流」。
    op3.search 把 {} 里的错误吞了,限流时会静默返回 0 条,看起来像"没这歌"。"""
    d = api_get(s, "/api/search/get", {"s": query, "type": 1, "limit": limit, "offset": 0})
    return (d.get("result") or {}).get("songs") or []


def build_candidates(s, query, want_name, want_artist, limit=20):
    songs = api_search(s, query, limit)
    if not songs:
        return []
    _throttle()
    details = fetch_details(s, [so.get("id") for so in songs[:limit]])
    out = []
    for so in songs:
        sc, why = score_song(so, details.get(so.get("id")), want_name, want_artist)
        out.append({
            "song": so,
            "detail": details.get(so.get("id")) or {},
            "score": sc,
            "why": why,
            "name": so.get("name"),
            "artists": "/".join(a.get("name") or "" for a in (so.get("artists") or [])),
        })
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


def print_candidates(cands, topn=5):
    print("候选评分（按分数从高到低）：")
    for i, c in enumerate(cands[:topn], 1):
        pop = (c["detail"] or {}).get("popularity")
        pop_s = "-" if pop is None else ("%.0f" % pop)
        print("  %d. [%5.1f分] %s - %s  (热度%s, %s)"
              % (i, c["score"], c["name"], c["artists"], pop_s,
                 "%.0fs" % ((c["song"].get("duration") or 0) / 1000)))
    best = cands[0]
    print("  最高分理由：%s" % "；".join(best["why"]))


def pick_playlist(playlists, name):
    name = (name or "").strip()
    exact = [p for p in playlists if (p.get("name") or "") == name]
    if exact:
        return exact[0]
    fuzzy = [p for p in playlists if name and name in (p.get("name") or "")]
    if len(fuzzy) == 1:
        return fuzzy[0]
    if len(fuzzy) > 1:
        print("歌单名「%s」匹配到多个，请写全名：" % name)
        for p in fuzzy:
            print("  - %s (id=%s)" % (p.get("name"), p.get("id")))
        sys.exit(2)
    return None


def node_exe():
    """找 node.exe：先看 PATH，再看常见安装位置（看门狗 pythonw 的 PATH 里可能没有 node）。"""
    import shutil
    for c in (shutil.which("node"), r"D:\Dev\node\node.exe",
              r"C:\Program Files\nodejs\node.exe"):
        if c and os.path.isfile(c):
            return c
    return "node"


def _run_node(script_name, args, timeout=11):
    """跑一个 CDP 小脚本,抓它最后一行 JSON。
    2026-11-21:超时从 90 秒收到 11 秒 —— 脚本内部已经自管预算(找行 5 秒、
    双击校验 4 秒、CDP 单条 6 秒),正常 2-6 秒就结束;11 秒只是兜底,
    卡住时 11 秒直接判失败,不再让人干等一分半。"""
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(here, script_name)
    try:
        r = subprocess.run([node_exe(), script] + list(args),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, creationflags=NOWIN)
        lines = [x for x in (r.stdout or "").strip().splitlines() if x.strip()]
        last = lines[-1] if lines else ""
        try:
            return json.loads(last)
        except Exception:
            return {"ok": False, "err": (last or (r.stderr or "")[:150] or "无输出")}
    except subprocess.TimeoutExpired:
        return {"ok": False, "err": "CDP 超时：%d 秒内没拿到结果" % timeout}
    except Exception as e:
        return {"ok": False, "err": "CDP 执行异常：%s" % e}


def play_song(name, artist="", playlist=""):
    """播放:
    2026-11-21:改成「搜索页优先」。
    歌单页那条路要等虚拟列表懒加载 + 一屏一屏滚,歌单到 100 首时很不稳
    (实测经常"歌单页里没找到这一行",白跑十几秒才回退);
    搜索页点卡片实测 2 秒稳定命中,播完会自动切回歌单页,界面不会停在搜索页。
    歌单页脚本保留作回退(搜索页也没匹配上时才用)。"""
    kw = ("%s %s" % (name, artist)).strip()
    r = _run_node("cm-play-song.js", [kw, name or "", artist or "", playlist or ""], timeout=9)
    if r.get("ok"):
        return r

    reason = r.get("err", "")
    if playlist:
        r2 = _run_node("cm-play-in-playlist.js", [playlist, name or "", artist or ""], timeout=12)
        if r2.get("ok"):
            r2["fallback"] = reason
            return r2
    return r


QUEUE_NAME = "AI队列"
QUEUE_STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "queue_state.json")


def _qstate():
    try:
        with open(QUEUE_STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _qsave(d):
    try:
        with open(QUEUE_STATE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def play_batch_queue(s, csrf, mine, ids, titles, artists, pid, pname):
    """多首：先把这批歌从目标歌单里删掉（有就删、没有也不报错），再反序加回去。

    这等于「全新添加」——绕开了「歌单里已经有的歌再加一次不挪位置」，
    这批歌会以用户点的正序排到歌单最前面。然后双击第一行：
    队列=整张歌单，从这批第一首开始连续播。

    0.17.42（用户口径）：del+add 这套不变 —— 它就是为了不反复读歌单、不吃详情接口的缓存。
    变的是**结论**：按批拿到加歌返回码，`addedIds` 只含真加进去的；
    加失败不再 `return None` 让上层以为全成，也不再把 502 当「已经在里面」。
    """
    del_note = "ok"
    _throttle()
    try:
        op3.del_tracks(s, csrf, pid, ids)   # 接口对不存在的 id 也返回 200
        print("已先把这批歌从「%s」里删掉（有就删，没有照样过）" % pname)
    except Exception as e:
        del_note = repr(e)[:200]
        print("先删这批歌失败（继续加）：%s" % e)

    def add_once():
        _throttle()
        # 批量 add 是「倒序插到最前」，反序传，落下来才是正序、且都在最前面
        return op3.add_tracks_report(s, csrf, pid, list(reversed(ids)))

    rep = add_once()
    if not rep["addedIds"]:
        # del+add 语义下「add 没成功」= 这批没进去；502 多半是删除没生效，重试一次 del+add
        print("✘ 加歌没成功（%s），重试一次 del+add" % ("; ".join(rep["errors"])[:160]))
        try:
            _throttle()
            op3.del_tracks(s, csrf, pid, ids)
        except Exception as e:
            del_note = repr(e)[:200]
            print("重试前的删除也失败：%s" % e)
        rep = add_once()

    added_set = set(int(x) for x in rep["addedIds"])
    if not added_set:
        print("✘ 这批一首都没加进「%s」，不播了。" % pname)
        return {
            "addedIds": [], "failedIds": [int(x) for x in ids],
            "del": del_note, "played": None,
            "playError": "nothing-added", "errors": rep["errors"],
        }

    print("已把 %d/%d 首按顺序排到「%s」最前面" % (len(added_set), len(ids), pname))
    time.sleep(1.5)
    # 从**真的加进去的那批**里取第一首（用户点的正序）—— 分批后有失败时不能固定 titles[0]
    first = next(i for i, x in enumerate(ids) if int(x) in added_set)
    # 把「这批第一首该是什么」传给 play 脚本：它会等歌单第一行真的变成这首再双击，
    # 免得页面还没重绘就双击到旧的第一行（点了 A 放出 B）。
    r = _run_node("cm-play-first.js", [pname, titles[first] if titles else ""], timeout=18)
    if not r.get("ok"):
        print("双击第一行没成功（%s），退回「播放全部」。" % r.get("err"))
        r = op3.play_playlist_cdp(pid, pname)
    played = None
    play_error = ""
    if r.get("ok"):
        print("队列播放：%s" % json.dumps(r, ensure_ascii=False))
        played = {"title": titles[first], "artist": artists[first], "id": ids[first],
                  "mode": "queue", "n": len(added_set), "playing": r.get("playing"),
                  "confirmed": True}
    else:
        play_error = json.dumps(r, ensure_ascii=False)[:200]
        print("✘ 队列播放没成功：%s" % play_error)
    return {
        "addedIds": [int(x) for x in ids if int(x) in added_set],
        "failedIds": [int(x) for x in ids if int(x) not in added_set],
        "del": del_note,
        "played": played,
        "playError": play_error,
        "errors": rep["errors"],
    }


def _spawn_guard(delay=4.0):
    """点歌后开一个独立小进程：几秒后查一次，发现被暂停就点回播放。

    2026-11-21 加。起因：偶尔会出现「歌已经在放，过一会儿又停了」，
    两次现场都没抓到（客户端侧时序问题，脚本这边没有 pause 调用）。
    与其继续找根因，不如兜住结果：只在刚点完歌的那几秒里看一眼，
    本来在播就直接退出，不常驻、不碰平时的播放。
    """
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        script = os.path.join(here, "resume-guard.py")
        if not os.path.exists(script):
            return
        env = dict(os.environ)
        env["NCM_GUARD_DELAY"] = str(delay)
        env["NCM_GUARD_TAG"] = "[点歌后守护]"
        env["NCM_CDP_PORT"] = str(CDP_PORT)
        DETACHED_PROCESS = 0x00000008
        subprocess.Popen(
            [sys.executable, script],
            creationflags=NOWIN | DETACHED_PROCESS,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            close_fds=True,
        )
        print("[守护] 已安排 %d 秒后检查播放状态（被暂停会自动点回）" % int(delay))
    except Exception as e:
        print("[守护] 没起来（不影响点歌）：%r" % (e,))


def rate_limited_exit(pname, msg):
    print("✘ %s" % msg)
    print("  这是网易云那边的频率限制，不是歌名写错了；等几分钟再跑一次即可。")
    print("RESULT_JSON " + json.dumps(
        {"ok": False, "playlist": pname, "added": [], "failed": [],
         "played": None, "error": "rate_limited"}, ensure_ascii=False))
    sys.exit(5)


def read_json_items(src):
    """读 Copilot / DeepSeek 给的 JSON 清单，统一成 [(歌名, 歌手, [备选歌名…], 歌曲id), …]。
    支持三种写法：对象数组、纯字符串数组、{"songs": [...]} 包一层。
    0.17.5：**带上 id** —— 有 id 的条目直接走 id 路线（不搜索、不打分）；没有才按歌名自动判断。"""
    try:
        if src == "-":
            raw = sys.stdin.read()
        else:
            with open(src, encoding="utf-8-sig") as f:
                raw = f.read()
        data = json.loads(raw)
    except Exception as e:
        die("读不了 JSON 清单「%s」：%s" % (src, e))

    if isinstance(data, dict):
        data = data.get("songs") or data.get("items") or data.get("list") or []
    if not isinstance(data, list):
        die("JSON 清单最外层应该是数组，实际是：%s" % type(data).__name__)

    items = []
    for it in data:
        sid = ""
        alt = []
        if isinstance(it, str):
            n, a = it.strip(), ""
        elif isinstance(it, dict):
            n = (it.get("name") or it.get("song") or it.get("title") or "").strip()
            a = (it.get("artist") or it.get("singer") or "").strip()
            # id 的几种叫法都认（我们这边传 id / songId，别处可能传 song_id）
            sid = str(it.get("id") or it.get("songId") or it.get("song_id") or "").strip()
            alt = it.get("alt") or it.get("alternatives") or []
            if isinstance(alt, str):
                alt = [alt]
            alt = [((x.get("name") if isinstance(x, dict) else x) or "").strip() for x in alt]
        else:
            continue
        # 只有 id 没歌名也收下 —— 名字回头从歌曲详情里补
        if n or re.fullmatch(r"\d+", sid or ""):
            items.append((n, a, [x for x in alt if x], sid))
    if not items:
        die("JSON 清单里没有有效歌名或 id")
    return items


def read_list_file(path):
    """txt 清单：一行一首，支持 `歌名`、`歌名|歌手`、`歌名,歌手`、`歌名<Tab>歌手`，# 开头为注释。"""
    items = []
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                t = line.strip()
                if not t or t.startswith("#"):
                    continue
                for sep in ("|", "\t", ","):
                    if sep in t:
                        n, a = t.split(sep, 1)
                        items.append((n.strip(), a.strip()))
                        break
                else:
                    items.append((t, ""))
    except Exception as e:
        die("读不了清单文件「%s」：%s" % (path, e))
    if not items:
        die("清单文件里没有有效行：%s" % path)
    return items


def resolve_one(s, name, artist, pick_n=0, verbose=False):
    """搜一首 + 打分 + 选版本。返回 (歌曲id, 歌名, 歌手)，搜不到返回 None。"""
    m = re.match(r"^\s*id:(\d+)\s*$", name or "")
    if m:
        tid = int(m.group(1))
        print("  · 按 id 取：%s" % tid)
        return tid, "id:%s" % tid, ""

    query = ("%s %s" % (artist, name)).strip() if artist else name
    cands = build_candidates(s, query, name, artist)

    # 语音听错时：搜不到、或最高分不合格（<50），拿账本官方名纠一次重搜
    if (not cands) or (cands and cands[0]["score"] < 50):
        fixed = fuzzy_title(name)
        if fixed:
            good, ratio = fixed
            print("  ↻ 「%s」搜得不对，按账本纠成「%s」（拼音 %.2f），重搜…"
                  % (name, good, ratio))
            q2 = ("%s %s" % (artist, good)).strip() if artist else good
            c2 = build_candidates(s, q2, good, artist)
            if c2 and c2[0]["score"] >= 50:
                cands, query, name = c2, q2, good

    if not cands:
        print("  ✘ 没搜到「%s」" % query)
        return None

    if verbose:
        print_candidates(cands)

    if pick_n:
        if pick_n < 1 or pick_n > len(cands):
            die("--pick 序号越界（1-%d）" % len(cands))
        chosen = cands[pick_n - 1]
    else:
        chosen = cands[0]

    print("  %s%s - %s（%s 分）"
          % ("选中：" if verbose else "✔", chosen["name"], chosen["artists"], chosen["score"]))

    artist_ok = (not artist) or (artist.lower() in (chosen["artists"] or "").lower())
    bad_name = any(w in (chosen["name"] or "").lower() for w in BAD_WORDS)
    if (not artist_ok) or bad_name or chosen["score"] < 50:
        print("    ⚠ 这条看着不是原版（歌手对不上或带版本词），要换版本用 --pick N")
    return chosen["song"]["id"], chosen["name"], chosen["artists"]


def retry_with_fuzzy(s, name, artist, alt, reason):
    """搜不到 / 搜到但不合格时，拿账本官方名重搜一次。"""
    fixed = fuzzy_title(name)
    if not fixed:
        return None
    good, ratio = fixed
    print("     %s，按账本纠成「%s」（拼音相似 %.2f），重搜…" % (reason, good, ratio))
    try:
        return batch_pick(s, good, artist, alt, _no_fix=True)
    except Exception as e:
        print("     重搜出错：%s" % e)
        return None


def batch_pick(s, name, artist, alt=(), _no_fix=False):
    """批量模式专用挑版本：多查询合并 + 质量闸门。
    返回 (id, 歌名, 歌手, 疑点原因或 None)；不合格返回 None（跳过，不乱加）。
    疑点原因用于回传 Copilot——歌加了，但要提醒用户「不是原版」。"""
    alt = list(alt or [])
    queries = []
    if artist:
        queries.append("%s %s" % (artist, name))
    queries.append(name)
    for cn in alt[:3]:
        queries.append(("%s %s" % (artist, cn)).strip() if artist else cn)

    seen, pool, rate = set(), [], 0
    for qi, q in enumerate(queries):
        try:
            cands = build_candidates(s, q, name, artist)
        except RateLimited as e:
            print("     搜「%s」被限流：%s" % (q, e))
            rate += 1
            continue
        except Exception as e:
            print("     搜「%s」出错：%s" % (q, e))
            continue
        for c in cands:
            sid = c["song"].get("id")
            if sid in seen:
                continue
            seen.add(sid)
            pool.append(c)
        # 2026-11-21 加：高分早停。第一遍查询已经搜到很准的版本，就不再搜后面的
        # （后面多是「只搜歌名」这种更宽松的兜底，重搜一遍只是白花 2 次请求）。
        # 但要求歌手对得上——歌手名字对不上时宁可再搜一遍，别拿错人的版本凑数。
        if pool and qi < len(queries) - 1:
            best = max(pool, key=lambda x: x["score"])
            artist_ok = (not artist) or (artist.lower() in (best["artists"] or "").lower())
            if best["score"] >= EARLY_STOP_SCORE and artist_ok:
                print("     （「%s」已搜到 %.0f 分，后面的查询省掉）" % (q, best["score"]))
                break
    if not pool:
        if rate and rate == len(queries):
            # 一条都没搜成功、全是被限流 —— 别报成「没有这首歌」
            raise RateLimited("网易云搜索被限流，等几分钟再试")
        # 语音把歌名听成同音字时，按账本纠一次再搜（只纠一轮，避免反复折腾）
        if not _no_fix:
            return retry_with_fuzzy(s, name, artist, alt, "搜不到「%s」" % name)
        return None

    pool.sort(key=lambda x: x["score"], reverse=True)
    want = {norm(x) for x in ([name] + alt) if norm(x)}

    for c in pool:
        cn = norm(c["name"])
        name_ok = cn in want or any(w and w in cn for w in want)
        if not name_ok or c["score"] < 50:
            continue
        arts = c["artists"] or ""
        suspect = None
        if artist and artist.lower() not in arts.lower():
            suspect = "没找到 %s 的版本，用的是 %s" % (artist, arts)
        if any(w in (c["name"] or "").lower() for w in BAD_WORDS):
            suspect = ("%s；" % suspect if suspect else "") + "版本名：%s" % c["name"]
        return c["song"]["id"], c["name"], c["artists"], suspect

    print("     候选里没有合格版本（最高分 %.0f：%s - %s）"
          % (pool[0]["score"], pool[0]["name"], pool[0]["artists"]))
    if not _no_fix:
        return retry_with_fuzzy(s, name, artist, alt,
                                "候选都不合格（最高 %.0f 分）" % pool[0]["score"])
    return None


def id_of_item(n, a, sid):
    """把「id:123」这种歌名也拆成纯 id —— 手动用法和 AI 传 id 走同一条路线。"""
    if not sid:
        m = re.match(r"^\s*id:(\d+)\s*$", n or "")
        if m:
            return "", a, m.group(1)
    return n, a, sid


def detail_of_id(s, sid):
    """按 id 取歌名/歌手（只读一次详情接口，不搜索）。取不到就回空串，调用方用传进来的名字兜。"""
    try:
        d = fetch_details(s, [int(sid)]) or {}
        so = d.get(int(sid)) or {}
        if so:
            arts = "/".join((x.get("name") or "") for x in (so.get("artists") or []) if x.get("name"))
            return so.get("name") or "", arts
    except Exception:
        pass
    return "", ""


def ensure_sid(s, n, a, alt=(), sid=""):
    """统一入口 —— **只看有没有 id**：
      · 有 id：直接按 id 走（不搜索、不打分、不过质量闸），名字从详情补，补不到用传进来的；
      · 没有 id：按歌名自动判断（搜一次拿 id），之后同样按 id 走。
    返回 (id, 歌名, 歌手, 疑点原因或 None)；拿不到 id 返回 None。
    """
    n, a, sid = id_of_item(n, a, sid)
    if sid and re.fullmatch(r"\d+", sid):
        dt, da = detail_of_id(s, sid)
        t = dt or n or ("id:%s" % sid)
        ar = a or da
        print("  · 直接按 id：%s（%s%s）" % (sid, t, (" - " + ar) if ar else ""))
        return sid, t, ar, None
    if not n:
        return None
    r = batch_pick(s, n, a, alt)
    if r:
        print("  · 没给 id，按歌名判断：%s → id=%s" % (n, r[0]))
    return r


def main():
    argv = sys.argv[1:]
    flags = [a for a in argv if a.startswith("--")]
    # 带值的 flag（--pick / --file）后面那个值不算位置参数，否则会被当成歌名
    val_flags = ("--pick", "--file", "--json", "--fav-at")
    skip = set()
    for i, a in enumerate(argv):
        if a in val_flags and i + 1 < len(argv):
            skip.add(argv[i + 1])
    args = [a for a in argv if not a.startswith("--") and a not in skip]

    # 进「我喜欢的音乐」：--no-fav 关掉整件事；--fav-at N 改阈值（默认第 2 次）
    no_fav = "--no-fav" in flags
    fav_at = 2
    if "--fav-at" in flags:
        try:
            fav_at = max(2, int(argv[argv.index("--fav-at") + 1]))
        except Exception:
            fav_at = 2

    if not argv or "--help" in flags or "-h" in argv:
        print(__doc__)
        return

    if "--open" in flags or "--port" in flags:
        state = ensure_client(allow_restart=("--no-restart" not in flags))
        print("[客户端] %s" % state)
        ok = bool(port_open())
        print("9229 %s" % ("通" if ok else "不通"))
        sys.exit(0 if ok else 3)

    print("[客户端] %s" % ensure_client(allow_restart=("--no-restart" not in flags)))

    try:
        s, csrf = op3.session()
    except Exception as e:
        die("连不上客户端或抓不到 cookie：%s\n（确认网易云客户端在运行，且带 --remote-debugging-port=9229 启动）" % e, 3)

    _, mine = op3.my_playlists(s)

    if "--list" in flags or (args and args[0] == "--list"):
        uid, nick = op3.me(s)
        print("账号：%s（uid=%s）共 %d 个歌单：" % (nick, uid, len(mine)))
        for p in mine:
            print("  - %s  (id=%s, %s 首)" % (p.get("name"), p.get("id"), p.get("trackCount")))
        return

    file_path = argv[argv.index("--file") + 1] if "--file" in flags else None
    json_src = argv[argv.index("--json") + 1] if "--json" in flags else None

    if file_path or json_src:
        # --file / --json 模式：位置参数只有歌单名
        song = ""
        playlist_name = args[0] if args else ""
        artist = ""
    else:
        song = args[0] if args else ""
        playlist_name = args[1] if len(args) > 1 else ""
        artist = args[2] if len(args) > 2 else ""
    show_only = "--cand" in flags
    skip_play = "--no-play" in flags
    # --auto：AI 自己挑的歌（不是老大那时想听的）→ 照常播，但不记进点歌次数
    auto_mode = "--auto" in flags
    pick_n = 0
    if "--pick" in flags:
        try:
            pick_n = int(argv[argv.index("--pick") + 1])
        except Exception:
            die("--pick 后面要跟序号")

    if not playlist_name:
        die("请给出歌单名。可用 --list 查看")

    pl = pick_playlist(mine, playlist_name)
    if not pl:
        print("没找到歌单「%s」。现有歌单：" % playlist_name)
        for p in mine:
            print("  - %s" % p.get("name"))
        sys.exit(2)
    pid, pname = pl.get("id"), pl.get("name")

    # ---------- 组装待处理的清单（统一成 (歌名, 歌手, 备选列表, 歌曲id)） ----------
    if json_src:
        raw_items = read_json_items(json_src)
        items = raw_items
        print("JSON 清单共 %d 首（来源：%s）" % (len(items), "标准输入" if json_src == "-" else json_src))
    elif file_path:
        raw_items = read_list_file(file_path)
        items = [(n, a, [], "") for (n, a) in raw_items]
        print("清单文件「%s」共 %d 行" % (file_path, len(items)))
    else:
        if not song:
            die("至少要给个歌名（或者用 --file / --json 给清单）")
        parts = [p.strip() for p in re.split(r"[+;；]", song) if p.strip()]
        items = []
        for p in parts:
            if "|" in p:
                n, a = p.split("|", 1)
                items.append((n.strip(), a.strip(), [], ""))
            else:
                items.append((p, artist, [], ""))

    if not items:
        die("没有可处理的歌名")

    total = len(items)
    if total == 1:
        n0, a0, alt0, sid0 = items[0]
        if json_src or file_path:
            # 单首走 JSON/清单也统一：有 id 就直接用 id，没 id 才自动判断
            try:
                r = ensure_sid(s, n0, a0, alt0, sid0)
            except RateLimited as e:
                rate_limited_exit(pname or playlist_name, e)
            if not r:
                print("✘ 拿不到《%s》的 id，什么都没做。" % (n0 or sid0))
                print("RESULT_JSON " + json.dumps(
                    {"ok": False, "mode": "dry-run" if "--dry-run" in flags else "apply",
                     "playlist": pname,
                     "added": [], "failed": [{"name": n0, "artist": a0,
                                              "reason": "拿不到歌曲 id"}],
                     "played": None}, ensure_ascii=False))
                sys.exit(4)
            sid, t, ar, suspect = r
            if suspect:
                print("   ⚠ %s" % suspect)
            ids = [sid]
            titles = [t]
            artists = [ar]
            ok_items = [(n0, a0, sid, t, ar, suspect)]
            failed = []
        else:
            # 老的手动单曲用法:保持原样(会给「看着不是原版」的提示,由人决定)
            r = resolve_one(s, n0, a0, pick_n, verbose=True)
            if not r and alt0:
                for cand in alt0[:3]:
                    print("  主结果没搜到，试备选「%s」…" % cand)
                    r = resolve_one(s, cand, a0, 0, verbose=False)
                    if r:
                        break
            if not r:
                die("没搜到「%s」" % n0)
            ids = [r[0]]
            titles = [r[1]]
            artists = [r[2]]
            ok_items = [(n0, a0, r[0], r[1], r[2], None)]
            failed = []
    else:
        print("批量模式：共 %d 首（有 id 直接按 id，没 id 才搜歌名）…" % total)
        ids, titles, artists = [], [], []
        ok_items, failed = [], []
        for i, (n, a, alt, sid0) in enumerate(items, 1):
            print("[%d/%d] %s%s%s" % (i, total, n or ("id:%s" % sid0), (" - " + a) if a else "",
                                      ("  (id=%s)" % sid0) if sid0 else ""))
            try:
                r = ensure_sid(s, n, a, alt, sid0)
            except RateLimited as e:
                rate_limited_exit(pname or playlist_name, e)
            if not r:
                print("   ✘ 跳过：拿不到「%s」的 id" % (n or sid0))
                failed.append({"name": n, "artist": a, "reason": "拿不到歌曲 id"})
                continue
            sid, t, ar, suspect = r
            ids.append(sid)
            titles.append(t)
            artists.append(ar)
            ok_items.append((n, a, sid, t, ar, suspect))
            if suspect:
                print("   ⚠ %s" % suspect)
        if not ids:
            print("一首都没搜到，什么都没做。")
            print("RESULT_JSON " + json.dumps(
                {"ok": False, "mode": "apply", "playlist": pname, "error": "没搜到合格的歌",
                 "counts": {"requested": len(failed), "resolved": 0, "added": 0,
                            "addFailed": 0, "resolveFailed": len(failed), "played": 0},
                 "items": [{"request": f["name"], "artist": f["artist"], "id": "", "title": "",
                            "status": "resolve-failed", "reason": f["reason"]} for f in failed],
                 "added": [], "addFailed": [], "failed": failed, "played": None,
                 "errors": [{"stage": "resolve", "message": "全部没搜到 id"}]},
                ensure_ascii=False))
            sys.exit(4)

    if show_only:
        print("（--cand 只打分，不添加不播放）")
        return

    playlist_for_result = pname or playlist_name

    if "--dry-run" in flags:
        print("（--dry-run 预演：有 id 直接解析 id，没 id 才搜歌；不写歌单、不播放）")
        for x in ok_items:
            print("  ✓ %s%s →《%s》- %s (id=%s)%s"
                  % (x[0], (" / " + x[1]) if x[1] else "", x[3], x[4] or "?", x[2],
                     ("  ⚠ " + x[5]) if x[5] else ""))
        for f in failed:
            print("  ✘ %s（%s）" % (f["name"], f["reason"]))
        print("RESULT_JSON " + json.dumps(
            {"ok": bool(ok_items), "partial": bool(failed) and bool(ok_items),
             "mode": "dry-run", "playlist": playlist_for_result,
             "error": "" if ok_items else "没搜到合格的歌",
             "counts": {"requested": len(ok_items) + len(failed), "resolved": len(ok_items),
                        "added": 0, "addFailed": 0, "resolveFailed": len(failed), "played": 0},
             "addedCount": len(ok_items), "failedCount": len(failed),
             "resolved": [{"request": x[0], "artist": x[1], "id": x[2], "title": x[3],
                           "matched_artist": x[4], "suspect": x[5]} for x in ok_items],
             "failed": failed, "played": None}, ensure_ascii=False))
        return

    # 加歌：--no-play（只加不播）时在这里加；要播的话，整批交给 play_batch_queue 的
    # 「先删后加」统一处理，否则同一批会被加两遍。
    played = None
    ledger = None
    added_ids = list(ids)     # --no-play：不删，502 仍算「本来就在」
    add_errors = []
    del_note = "skip"         # --no-play 不删
    play_error = ""
    if skip_play:
        try:
            _throttle()
            r = op3.add_tracks(s, csrf, pid, ids)
        except Exception as e:
            die("加歌失败：%s" % e, 2)

        code = r.get("code")
        if code == 502 or "重复" in str(r.get("message", "")):
            print("这些歌都已在歌单「%s」里了，跳过添加。" % pname)
        else:
            print("已加入歌单「%s」：%d 首（id=%s）"
                  % (pname, len(ids), ",".join(str(i) for i in ids)))
        print("（--no-play 只加不播，不记账）")
    else:
        # 2026-11-21：1 首、10 首、100 首，全走同一套 —— 不再区分数量
        # 0.17.42：返回值从 None 改成结构体 —— 加成功几首、卡在哪一步都能看见
        q = play_batch_queue(s, csrf, mine, ids, titles, artists, pid, pname)
        added_ids = q["addedIds"]
        del_note = q["del"]
        add_errors = q["errors"]
        played = q["played"]
        play_error = q.get("playError") or ""
        if played:
            _spawn_guard(4.0)
            state = op3.status()
            print("当前状态：%s" % (state or "(读不到)"))
            if auto_mode:
                # AI 自己挑的歌：不是老大当时想听的，只播不记账
                print("（--auto：AI 自己挑的，只播不记账）")
            else:
                # 记账：只记**真的加进歌单**的那几首；第 2 次起自动进「我喜欢的音乐」
                added_set0 = set(int(x) for x in added_ids)
                rec_items = [(x[2], x[3], x[4]) for x in ok_items if int(x[2]) in added_set0]
                if rec_items:
                    try:
                        import pick_ledger
                        ledger = pick_ledger.record(s, csrf, rec_items,
                                                    fav_at=fav_at, auto_fav=not no_fav)
                        line = pick_ledger.summary(ledger)
                        if line:
                            print(line)
                    except Exception as e:
                        print("[记账] 跳过：%r" % (e,))
        elif play_error:
            print("（%d 首已加进歌单，但没放起来）" % len(added_ids))

    # 机器可读结果（Copilot / 看门狗直接抓这一行）
    # 0.17.42（用户口径）：del+add 不变；结论按「真的加进去几首」算，不再拿解析数冒充。
    #   ok      = added > 0
    #   partial = 有加进去的，也有失败的（解析失败或加歌失败）
    #   counts  = requested / resolved / added / addFailed / resolveFailed / played
    added_set = set(int(x) for x in added_ids)
    items_out = []
    add_failed = []
    for x in ok_items:
        hit = int(x[2]) in added_set
        items_out.append({
            "request": x[0], "artist": x[1], "id": x[2], "title": x[3],
            "matched_artist": x[4], "suspect": x[5],
            "status": "added" if hit else "add-failed",
            "reason": "" if hit else "加歌接口没成功",
        })
        if not hit:
            add_failed.append({"name": x[0], "artist": x[1], "id": x[2],
                               "reason": "加歌接口没成功"})
    for f in failed:
        items_out.append({"request": f["name"], "artist": f["artist"], "id": "",
                          "title": "", "status": "resolve-failed", "reason": f["reason"]})

    n_added = len(added_set)
    n_resolved = len(ok_items)
    ok_any = n_added > 0
    errs = []
    if del_note not in ("ok", "skip"):
        errs.append({"stage": "del", "message": str(del_note)})
    for e in add_errors:
        errs.append({"stage": "add", "message": str(e)})
    if play_error:
        errs.append({"stage": "play", "message": str(play_error)})
    if ok_any:
        error_top = ""
    elif n_resolved:
        error_top = "加歌失败"
    else:
        error_top = "没搜到合格的歌"

    print("RESULT_JSON " + json.dumps(
        {"ok": ok_any, "partial": ok_any and bool(add_failed or failed),
         "mode": "apply", "playlist": playlist_for_result,
         "error": error_top,
         "counts": {"requested": n_resolved + len(failed),
                    "resolved": n_resolved, "added": n_added,
                    "addFailed": len(add_failed), "resolveFailed": len(failed),
                    "played": 1 if played else 0},
         "items": items_out,
         # 兼容老消费方：added 现在是「真的加进去的」，failed 仍是「没搜到 id 的」
         "added": [{"request": x[0], "artist": x[1], "id": x[2], "title": x[3],
                    "matched_artist": x[4], "suspect": x[5]}
                   for x in ok_items if int(x[2]) in added_set],
         "addFailed": add_failed,
         "failed": failed, "played": played,
         "errors": errs,
         "ledger": (None if not ledger else {
             "counts": {str(b[0]): b[3] for b in ledger.get("bumped") or []},
             "fav_added": ledger.get("fav_added") or [],
             "fav_err": ledger.get("fav_err") or ""})}, ensure_ascii=False))


if __name__ == "__main__":
    main()
