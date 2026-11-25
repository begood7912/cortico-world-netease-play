# -*- coding: utf-8 -*-
"""点歌记账（2026-11-21 新增）

规矩（老大 2026-11-13 定，2026-11-21 重申）：
    同一首歌被「明确点」到第 2 次，自动加进「我喜欢的音乐」（pid 10685056）。
    只有真点了歌、走播放流程才算一次；
    没点的话（AI 自己批量备货、--no-play、自动补歌）不记账。

两份账本，各管一头：
    notes/点歌次数.json  —— 机器读，按歌曲 id 累加 count（唯一键是 id，不会把
                            《山丘》《越过山丘》《山丘 Live》混成一首）
    notes/点歌记录.md    —— 人看，点一次补一行流水

用法（addplay.py 内部调用，也可单独试）：
    import pick_ledger
    r = pick_ledger.record(s, csrf, [(26598946, "山丘", "李宗盛")])
    # r = {"bumped": [(id, name, artist, count), ...],
    #      "fav_added": [id...], "fav_skip": [id...], "fav_err": "..."}
"""
import json
import os
import sys
import time

WORK = os.environ.get("NCM_WORK_DIR") or r"D:\Programs\Coopanion\data\home\companion\workspace"
TOOLS = os.path.join(WORK, "run", "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

# 三个账本就放在 workspace\notes 下 —— 记忆地图的「文件」页会扫这个目录，
# 翻的时候直接能看到点歌记录.md / 点歌计数.md。别往 memory-core 的数据目录里塞。
LEDGER = os.path.join(WORK, "notes", "点歌次数.json")
PICKLOG = os.path.join(WORK, "notes", "点歌记录.md")
# 给人翻的汇总看板：整份重写，永远是最新的（文件小，重写安全）
BOARD = os.path.join(WORK, "notes", "点歌计数.md")
FAV_PID = 10685056


# ---------- 账本读写 ----------

def _load():
    try:
        with open(LEDGER, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        d = {}
    if not isinstance(d.get("songs"), dict):
        d["songs"] = {}
    return d


def _save(d):
    d["updated"] = time.strftime("%Y-%m-%d %H:%M")
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, LEDGER)   # 写一半崩了也不会把账本弄坏


def _append_log(sid, name, artist, count):
    """往 notes/点歌记录.md 尾巴上补一行。"""
    try:
        if not os.path.exists(PICKLOG):
            os.makedirs(os.path.dirname(PICKLOG), exist_ok=True)
            with open(PICKLOG, "w", encoding="utf-8") as f:
                f.write("# 点过的歌\n\n"
                        "> 机器读的次数本子是 `notes/点歌次数.json`，这个是给人看的流水。\n\n"
                        "| 时间 | 第几次 | 歌 |\n|---|---|---|\n")
        with open(PICKLOG, "a", encoding="utf-8") as f:
            f.write("| %s | %d | %s《%s》- %s(%s) |\n"
                    % (time.strftime("%Y-%m-%d %H:%M"), count,
                       "**第二次** " if count >= 2 else "", name, artist, sid))
    except Exception as e:
        print("[点歌记录] 没写成: %r" % (e,))


def _write_board(led):
    """把「点歌计数.md」整份重写成最新看板，方便人直接翻。"""
    try:
        songs = led.get("songs") or {}
        rows = []
        for sid, rec in songs.items():
            rows.append((int(rec.get("count", 0)) or 0,
                         rec.get("last", "") or "",
                         rec.get("name", "") or "",
                         rec.get("artist", "") or "",
                         str(sid)))
        # 先按时间倒序，再按次数倒序（稳定排序，同次数时新的在上）
        rows.sort(key=lambda r: r[1], reverse=True)
        rows.sort(key=lambda r: r[0], reverse=True)

        two = [r for r in rows if r[0] >= 2]
        body = [
            "# 点歌计数",
            "",
            "> 这个文件由 `pick_ledger.py` 自动整份重写，**别手改**，改了下次会被覆盖。",
            "> 机器账本是 `notes/点歌次数.json`；点歌流水在 `notes/点歌记录.md`。",
            "> 最后更新：%s ｜ 共 %d 首 ｜ 点过 2 次及以上 %d 首"
            % (time.strftime("%Y-%m-%d %H:%M"), len(rows), len(two)),
            "",
            "## 点过 2 次及以上（会自动进「我喜欢的音乐」）",
            "",
        ]
        if two:
            body.append("| 歌 | 歌手 | 次数 | 最后一次 |")
            body.append("|---|---|---|---|")
            for cnt, last, name, artist, sid in two[:60]:
                body.append("| %s | %s | **%d** | %s |" % (name, artist, cnt, last[5:16]))
            if len(two) > 60:
                body.append("| …还有 %d 首 | | | |" % (len(two) - 60))
        else:
            body.append("（还没有点过两次的歌）")

        body += ["", "## 全部（按次数、时间排）", ""]
        body.append("| 歌 | 歌手 | 次数 | 最后一次 | id |")
        body.append("|---|---|---|---|---|")
        for cnt, last, name, artist, sid in rows[:120]:
            body.append("| %s | %s | %d | %s | %s |" % (name, artist, cnt, last[5:16], sid))
        if len(rows) > 120:
            body.append("| …还有 %d 首，去 `点歌次数.json` 里翻 | | | | |" % (len(rows) - 120))
        body.append("")

        os.makedirs(os.path.dirname(BOARD), exist_ok=True)
        tmp = BOARD + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(body))
        os.replace(tmp, BOARD)
    except Exception as e:
        print("[点歌计数] 没写成: %r" % (e,))


# ---------- 「我喜欢的音乐」 ----------
def _fav_ids(s):
    """返回已在我喜欢里的 id 集合；查不到时返回 None（此时宁可不加）。"""
    try:
        import ncm_fav
        _, tracks = ncm_fav.fav_detail(s)
        return {int(t.get("id")) for t in tracks if t.get("id")}
    except Exception:
        return None


def _fav_add(s, csrf, sid_list):
    """批量加进「我喜欢的音乐」，一次请求搞定。"""
    import op3
    r = s.post(op3.API + "/api/playlist/manipulate/tracks",
               data={"op": "add", "pid": FAV_PID,
                     "trackIds": json.dumps([int(x) for x in sid_list]),
                     "imme": "true", "csrf_token": csrf},
               headers=op3.HEADERS, timeout=20)
    return r.text[:160]


# ---------- 主入口 ----------

def record(s, csrf, entries, fav_at=2, auto_fav=True):
    """entries = [(song_id, name, artist), ...]，一批可以是 1 首也可以是 100 首。

    fav_at：累计到第几次自动进「我喜欢的音乐」，默认 2。
    auto_fav：False 时只记账、完全不动「我喜欢的音乐」。
    只该在「用户明确点歌」时调用（addplay.py 里是播放成功之后）。
    返回 dict，方便调用方打印。
    """
    entries = [e for e in (entries or []) if e and e[0]]
    # 0.17.41（用户口径）：账本的 key 必须是全数字的歌曲 id（来源一定是数字）。
    # 非数字的条目一律不收，也不抛异常 —— 以前 `str(int(sid))` 会在 record_pick 那条
    # 后退路里抛 ValueError，而那个进程是 stdio:ignore 起的，等于静默丢一次记账。
    dropped = [e for e in entries if not str(e[0]).isdigit()]
    entries = [e for e in entries if str(e[0]).isdigit()]
    if not entries:
        return {"dropped": dropped}

    led = _load()
    now = time.strftime("%Y-%m-%d %H:%M")
    bumped = []

    for sid, name, artist in entries:
        key = str(sid)
        rec = led["songs"].get(key) or {"name": name, "artist": artist, "count": 0}
        rec["count"] = int(rec.get("count", 0)) + 1
        rec["name"] = name or rec.get("name", "")
        rec["artist"] = artist or rec.get("artist", "")
        rec["last"] = now
        led["songs"][key] = rec
        bumped.append((int(sid), rec["name"], rec["artist"], rec["count"]))

    _save(led)
    for row in bumped:
        _append_log(*row)
    _write_board(led)

    # 第 2 次及以上的，看是否已在我喜欢的音乐里
    result = {"bumped": bumped, "fav_added": [], "fav_skip": [], "fav_err": "",
              "fav_at": fav_at, "fav_off": not auto_fav, "dropped": dropped}
    cand = [b[0] for b in bumped if b[3] >= fav_at] if auto_fav else []
    if not cand:
        return result

    have = _fav_ids(s)
    if have is None:
        result["fav_err"] = "读不到「我喜欢的音乐」列表，这次没动"
        return result

    todo = [i for i in cand if i not in have]
    result["fav_skip"] = [i for i in cand if i in have]
    if not todo:
        return result

    try:
        msg = _fav_add(s, csrf, todo)
        result["fav_added"] = todo
        result["fav_msg"] = msg
    except Exception as e:
        result["fav_err"] = "%r" % (e,)
    return result


def summary(r):
    """把 record() 的结果变成一句给人看的话。"""
    if not r:
        return ""
    if not r.get("bumped"):
        # 0.17.41：只剩「没有数字 id」的条目 —— 如实说没记，别打印「记账完成」
        if r.get("dropped"):
            return "没记账：%d 条没有数字 id" % len(r["dropped"])
        return ""
    n = len(r["bumped"])
    two = [b for b in r["bumped"] if b[3] >= 2]
    s = "记账：%d 首（%s）" % (n, "，".join("《%s》第 %d 次" % (b[1], b[3]) for b in r["bumped"][:5])
                            + ("…" if n > 5 else ""))
    if two:
        s += "\n  其中第 2 次及以上的 %d 首：" % len(two)
        if r.get("fav_added"):
            s += "已加进「我喜欢的音乐」%d 首；" % len(r["fav_added"])
        if r.get("fav_skip"):
            s += "本来就在里面 %d 首；" % len(r["fav_skip"])
        if r.get("fav_err"):
            s += "出错了 %s" % r["fav_err"]
        s = s.rstrip("；")
    if r.get("dropped"):
        s += "\n  （%d 条没有数字 id，没记账）" % len(r["dropped"])
    return s


if __name__ == "__main__":
    # 手测：python pick_ledger.py <歌曲id> [歌名] [歌手]
    #       python pick_ledger.py --board        # 只按现有账本重建看板，不记账
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(0)
    if a[0] == "--board":
        led = _load()
        _write_board(led)
        print("已重建 %s（%d 首）" % (BOARD, len(led.get("songs") or {})))
        sys.exit(0)
    import op3
    sess, csrf = op3.session()
    r = record(sess, csrf, [(int(a[0]), a[1] if len(a) > 1 else "", a[2] if len(a) > 2 else "")])
    print(summary(r) or "(没记)")
    print(json.dumps(r, ensure_ascii=False)[:400])
