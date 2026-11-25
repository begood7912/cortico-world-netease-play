# -*- coding: utf-8 -*-
"""点歌后的“自愈”：等几秒看一次，发现歌被暂停了就点回播放。

由 addplay.py 以独立进程（detached）拉起，不阻塞点歌返回、不弹窗、不等它。
只在刚点完歌的那几秒里管一下；本来就在播就直接退出。
日志写到 %TEMP%\\ncm-guard.log，以后要查“它到底有没有动过播放器”看那里。
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def log(msg):
    try:
        p = os.path.join(os.environ.get("TEMP") or HERE, "ncm-guard.log")
        with open(p, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


PLAY_BTN_JS = r"""(() => {""" + r"""
  const __bar = (() => {
    const w = window.innerWidth, h = window.innerHeight;
    return [...document.querySelectorAll("*")].find(e => {
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
      return cs.position === "fixed" && r.y > h*0.75 && r.height > 50 && r.height < 130
             && r.width > w*0.75;
    });
  })();
  if (!__bar) return {err: "未找到底部播放条"};
  const b = [...__bar.querySelectorAll("[class*='cmd-icon']")]
      .find(x => /cmd-icon-play(\s|$)/.test(x.className.toString()));
  if (!b) return {err: "未找到播放按钮"};
  b.click();
  return {ok: true, clicked: "play"};
""" + r"})()"


def main():
    delay = float(os.environ.get("NCM_GUARD_DELAY") or 4.0)
    rounds = int(os.environ.get("NCM_GUARD_ROUNDS") or 2)
    wait = float(os.environ.get("NCM_GUARD_WAIT") or 2.0)
    who = os.environ.get("NCM_GUARD_TAG") or ""
    time.sleep(delay)

    import ncm  # 同目录那份

    for i in range(rounds):
        try:
            st = ncm.read_status() or {}
        except Exception as e:
            log("%s读状态失败：%s" % (who, e))
            return
        if st.get("err"):
            log("%s读状态异常：%s" % (who, st.get("err")))
            return
        if st.get("playing"):
            log("%s第 %d 次检查：还在播（%s），不动" % (who, i + 1, st.get("text") or ""))
            return

        log("%s第 %d 次检查：发现被暂停（%s）→ 点回播放" % (who, i + 1, st.get("text") or ""))
        try:
            # 点之前再确认一次，避免刚好自己恢复了又被点成暂停
            st2 = ncm.read_status() or {}
            if st2.get("playing"):
                log("%s   刚要恢复时它自己又播起来了，不动" % who)
                return
            log("%s   %s" % (who, ncm.evaluate(PLAY_BTN_JS)))
        except Exception as e:
            log("%s点播放失败：%s" % (who, e))
            return
        time.sleep(wait)

    log("%s收工" % who)


if __name__ == "__main__":
    main()
