# -*- coding: utf-8 -*-
"""
网易云音乐 PC 客户端 命令行控制器
控制通道: Chromium DevTools Protocol (http://127.0.0.1:9229)
脚本会自动发现客户端调试端口和页面 WebSocket 地址。

命令:
    python ncm.py status              当前播放信息
    python ncm.py toggle              播放 / 暂停 切换
    python ncm.py play                播放
    python ncm.py pause               暂停
    python ncm.py next                下一首
    python ncm.py prev                上一首
    python ncm.py vol up|down|N       音量 (up/down 步进 10，N 为 0-100)
    python ncm.py mode shuffle|loop|single   播放模式
    python ncm.py like                收藏当前歌曲
    python ncm.py open-playlist       打开播放列表面板
    python ncm.py search "关键词"      搜索并播放第一首单曲
    python ncm.py js "<表达式>"        直接执行任意 JS（调试用）
"""
import json
import os
import sys
import time
import urllib.request

import websocket

# 端口跟 World 面板走（NCM_CDP_PORT），默认 9229
DEBUG_BASE = "http://127.0.0.1:%s" % (os.environ.get("NCM_CDP_PORT") or "9229")
WS_JSON_PORT = int(os.environ.get("NCM_CDP_PORT") or "9229")

# 底部播放条的通用定位器（客户端窗口尺寸会变，用几何特征而不是固定坐标）
BAR_FINDER = """
const __bar = (() => {
  const w = window.innerWidth, h = window.innerHeight;
  return [...document.querySelectorAll("*")].find(e => {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return cs.position === "fixed" && r.y > h*0.75 && r.height > 50 && r.height < 130
           && r.width > w*0.75;
  });
})();
"""


def get_ws_url():
    with urllib.request.urlopen(DEBUG_BASE + "/json", timeout=5) as r:
        targets = json.loads(r.read().decode("utf-8"))
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("未找到可调试页面，网易云客户端可能未启动")
    return pages[0]["webSocketDebuggerUrl"]


def evaluate(expr, settle=None):
    """在客户端页面执行 JS，返回结果值。settle: 执行后等待秒数再读一次。"""
    ws = websocket.create_connection(get_ws_url(), timeout=15)
    try:
        payload = {
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": True,
                "userGesture": True,
            },
        }
        ws.send(json.dumps(payload))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                res = msg.get("result", {})
                if "exceptionDetails" in res:
                    ex = res["exceptionDetails"]
                    desc = ex.get("exception", {}).get("description", ex.get("text", ""))
                    return {"_error": desc}
                return res.get("result", {}).get("value")
    finally:
        ws.close()


def click_icon(icon_name):
    """点击底部播放条上指定图标（cmd-icon-<name>）"""
    expr = (
        "(() => {" + BAR_FINDER + """
  if (!__bar) return {err: "未找到底部播放条"};
  const target = [...__bar.querySelectorAll("[class*='cmd-icon']")]
      .find(b => /cmd-icon-%s(\\s|$)/.test(b.className.toString()));
  if (!target) return {err: "未找到按钮 %s", icons: [...__bar.querySelectorAll("[class*='cmd-icon']")].map(b => b.className.toString().match(/cmd-icon-(\\w+)/)?.[1])};
  target.click();
  return {ok: true, clicked: "%s"};
})()
""" % (icon_name, icon_name, icon_name)
    )
    return evaluate(expr)


def read_status():
    expr = "(() => {" + BAR_FINDER + """
  if (!__bar) return {err: "未找到底部播放条"};
  const icons = [...__bar.querySelectorAll("[class*='cmd-icon']")]
      .map(b => b.className.toString().match(/cmd-icon-(\\w+)/)?.[1]).filter(Boolean);
  const playing = icons.includes("pause");
  const text = (__bar.innerText || "").replace(/\\s+/g, " ").trim();
  const img = __bar.querySelector("img");
  return {
    playing,
    text,
    playingIcon: playing ? "pause(播放中)" : "play(已暂停)",
    cover: img ? img.src : null
  };
})()
"""
    return evaluate(expr)


SEEK_EXPR = """(() => {
  const sl = document.querySelector("[class*='StyledSliderContainer']");
  if (!sl) return {err: "未找到进度条"};
  const hz = sl.querySelector(".hotzone-overlay") || sl;
  const r = hz.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, %s));
  const targetX = r.x + r.width * ratio;
  const y = r.y + r.height / 2;
  const mk = (t, x) => new MouseEvent(t, {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1});
  hz.dispatchEvent(mk("mousedown", targetX));
  document.dispatchEvent(mk("mousemove", targetX));
  document.dispatchEvent(mk("mouseup", targetX));
  hz.dispatchEvent(mk("click", targetX));
  const track = sl.querySelector(".track");
  return {ok: true, targetRatio: ratio, totalWidth: Math.round(r.width)};
})()"""


def seek_ratio(ratio):
    return evaluate(SEEK_EXPR % ("%f" % ratio))


def current_ratio():
    expr = """(() => {
  const sl = document.querySelector("[class*='StyledSliderContainer']");
  if (!sl) return 0;
  const total = sl.getBoundingClientRect().width;
  const track = sl.querySelector(".track");
  return total ? track.getBoundingClientRect().width / total : 0;
})()"""
    v = evaluate(expr)
    return v if isinstance(v, (int, float)) else 0


VOL_EXPR = """(() => {
  const w = window.innerWidth, h = window.innerHeight;
  const bar = [...document.querySelectorAll("*")].find(e => {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return cs.position === "fixed" && r.y > h*0.75 && r.height > 50 && r.height < 130 && r.width > w*0.75;
  });
  if (!bar) return {err: "未找到播放条"};
  const volBtn = [...bar.querySelectorAll("[class*='cmd-icon']")].find(b => /cmd-icon-Volume/.test(b.className.toString()));
  if (!volBtn) return {err: "未找到音量按钮"};
  const r = volBtn.getBoundingClientRect();
  for (const t of ["mouseover", "mouseenter", "mousemove"]) {
    volBtn.dispatchEvent(new MouseEvent(t, {bubbles: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2}));
  }
  // 音量弹出面板通常在 body 上以浮层形式渲染，找竖排 slider
  const sels = [...document.querySelectorAll("[class*='Slider'], [class*='slider']")];
  const volSliders = sels.map(s => {
    const rr = s.getBoundingClientRect();
    return {cls: (s.className||"").toString().slice(0,50), rect:[Math.round(rr.x),Math.round(rr.y),Math.round(rr.width),Math.round(rr.height)]};
  }).filter(s => s.rect[2] > 0 && s.rect[3] > 20 && s.rect[3] > s.rect[2]);  // 竖排
  return {volBtnPos: [Math.round(r.x), Math.round(r.y)], verticalSliders: volSliders};
})()"""


def probe_volume():
    return evaluate(VOL_EXPR)


def set_volume(ratio):
    """通过底部进度条同样的方式操作音量：hover 音量图标后在竖排 slider 上点击。"""
    expr = """(async () => {
  const w = window.innerWidth, h = window.innerHeight;
  const bar = [...document.querySelectorAll("*")].find(e => {
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return cs.position === "fixed" && r.y > h*0.75 && r.height > 50 && r.height < 130 && r.width > w*0.75;
  });
  if (!bar) return {err: "未找到播放条"};
  const volBtn = [...bar.querySelectorAll("[class*='cmd-icon']")].find(b => /cmd-icon-Volume/.test(b.className.toString()));
  if (!volBtn) return {err: "未找到音量按钮"};
  const r = volBtn.getBoundingClientRect();
  for (const t of ["mouseover", "mouseenter", "mousemove"]) {
    volBtn.dispatchEvent(new MouseEvent(t, {bubbles: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2}));
  }
  await new Promise(rs => setTimeout(rs, 500));
  const sels = [...document.querySelectorAll("[class*='Slider'], [class*='slider']")]
    .filter(s => { const rr = s.getBoundingClientRect(); return rr.height > 20 && rr.height > rr.width && rr.width > 0; });
  if (!sels.length) return {err: "悬停后未出现音量滑块"};
  const sl = sels[0];
  const hz = sl.querySelector(".hotzone-overlay") || sl;
  const sr = hz.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, %s));
  // 竖排：从底部往上
  const targetY = sr.y + sr.height * (1 - ratio);
  const x = sr.x + sr.width / 2;
  const mk = (t, yy) => new MouseEvent(t, {bubbles: true, cancelable: true, clientX: x, clientY: yy, button: 0, buttons: 1});
  hz.dispatchEvent(mk("mousedown", targetY));
  document.dispatchEvent(mk("mousemove", targetY));
  document.dispatchEvent(mk("mouseup", targetY));
  hz.dispatchEvent(mk("click", targetY));
  return {ok: true, targetRatio: ratio, sliderRect: [Math.round(sr.x), Math.round(sr.y), Math.round(sr.width), Math.round(sr.height)]};
})()""" % ("%f" % ratio)
    return evaluate(expr)


def js(expr):
    return evaluate(expr)


SEARCH_EXPR = """(async () => {
  const kw = %s;
  const idx = %d;
  const input = document.querySelector("input.cmd-input") || [...document.querySelectorAll("input")]
      .find(i => /搜索|音乐|歌/i.test(i.placeholder || ""));
  if (!input) return {err: "未找到搜索框"};
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  input.focus();
  input.dispatchEvent(new Event("focus", {bubbles: true}));
  setter.call(input, kw);
  input.dispatchEvent(new Event("input", {bubbles: true}));
  input.dispatchEvent(new Event("change", {bubbles: true}));
  await new Promise(r => setTimeout(r, 300));
  for (const t of ["keydown", "keypress", "keyup"]) {
    input.dispatchEvent(new KeyboardEvent(t, {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}));
  }
  await new Promise(r => setTimeout(r, 1500));

  // 逐个 Tab 尝试：每个 Tab 页的卡片布局不同，找到第一个含可播放卡片的
  const tabs = [...document.querySelectorAll("[class*='tab'], [role='tab'], [class*='Tab']")]
      .filter(e => /单曲|歌曲/.test(e.innerText || ""));
  for (const tab of tabs) {
    if (/单曲/.test(tab.innerText || "")) { tab.click(); await new Promise(r => setTimeout(r, 800)); break; }
  }

  const cards = [...document.querySelectorAll("[class*='TrackCardWrapper']")];
  if (!cards.length) {
    return {err: "未找到歌曲卡片", pageText: (document.body.innerText||"").replace(/\\s+/g," ").slice(0,200)};
  }
  if (idx >= cards.length) return {err: "索引越界，共 " + cards.length + " 首"};
  const card = cards[idx];
  const r = card.getBoundingClientRect();
  for (const t of ["mouseover", "mouseenter", "mousemove"]) {
    card.dispatchEvent(new MouseEvent(t, {bubbles: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2}));
  }
  await new Promise(r => setTimeout(r, 200));
  const btn = card.querySelector("[class*='btn-play']") || card.querySelector("[class*='cmd-icon-play']");
  if (!btn) return {err: "卡片无播放按钮"};
  btn.click();
  await new Promise(r => setTimeout(r, 1000));
  return {ok: true, keyword: kw, index: idx, cardCount: cards.length,
          playing: (card.innerText || "").replace(/\\s+/g, " ").slice(0, 80)};
})()"""


def do_search_and_play(keyword, index=0):
    """搜索关键词，播放搜索结果中第 index 首（默认第一首）。"""
    return evaluate(SEARCH_EXPR % (json.dumps(keyword, ensure_ascii=False), index))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1].lower()
    arg = sys.argv[2] if len(sys.argv) > 2 else None

    if cmd == "status":
        print(json.dumps(read_status(), ensure_ascii=False, indent=2))

    elif cmd in ("toggle", "play", "pause"):
        if cmd == "toggle":
            print(json.dumps(click_icon("play" if True else "pause"), ensure_ascii=False))
        elif cmd == "play":
            st = read_status()
            if st and st.get("playing"):
                print("已在播放中")
            else:
                res = evaluate("(() => {" + BAR_FINDER + """
  const b = [...__bar.querySelectorAll("[class*='cmd-icon']")].find(x => /cmd-icon-play(\\s|$)/.test(x.className));
  if(!b) return {err:"未找到播放按钮"};
  b.click(); return {ok:true, clicked:"play"};
})()""")
                print(json.dumps(res, ensure_ascii=False))
        else:
            st = read_status()
            if st and not st.get("playing"):
                print("已是暂停状态")
            else:
                res = evaluate("(() => {" + BAR_FINDER + """
  const b = [...__bar.querySelectorAll("[class*='cmd-icon']")].find(x => /cmd-icon-pause(\\s|$)/.test(x.className));
  if(!b) return {err:"未找到暂停按钮"};
  b.click(); return {ok:true, clicked:"pause"};
})()""")
                print(json.dumps(res, ensure_ascii=False))

    elif cmd in ("next", "prev"):
        print(json.dumps(click_icon("next" if cmd == "next" else "pre"), ensure_ascii=False))

    elif cmd == "vol":
        if arg in ("probe", None):
            print(json.dumps(probe_volume(), ensure_ascii=False, indent=2))
        else:
            # 支持百分比 0-100，或 up/down 步进
            st = probe_volume()
            if arg == "up":
                print(json.dumps(set_volume(1.0), ensure_ascii=False))
            elif arg == "down":
                print(json.dumps(set_volume(0.0), ensure_ascii=False))
            else:
                try:
                    v = float(arg)
                    if v > 1:
                        v = v / 100.0
                    print(json.dumps(set_volume(v), ensure_ascii=False))
                except ValueError:
                    print("音量参数应为 0-100 或 up/down")

    elif cmd == "seek":
        if not arg:
            print("用法: seek <0-100> 或 seek +30 / seek -30（秒，需要先读 status 判断）")
            return
        try:
            if arg.startswith("+"):
                cur = current_ratio()
                r = seek_ratio(min(1.0, cur + float(arg[1:]) / 100.0))
            elif arg.startswith("-"):
                cur = current_ratio()
                r = seek_ratio(max(0.0, cur - float(arg[1:]) / 100.0))
            else:
                r = seek_ratio(float(arg) / 100.0 if float(arg) > 1 else float(arg))
            print(json.dumps(r, ensure_ascii=False))
        except ValueError:
            print("进度参数无效")

    elif cmd == "mode":
        mapping = {"shuffle": "shuffle", "loop": "loop", "single": "singlecycle", "list": "list"}
        print(json.dumps(click_icon(mapping.get(arg or "", "shuffle")), ensure_ascii=False))

    elif cmd == "like":
        print(json.dumps(click_icon("collect"), ensure_ascii=False))

    elif cmd == "open-playlist":
        print(json.dumps(click_icon("playlist"), ensure_ascii=False))

    elif cmd == "search":
        if not arg:
            print("请提供关键词，可选第二参数为结果序号(从0开始)")
            return
        idx = 0
        if len(sys.argv) > 3:
            try:
                idx = int(sys.argv[3])
            except ValueError:
                idx = 0
        print(json.dumps(do_search_and_play(arg, idx), ensure_ascii=False, indent=2))

    elif cmd == "js":
        if not arg:
            print("请提供 JS 表达式")
            return
        print(json.dumps(js(arg), ensure_ascii=False, indent=2))

    else:
        print("未知命令:", cmd)
        print(__doc__)


if __name__ == "__main__":
    main()
