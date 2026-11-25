# -*- coding: utf-8 -*-
"""列出当前账号的歌单，供面板「默认歌单」下拉和按 ID 点歌用。

输出最后一行 RESULT_JSON：
    {"ok": true, "uid": 12623867, "playlists": [{"id": 18589684156, "name": "小菱的歌单", "count": 159}, ...]}

前提：网易云客户端开着，CDP 端口（NCM_CDP_PORT，默认 9229）能通。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import op3


def main():
    try:
        s, _csrf = op3.session()
        uid, mine = op3.my_playlists(s)
        out = []
        for p in mine:
            try:
                out.append({
                    "id": int(p.get("id")),
                    "name": p.get("name") or "",
                    "count": int(p.get("trackCount") or 0),
                })
            except (TypeError, ValueError):
                continue
        print("RESULT_JSON " + json.dumps(
            {"ok": True, "uid": uid, "playlists": out}, ensure_ascii=False))
    except Exception as e:
        print("RESULT_JSON " + json.dumps(
            {"ok": False, "error": repr(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
