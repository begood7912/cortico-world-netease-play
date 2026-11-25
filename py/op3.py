# -*- coding: utf-8 -*-
"""操作 3:建歌单 → 塞歌 → 放整个歌单 → 客户端自己往下接。

2026-11-13 04:1x 实测通的路子:9229 CDP 抓 cookie + 明文 api(不用 pycryptodome)。
老大 04:11 把这一套定名「操作 3」。

用法:
    python op3.py --name 小涟试播 --songs "王心凌 爱你" "周杰伦 晴天" "周杰伦 稻香"
    python op3.py --name 小涟试播 --songs "王心凌 爱你" --no-play        # 只建不播
    python op3.py --add 18589646182 "王心凌 睫毛弯弯"                    # 往已有歌单加歌
    python op3.py --play 18589646182                                     # 只放已有歌单
    python op3.py --delete 18589646182                                   # 删歌单
    python op3.py --list                                                 # 我创建的歌单
    python op3.py --status                                               # 现在在放什么

要点(都是踩过的坑):
  * 删歌单的参数名是 pid,写 id/ids 一律 code 400。
  * 判断删干净没有别用 /api/v6/playlist/detail(已删仍回 200 + 缓存),
    查 /api/user/playlist?uid=<自己>&limit=1000。
  * 放歌单时客户端 t≈1.2s 才冒出来抢前台;所以要每 50ms 轮询、一露头就 ShowWindow(hwnd,6),
    并在缩完把前台还给原来那只窗口。
"""
import argparse
import base64
import ctypes
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

DEBUG_BASE = "http://127.0.0.1:%s" % (os.environ.get("NCM_CDP_PORT") or "9229")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": "https://music.163.com/"}
HOST_CLASS = "OrpheusBrowserHost"
API = "https://music.163.com"

u32 = ctypes.windll.user32


# ---------- 窗口 ----------

def _host_windows():
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _lp):
        cls = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(hwnd, cls, 256)
        if cls.value == HOST_CLASS:
            t = ctypes.create_unicode_buffer(512)
            u32.GetWindowTextW(hwnd, t, 512)
            out.append({
                "hwnd": hwnd,
                "title": t.value,
                "visible": bool(u32.IsWindowVisible(hwnd)),
                "minimized": bool(u32.IsIconic(hwnd)),
            })
        return True

    u32.EnumWindows(cb, None)
    return out


def _foreground():
    return u32.GetForegroundWindow()


def _hide_dialog(exposed_sink):
    """把露头的 OrpheusBrowserHost 立刻最小化;返回第一次露头的耗时(秒)。"""
    t0 = time.time()
    first = None
    while time.time() - t0 < 6.0:
        for h in _host_windows():
            if h["visible"] and not h["minimized"]:
                if first is None:
                    first = time.time() - t0
                u32.ShowWindow(h["hwnd"], 6)
                break
        if first is not None and time.time() - t0 - first > 1.0:
            break
        time.sleep(0.05)
    exposed_sink.append(first)
    return first


# ---------- cookie / api ----------

def cookies():
    import websocket  # noqa: 本机已有

    with urllib.request.urlopen(DEBUG_BASE + "/json", timeout=5) as r:
        targets = json.loads(r.read().decode("utf-8"))
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("9229 没有 page 目标")
    ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=15)
    try:
        ws.send(json.dumps({"id": 1, "method": "Network.getAllCookies"}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                raw = msg["result"]["cookies"]
                break
    finally:
        ws.close()
    jar = {c["name"]: c["value"] for c in raw
           if "music.163.com" in (c.get("domain") or "")}
    if "MUSIC_U" not in jar:
        raise RuntimeError("没抓到 MUSIC_U,客户端可能没登录")
    return jar


def session():
    import requests

    jar = cookies()
    s = requests.Session()
    s.cookies.update(jar)
    return s, jar.get("__csrf", "")


def search(s, query, limit=20):
    r = s.post(API + "/api/search/get",
               data={"s": query, "type": 1, "limit": limit, "offset": 0},
               headers=HEADERS, timeout=15)
    songs = ((r.json().get("result") or {}).get("songs") or [])
    return songs


def pick(songs, query):
    """挑最像原版的那条:歌手名逐字出现在歌名/歌手里优先,否则第一条。"""
    parts = query.split()
    artist = parts[0] if len(parts) > 1 else ""
    for so in songs:
        names = (so.get("name") or "").lower()
        artists = " ".join(a.get("name", "") for a in (so.get("artists") or [])).lower()
        if artist and artist.lower() in artists and names:
            return so
    return songs[0] if songs else None


def me(s):
    r = s.get(API + "/api/nuser/account/get", headers=HEADERS, timeout=15)
    d = r.json()
    return ((d.get("account") or {}).get("id"),
            (d.get("profile") or {}).get("nickname"))


def my_playlists(s):
    uid, _ = me(s)
    r = s.get(API + "/api/user/playlist",
              params={"uid": uid, "limit": 1000, "offset": 0}, headers=HEADERS, timeout=15)
    pls = r.json().get("playlist") or []
    return uid, [pl for pl in pls if (pl.get("creator") or {}).get("userId") == uid]


def create(s, csrf, name):
    r = s.post(API + "/api/playlist/create",
               data={"name": name, "csrf_token": csrf}, headers=HEADERS, timeout=15)
    d = r.json()
    pid = d.get("id") or (d.get("playlist") or {}).get("id")
    if not pid:
        raise RuntimeError("建歌单失败:%s" % d)
    return pid


def add_tracks(s, csrf, pid, track_ids):
    r = s.post(API + "/api/playlist/manipulate/tracks",
               data={"op": "add", "pid": pid,
                     "trackIds": json.dumps([int(i) for i in track_ids]),
                     "imme": "true", "csrf_token": csrf},
               headers=HEADERS, timeout=15)
    d = r.json()
    if d.get("code") not in (200, 201):
        # 2026-11-16 22:14:已经在歌单里(china 502「歌单内歌曲重复」)也算成功,别再抛错把播放卡死
        if d.get("code") == 502 or "重复" in str(d.get("message", "")):
            return d
        raise RuntimeError("加歌失败:%s" % str(d)[:200])
    return d


def add_tracks_report(s, csrf, pid, track_ids, batch=100):
    """0.17.42：按批加歌并**逐批记结果**，不抛异常（给 del+add 那条路用）。

    为什么按批：点歌 1~5 首永远是一批，等于逐首精度；上百首时才切成多批。
    为什么 502 不算成功：调用方是「先删后加」，这批刚被删掉，接口再回 502
    （歌单内歌曲重复）说明**这次没加进去**（删除没生效 / 被限流），不能当 already。
    """
    ids = [int(i) for i in track_ids]
    added, failed, codes, errors = [], [], [], []
    for i in range(0, len(ids), batch):
        part = ids[i:i + batch]
        try:
            r = s.post(API + "/api/playlist/manipulate/tracks",
                       data={"op": "add", "pid": pid,
                             "trackIds": json.dumps(part),
                             "imme": "true", "csrf_token": csrf},
                       headers=HEADERS, timeout=15)
            d = r.json()
            code = d.get("code")
            msg = str(d.get("message", ""))[:120]
            codes.append({"code": code, "message": msg, "ids": part})
            if code in (200, 201):
                added.extend(part)
            else:
                failed.extend(part)
                errors.append("add code=%s %s" % (code, msg))
        except Exception as e:
            failed.extend(part)
            codes.append({"code": None, "message": repr(e)[:120], "ids": part})
            errors.append("add exception: %r" % (e,))
    return {"addedIds": added, "failedIds": failed, "codes": codes, "errors": errors}


def del_tracks(s, csrf, pid, track_ids):
    """从歌单里删歌(2026-11-18 05:43 老大要删掉挑错的版本)。"""
    r = s.post(API + "/api/playlist/manipulate/tracks",
               data={"op": "del", "pid": pid,
                     "trackIds": json.dumps([int(i) for i in track_ids]),
                     "csrf_token": csrf},
               headers=HEADERS, timeout=15)
    d = r.json()
    if d.get("code") != 200:
        raise RuntimeError("删歌失败:%s" % str(d)[:200])
    return d


def playlist_track_ids(s, pid):
    """读歌单里现有的全部曲目 id（清空前用，防止残留占在队列第一位）。
    注意这个接口有缓存：刚加的读不到，但清空场景读的是旧状态，够用。"""
    r = s.post(API + "/api/v6/playlist/detail",
               data={"id": pid, "n": 1000, "s": 0}, headers=HEADERS, timeout=15)
    d = r.json()
    pl = d.get("playlist") or {}
    out = [t.get("id") for t in (pl.get("tracks") or []) if t.get("id")]
    if not out:
        for x in (pl.get("trackIds") or []):
            i = x.get("id") if isinstance(x, dict) else x
            if i:
                out.append(i)
    return out


def delete(s, csrf, pid):
    r = s.post(API + "/api/playlist/delete",
               data={"pid": pid, "csrf_token": csrf}, headers=HEADERS, timeout=15)
    return r.json()


# 2026-11-13 04:45 定稿(实测通,在放《大眠》):
#   * location.hash 在这个客户端里设了不生效(hash 一直是空串),只能点侧栏那一行;
#   * 页面上「播放全部」四个字在 body.innerText 里有,但 querySelectorAll 抓不到 → 在 shadow DOM 里,
#     所以整套改成递归 shadowRoot 收集元素;
#   * 点最小面积那个(最里层),而且 pointer/mouse 几个事件都派发一遍才认。
# 全程只动页面,不弹窗、不抬窗口,也不走 orpheus(老大 04:30 明确不要)。
PLAYLIST_JS = """(async () => {
  const NAME = __NAME__;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const deep = () => {
    const out = [];
    const walk = (root) => {
      let els = [];
      try { els = [...root.querySelectorAll('*')]; } catch (e) {}
      for (const e of els) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); }
    };
    walk(document);
    return out;
  };
  const find = (text, exact) => {
    const hit = deep().filter(e => {
      const t = (e.textContent || '').trim();
      if (exact ? t !== text : t.indexOf(text) < 0) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && t.length <= 24;
    });
    hit.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    return hit;
  };
  const fire = (e) => {
    const r = e.getBoundingClientRect();
    const o = {bubbles: true, cancelable: true, composed: true,
               clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
               button: 0, view: window};
    ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']
      .forEach(t => { try {
          e.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, o));
        } catch (err) {} });
    e.click();
  };
  const rows = find(NAME, true);
  if (rows.length) fire(rows[0]);
  await sleep(2500);
  let b = [];
  for (let i = 0; i < 12; i++) {
    b = find('播放全部', false);
    if (b.length) break;
    await sleep(500);
  }
  if (!b.length) return {ok: false, opened: rows.length > 0, why: 'no button'};
  fire(b[0]);
  await sleep(3000);
  return {ok: true, opened: rows.length > 0,
          clicked: (b[0].textContent || '').trim(), n: b.length};
})()"""


def playlist_name(s, pid):
    """pid → 歌单名(CDP 只能靠名字点侧栏那一行)。"""
    _, mine = my_playlists(s)
    for pl in mine:
        if str(pl.get("id")) == str(pid):
            return pl.get("name")
    return None


def play_playlist_cdp(pid, name):
    """在客户端页面里点开侧栏歌单、再点「播放全部」——不弹窗、不动窗口。
    2026-11-13 04:45 实测通。返回 dict。"""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import ncm  # noqa
    js = PLAYLIST_JS.replace("__NAME__", json.dumps(name, ensure_ascii=False))
    return ncm.evaluate(js) or {}


def play_playlist(pid, hide=True):
    """hide=False 就什么都不做,让老大自己盯着弹窗(他 04:16 交代过)。"""
    payload = base64.urlsafe_b64encode(json.dumps(
        {"type": "playlist", "id": str(pid), "cmd": "play"},
        separators=(",", ":")).encode()).decode()
    url = "orpheus://" + payload
    if not hide:
        subprocess.run(["cmd", "/c", "start", "", url], capture_output=True,
                       timeout=30, shell=False, creationflags=0x08000000)
        return url, None
    prev = _foreground()
    for h in _host_windows():
        u32.ShowWindow(h["hwnd"], 6)
    subprocess.run(["cmd", "/c", "start", "", url], capture_output=True,
                   timeout=30, shell=False, creationflags=0x08000000)
    sink = []
    first = _hide_dialog(sink)
    if prev and prev != _foreground():
        try:
            u32.SetForegroundWindow(prev)
        except Exception:
            pass
    return url, first


def status():
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    here = os.path.dirname(os.path.abspath(__file__))
    r = subprocess.run([sys.executable, os.path.join(here, "ncm.py"), "status"],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=60, env=env)
    return r.stdout.strip()


def resolve_id(s, q):
    """q 可以是「歌手 歌名」,也可以是 id:<数字>(模式二收割来的 id 直接用)。"""
    m = re.match(r"^\s*id:(\d+)\s*$", q or "")
    if m:
        print("按 id 加: %s" % m.group(1))
        return int(m.group(1))
    cand = pick(search(s, q), q)
    if not cand:
        return None
    print("%s -> id=%s 《%s》 - %s" % (
        q, cand["id"], cand.get("name"),
        "/".join(x.get("name", "") for x in (cand.get("artists") or []))))
    return cand["id"]


def do_play(pid, a):
    """只在页面里点(侧栏歌单行 + 播放全部)。老大 04:30 说不要 orpheus 那条,已取消回退。"""
    s, _ = session()
    name = playlist_name(s, pid)
    if not name:
        print("播放失败:我的歌单里找不到 pid=%s" % pid)
        return
    try:
        r = play_playlist_cdp(pid, name)
    except Exception as e:
        print("播放失败(CDP):", repr(e))
        return
    if not r.get("ok"):
        print("播放失败:页面上没点到「播放全部」:", json.dumps(r, ensure_ascii=False)[:300])
        return
    print("play(页面里点) pid=%s 《%s》 clicked=%s opened=%s"
          % (pid, name, r.get("clicked"), r.get("opened")))
    time.sleep(1.5)
    print(status())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name")
    ap.add_argument("--songs", nargs="*", default=[])
    ap.add_argument("--no-play", action="store_true")
    ap.add_argument("--no-hide", action="store_true",
                    help="放的时候不动窗口(不最小化、不还焦点),弹窗留给老大自己看")
    ap.add_argument("--add", nargs="+", metavar="PID_OR_QUERY")
    ap.add_argument("--play")
    ap.add_argument("--delete", nargs="+")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()

    if a.status:
        print(status())
        return

    s, csrf = session()

    if a.list:
        uid, mine = my_playlists(s)
        print("uid=%s, 我创建的歌单 %d 个" % (uid, len(mine)))
        for pl in mine:
            print("  %s 《%s》 tracks=%s" % (pl.get("id"), pl.get("name"),
                                            pl.get("trackCount")))
        return

    if a.delete:
        for pid in a.delete:
            print("delete", pid, "->", delete(s, csrf, pid))
        uid, mine = my_playlists(s)
        left = [pl.get("id") for pl in mine]
        print("删完我创建的歌单 %d 个,剩下:%s" % (len(mine), left))
        return

    if a.play:
        do_play(a.play, a)
        return

    if a.add:
        pid = a.add[0]
        queries = a.add[1:]
        ids = []
        for q in queries:
            tid = resolve_id(s, q)
            if not tid:
                print(q, "-> 啥也没搜到")
                continue
            ids.append(tid)
        if ids:
            add_tracks(s, csrf, pid, ids)
            print("加好了", ids)
        return

    if a.name:
        if not a.songs:
            ap.error("--name 要配 --songs")
        pid = create(s, csrf, a.name)
        print("歌单《%s》pid=%s" % (a.name, pid))
        ids = []
        for q in a.songs:
            tid = resolve_id(s, q)
            if not tid:
                print(q, "-> 啥也没搜到")
                continue
            ids.append(tid)
        if ids:
            add_tracks(s, csrf, pid, ids)
        print("ids:", ids)
        if ids and not a.no_play:
            do_play(pid, a)
        return

    ap.print_help()


if __name__ == "__main__":
    main()
