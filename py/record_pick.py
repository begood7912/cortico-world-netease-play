#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""快路径点播之后补记一次「点歌次数」。

addplay.py 是在播放成功后自己记账的；快路径没走它，所以由这里补上。
只记账、不动「我喜欢的音乐」（auto_fav=False，那条已经按用户要求关掉了）。

用法: python record_pick.py '{"songId":"123","name":"永夜","artist":"谭维维"}'

0.17.41（用户口径）：「必须是全数字才算成功，因为来源一定是数字」。
所以这条链路只认歌曲 id：
  · 有 songId 且是数字 → 直接记；
  · 没有 songId → 在账本里按「歌名 + 歌手」找已有的数字 id 复用；
  · 还找不到 → **不记**，写一行 external.log 说清原因，然后正常退出。
以前这里会拿中文歌名当 key，而 pick_ledger.record() 里是 `str(int(sid))`，
于是抛 ValueError 被 stdio:ignore 吞掉 —— 账本静默少记一次，查都没法查。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import pick_ledger
except Exception as e:  # 账本模块坏了不该影响播放
    print("IMPORT_FAIL %r" % (e,))
    sys.exit(0)


def _log_external(why, name, artist, sid):
    """快路径是 detached + stdio:ignore 起的，stdout 没人看 —— 失败必须落盘。"""
    try:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        log_dir = os.path.join(root, "data", "log")
        os.makedirs(log_dir, exist_ok=True)
        row = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "endpoint": "proc",
            "action": "recordPick",
            "ok": False,
            "why": why,
            "name": name,
            "artist": artist,
            "songId": sid,
        }
        with open(os.path.join(log_dir, "external.log"), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def main():
    try:
        payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    except Exception:
        payload = {}
    name = (payload.get("name") or "").strip()
    artist = (payload.get("artist") or "").strip()
    sid = str(payload.get("songId") or "").strip()
    if not name:
        sys.exit(0)

    # 只认全数字的歌曲 id；空串 / 非数字一律当「没有 id」
    key = sid if sid.isdigit() else ""
    if not key:
        # 账本里找同名（+同歌手）的已有条目，复用它的 id，避免同一首歌被记成两条
        try:
            led = pick_ledger._load()
        except Exception:
            led = {}
        for k, rec in (led.get("songs") or {}).items():
            if not str(k).isdigit():
                continue
            if (rec.get("name") or "").strip() != name:
                continue
            if artist and (rec.get("artist") or "").strip() and artist not in (rec.get("artist") or ""):
                continue
            key = str(k)
            break

    if not key:
        # 用户口径：不是数字就不算成功。不记、不编 id，留一行现场。
        _log_external("no-numeric-id", name, artist, sid)
        print("SKIP no-numeric-id：%s（不记账）" % name)
        sys.exit(0)

    try:
        r = pick_ledger.record(None, None, [(key, name, artist)], fav_at=2, auto_fav=False)
        print(pick_ledger.summary(r) or "记账完成")
    except Exception as e:
        _log_external("record-fail", name, artist, sid)
        print("RECORD_FAIL %r" % (e,))


if __name__ == "__main__":
    main()
