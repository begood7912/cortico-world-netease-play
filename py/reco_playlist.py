# -*- coding: utf-8 -*-
"""「AI 推荐歌单」的增删查（0.16.58 接力点歌用）。

为什么单独一个脚本：`op3.py` 里已经有抓 cookie、建歌单、加歌、删歌、读歌单全部曲目 id 的实现，
这里只是把它们拼成接力点歌要的三个动作，不再复制一遍 cookie/CDP 那套。

调用方式（跟其它 py 脚本一致：参数走 base64 JSON，最后一行 RESULT_JSON）：
    python reco_playlist.py <base64>
    JSON: {"action":"list"}                    看账号里叫这个名字的歌单有没有
          {"action":"ensure","name":"AI 推荐歌单"}  有就返回、没有就建一个
          {"action":"add","name":"...","songs":[{"name","artist","id"}]}  把歌加进去（没有就先建）
          {"action":"clear","name":"..."}      把歌单里现有歌全部删掉

输出一律 {"ok":bool, ..., "error":"..."}，最后一行打 RESULT_JSON。
"""
import base64
import json
import sys
import traceback

import op3

DEFAULT_NAME = "AI 推荐歌单"


def find_playlist(s, name):
    """按名字在「我创建的歌单」里找，找不到返回 None。同名有多张就取第一张。"""
    _uid, pls = op3.my_playlists(s)
    for pl in pls:
        if str(pl.get("name") or "").strip() == name:
            return {"id": int(pl.get("id")), "name": name, "count": int(pl.get("trackCount") or 0)}
    return None


def ensure(s, csrf, name):
    """有就返回 id；没有就新建。返回 (info, created)。"""
    hit = find_playlist(s, name)
    if hit:
        return hit, False
    pid = op3.create(s, csrf, name)
    return {"id": int(pid), "name": name, "count": 0}, True


def resolve_ids(s, songs):
    """把 [{name,artist,id}] 换成网易云曲目 id。给了纯数字 id 就直接用，否则搜一次。"""
    out = []
    ids = []
    for it in songs or []:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()
        artist = str(it.get("artist") or "").strip()
        sid = str(it.get("id") or "").strip()
        if sid.isdigit():
            out.append({"name": name, "artist": artist, "id": sid, "how": "id"})
            ids.append(sid)
            continue
        if not name:
            continue
        query = ("%s %s" % (name, artist)).strip()
        try:
            cands = op3.search(s, query, limit=10)
        except Exception:
            cands = []
        best = None
        try:
            best = op3.pick(cands, query)
        except Exception:
            best = cands[0] if cands else None
        if not best:
            out.append({"name": name, "artist": artist, "id": "", "how": "miss"})
            continue
        got = str((best.get("id") or best.get("trackId") or "")).strip()
        out.append({"name": name, "artist": artist, "id": got, "how": "search"})
        if got.isdigit():
            ids.append(got)
    return out, ids


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        arg = json.loads(base64.b64decode(raw).decode("utf-8")) if raw else {}
    except Exception:
        arg = {}
    if not isinstance(arg, dict):
        arg = {}
    action = str(arg.get("action") or "ensure")
    name = str(arg.get("name") or DEFAULT_NAME).strip() or DEFAULT_NAME

    try:
        s, csrf = op3.session()
        if action == "list":
            hit = find_playlist(s, name)
            print("RESULT_JSON " + json.dumps({"ok": True, "found": bool(hit), "playlist": hit}, ensure_ascii=False))
            return

        info, created = ensure(s, csrf, name)

        if action == "ensure":
            print("RESULT_JSON " + json.dumps(
                {"ok": True, "playlist": info, "created": created}, ensure_ascii=False))
            return

        if action == "add":
            rows, ids = resolve_ids(s, arg.get("songs"))
            added = 0
            if ids:
                op3.add_tracks(s, csrf, info["id"], ids)
                added = len(ids)
            print("RESULT_JSON " + json.dumps(
                {"ok": True, "playlist": info, "created": created, "added": added, "rows": rows},
                ensure_ascii=False))
            return

        if action == "clear":
            before = op3.playlist_track_ids(s, info["id"])
            removed = 0
            if before:
                # 一次删太多会被拒，按 100 一批
                for i in range(0, len(before), 100):
                    chunk = before[i:i + 100]
                    op3.del_tracks(s, csrf, info["id"], chunk)
                    removed += len(chunk)
            print("RESULT_JSON " + json.dumps(
                {"ok": True, "playlist": info, "created": created, "removed": removed},
                ensure_ascii=False))
            return

        print("RESULT_JSON " + json.dumps({"ok": False, "error": "未知 action: %s" % action}, ensure_ascii=False))
    except Exception as e:
        print("RESULT_JSON " + json.dumps(
            {"ok": False, "error": str(e)[:300], "trace": traceback.format_exc()[-400:]},
            ensure_ascii=False))


if __name__ == "__main__":
    main()
