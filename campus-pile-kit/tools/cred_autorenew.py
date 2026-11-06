# -*- coding: utf-8 -*-
"""无人值守换证：凭证过期后自动唤起小程序、抓新 token、上传。

## 为什么是「过期后才换」而不是「提前换」

微信小程序的逻辑是「缓存里的 token 还能用就不登录」。实证（小程序日志）：
    wx.login 只在 10-18 17:02、10-27 16:06、11-05 00:25 各调过一次，
    每次都是上一张凭证已过期、用户打开小程序时才静默重登。
所以提前唤起小程序**换不出新 token**（实测过：冷启动打了一堆 auth=yes 请求，
但 token 文件没变）。唯一稳的做法是等 exp 过了再唤起，让应用自己判断需要重登。

代价是从 exp 到本脚本跑到之间有个窗口期（默认 ≤10 分钟，取决于计划任务频率），
这期间页面用的是过期凭证。凌晨执行，影响可忽略。

## 用法

    python tools/cred_autorenew.py            # 计划任务用这个：未过期直接退出
    python tools/cred_autorenew.py --force    # 忽略过期判断，强制跑一遍（调试用）
    python tools/cred_autorenew.py --status   # 只看状态，不动作

## 红线

* Fiddler 一旦起来，**任何异常路径都必须收尾**，否则系统代理停在 8888 = 断网。
  `finally` 里 stop_fiddler()，不要只在成功分支收尾。
* 失败后 30 分钟内不再重试（`--force` 除外），免得每 10 分钟拉一次小程序。
* 日志自己轮转（>200KB 就换名），计划任务跑久了不会撑爆磁盘。

日志：~/.chd_autorenew.log
状态：~/.chd_autorenew_state.json
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cred_grab as cg  # noqa: E402

HOME = Path.home()
LOG_FILE = HOME / ".chd_autorenew.log"
STATE_FILE = HOME / ".chd_autorenew_state.json"
LOG_MAX = 200 * 1024
RETRY_COOLDOWN = 30 * 60          # 失败后 30 分钟内不重试
URI = "weixin://launchapplet/?app_id=wxc73fedf63187e001"
WAIT_NEW_TOKEN = 90               # 唤起后最多等 90 秒

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def log(msg):
    line = "%s  %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_MAX:
            LOG_FILE.replace(LOG_FILE.with_suffix(".log.1"))
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(**kw):
    st = load_state()
    st.update(kw)
    try:
        STATE_FILE.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def token_status():
    tok = cg.read_token_file()
    if not tok:
        return None, 0
    return tok, cg.jwt_exp(tok) or 0


def applet_pids():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq WeChatAppEx.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, errors="replace",
    ).stdout
    pids = []
    for line in out.splitlines():
        parts = [x.strip('"') for x in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == "wechatappex.exe":
            pids.append(parts[1])
    return pids


def report(ok, err="", phase="", exp_before=0, exp_after=0):
    """把这一轮的结果推给 Worker，让「设置 › 设备凭证」里那张「自动续期」卡有内容。

    为什么要有它：换证是无人值守跑的，成功了 exp 会变新、页面一眼看得出；
    **失败却只剩一个 expired**，分不清「刚过期、任务还没轮到」和「已经连败三天」。

    三条红线：
      1. 必须在 **Fiddler 收尾之后** 调用 —— 代理还挂在 8888 时，这个请求要多走一跳 Fiddler。
      2. **不能调 cg.read_admin()**：它在文件缺失时 sys.exit()，会把计划任务判成失败。
      3. 任何异常都吞掉。这只是可观测性，不能反过来影响换证本身。
    """
    try:
        f = cg.ADMIN_FILE
        admin = f.read_text(encoding="utf-8", errors="ignore").strip() if f.exists() else ""
        if len(admin) < 8:
            return
        st, js = cg.api("POST", "/api/cred/renew",
                        headers={"x-admin-token": admin},
                        body={"ok": bool(ok), "phase": phase, "err": err,
                              "expBefore": exp_before, "expAfter": exp_after},
                        timeout=15)
        if st != 200 or not js.get("ok"):
            log("  上报续期状态失败 http=%s %s" % (st, js))
    except Exception as e:
        log("  上报续期状态异常：%s: %s" % (type(e).__name__, e))


def renew(force_note=""):
    """跑一轮换证。返回 (ok, 说明)。"""
    tok_before, exp_before = token_status()
    before_sha = cg.sha8(tok_before) if tok_before else ""
    before_mtime = cg.TOKEN_FILE.stat().st_mtime if cg.TOKEN_FILE.exists() else 0

    started = False
    try:
        en, srv = cg.proxy_enable()
        if en and str(cg.PROXY_PORT) not in srv:
            return False, "系统代理被别的东西占着（%s），不抢，跳过" % srv

        if not cg.start_fiddler():
            log("  ⚠️ Fiddler 没接管代理，这次大概率抓不到")
        started = True
        time.sleep(2)

        pids = applet_pids()
        for pid in pids:
            subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
        log("  关掉小程序宿主 %d 个，冷启动唤起" % len(pids))
        time.sleep(2)

        os.startfile(URI)
        log("  已唤起小程序，等新凭证，最多 %d 秒" % WAIT_NEW_TOKEN)

        old_wait = cg.GRAB_TIMEOUT
        cg.GRAB_TIMEOUT = WAIT_NEW_TOKEN
        try:
            tok = cg._wait_new_token(before_sha, before_mtime)
        finally:
            cg.GRAB_TIMEOUT = old_wait
    finally:
        if started:
            cg.stop_fiddler()        # 🔴 必须无条件收尾，否则断网

    if not tok:
        return False, "没抓到新 token（小程序没登 / 微信没开 / 请求没带 Bearer）"
    if cg.sha8(tok) == before_sha:
        return False, "抓到的还是旧 token（应用复用了缓存，没真的重登）"

    exp = cg.jwt_exp(tok) or int(time.time() + 7 * 86400)
    ok, msg = cg.verify(tok)
    if not ok:
        return False, "抓到了但校验不过：%s" % msg

    st, js = cg.upload(tok, exp)
    if st != 200 or not js.get("ok"):
        return False, "上传失败 http=%s %s" % (st, js)

    return True, "换证成功 %s → %s%s" % (
        cg.fmt_ts(exp_before), cg.fmt_ts(exp), force_note)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="忽略过期判断与冷却，强制跑")
    ap.add_argument("--status", action="store_true", help="只看状态")
    a = ap.parse_args()

    tok, exp = token_status()
    left = exp - time.time()

    if a.status:
        print("token sha8=%s exp=%s 剩余=%s" % (
            cg.sha8(tok) if tok else "(无)", cg.fmt_ts(exp), cg.human_left(exp) if exp else "-"))
        st = load_state()
        print("上次结果：", st.get("last_result") or "(无)")
        print("上次时间：", st.get("last_ts") or "(无)")
        return 0

    if not a.force:
        if not tok:
            log("本机没有 token 文件，先手动跑一次 grab-cred.bat")
            return 1
        if left > 0:
            return 0                  # 还没过期：什么都不做，静默退出
        st = load_state()
        last = st.get("last_fail_ts") or 0
        if time.time() - last < RETRY_COOLDOWN:
            return 0                  # 冷却中

    log("=== 开始换证（%s）===" % ("强制" if a.force else "已过期 %s" % cg.human_left(exp)))
    try:
        ok, msg = renew("（强制）" if a.force else "")
    except Exception as e:                       # 任何异常都不能让任务卡死
        ok, msg = False, "异常：%s: %s" % (type(e).__name__, e)

    log(("✓ " if ok else "✗ ") + msg)
    # 换证结果上报（v3.05）：让页面能说清「续期到底在不在跑」。
    # exp_after 重新读文件 —— renew() 里的新 exp 没透出来，重读比改签名更小。
    _, exp_after = token_status()
    report(ok, err=("" if ok else msg), phase=("force" if a.force else "expired"),
           exp_before=exp, exp_after=exp_after)
    if ok:
        save_state(last_ts=datetime.now().isoformat(timespec="seconds"),
                   last_result=msg, last_fail_ts=0)
        return 0
    save_state(last_ts=datetime.now().isoformat(timespec="seconds"),
               last_result=msg, last_fail_ts=time.time())
    return 1


if __name__ == "__main__":
    sys.exit(main())
