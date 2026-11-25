# -*- coding: utf-8 -*-
"""往「我喜欢的音乐」里加歌 / 撤歌 / 看状态(2026-11-13 05:32 实测通)。

    python ncm_fav.py add 569200213 "平凡之路 朴树"   # 按 ID 或关键词加(自动搜原唱)
    python ncm_fav.py del 569200213
    python ncm_fav.py list [前N首]                    # 默认列前 5 首
    python ncm_fav.py has 569200213

「我喜欢的音乐」= pid 10685056(uid 12623867 的那个,-爱菱-喜欢的音乐)。
接口:POST /api/playlist/manipulate/tracks(op=add/del) —— 明文就能用,不需要 Crypto。
页面上点红心(cmd-icon-likenumber)也行,效果一样;接口这条路的好处是不动界面、不抢窗口。
"""
import json
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

import op3

FAV_PID = 10685056


def fav_detail(s):
    r = s.get(op3.API + "/api/v6/playlist/detail",
              params={"id": FAV_PID, "n": 5000}, headers=op3.HEADERS, timeout=20)
    pl = r.json().get("playlist") or {}
    tracks = pl.get("tracks") or []
    return pl.get("trackCount"), tracks


def resolve_any(s, item):
    """ID 或关键词 → (id, 名字-歌手)。关键词优先挑第一个歌手名沾边的结果。"""
    if item.isdigit():
        r = s.post(op3.API + "/api/v3/song/detail",
                   data={"c": json.dumps([{"id": int(item)}])}, headers=op3.HEADERS, timeout=15)
        so = (r.json().get("songs") or [None])[0]
        if not so:
            print("反查不到 ID %s" % item)
            return None
        return int(item), "%s - %s" % (so.get("name"), " ".join(a.get("name", "") for a in (so.get("ar") or [])))
    found = op3.search(s, item, limit=8) or []
    if not found:
        print("搜不到: %s" % item)
        return None
    want = [w for w in item.split() if not w.isdigit()]
    pick = found[0]
    if want:
        for so in found:
            arts = " ".join(a.get("name", "") for a in (so.get("artists") or []))
            if want[-1] in arts:
                pick = so
                break
    return int(pick["id"]), "%s - %s" % (pick.get("name"), " ".join(a.get("name", "") for a in (pick.get("artists") or [])))


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return
    cmd, rest = a[0], a[1:]
    s, csrf = op3.session()
    if cmd == "list":
        n = int(rest[0]) if rest else 5
        cnt, tracks = fav_detail(s)
        print("我喜欢的音乐:%s 首,pid=%s" % (cnt, FAV_PID))
        for t in tracks[:n]:
            print("  %s 《%s》 - %s" % (t.get("id"), t.get("name"), " ".join(x.get("name", "") for x in (t.get("ar") or []))))
        return
    if cmd == "has":
        cnt, tracks = fav_detail(s)
        ids = [t.get("id") for t in tracks]
        for item in rest:
            sid, label = resolve_any(s, item)
            print("%s %s %s" % ("有" if sid in ids else "没有", sid, label))
        return
    if cmd not in ("add", "del"):
        print(__doc__)
        return
    cnt0, tracks = fav_detail(s)
    ids0 = [t.get("id") for t in tracks]
    targets = []
    for item in rest:
        r = resolve_any(s, item)
        if r:
            targets.append(r)
    if not targets:
        print("没有可处理的歌")
        return
    tids = [t[0] for t in targets if (t[0] not in ids0 if cmd == "add" else t[0] in ids0)]
    print("要%s %d 首:%s" % ("加" if cmd == "add" else "撤", len(tids),
                             ", ".join("%s(%s)" % (t[1], t[0]) for t in targets)))
    if not tids:
        print("状态本来就对,不动")
        return
    r = s.post(op3.API + "/api/playlist/manipulate/tracks",
               data={"op": cmd, "pid": FAV_PID, "trackIds": json.dumps(tids),
                     "imme": "true", "csrf_token": csrf}, headers=op3.HEADERS, timeout=20)
    print("接口: " + r.text[:160])
    cnt1, _ = fav_detail(s)
    print("我喜欢的音乐:%s → %s 首" % (cnt0, cnt1))


if __name__ == "__main__":
    main()
