#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""凭证抓取与上传（重建版，2026-11-05）。

## 这件事为什么不能"全自动"

上游（街电 / 竹芒 union.zhumanggroup.com）的 token 是**微信小程序登录态**的产物：
它由微信侧的 code 换出来，有效期固定 7 天，**没有滑动续期、没有 refresh 接口**。
我们不是这个小程序的运营方，拿不到 AppID/AppSecret，所以没有任何一条无人值守
的合法路径能凭空变出一张新 token。

能自动化的边界就到这里 —— 从「token 出现在磁盘上」那一刻开始，往后全自动：

    抓包落盘  →  解码 JWT 取 exp  →  调 /api/pile 真实验证  →  上传 /api/cred  →  回读确认

唯一需要人的动作：在微信里打开「街电充电桩」小程序，让它发一次请求。
（小程序的网络请求走 WeChatAppEx，UA 带 MicroMessenger，FiddlerScript 只认这个。）

## 抓包侧（已经装好了，不用再动）

    %USERPROFILE%\\Documents\\Fiddler2\\Scripts\\CustomRules.js

里面有一段 `CAPTURE_JD_TOKEN` 规则：命中 union.zhumanggroup.com 且请求头
`Authorization: Bearer <jwt>` 时，把 token 覆盖写进 `~/.jiedian_token`。
本脚本只**读**这个文件，不碰 FiddlerScript。

## 用法

    python tools/cred_grab.py --status        看线上凭证还剩多久（不联网也能看本机那份）
    python tools/cred_grab.py --renew         抓一张新的并上传（需要你点小程序）
    python tools/cred_grab.py --push          把 ~/.jiedian_token 里已有的那份直接上传
    python tools/cred_grab.py --fixproxy      代理被 Fiddler 留在 8888 导致断网时救急
"""

import argparse
import base64
import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

# Windows 控制台默认可能不是 UTF-8，中文会炸成乱码
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOME = Path(os.path.expanduser("~"))
TOKEN_FILE = HOME / ".jiedian_token"          # FiddlerScript 抓到就写这里
TOKEN_LOG = HOME / ".jiedian_token_history.log"
PROBE_FILE = HOME / ".chd_fid_probe.log"      # Fiddler 探针日志：抓不到时靠它分辨失败原因
ADMIN_FILE = HOME / ".chd_admin_token"        # Cloudflare Worker 的 ADMIN_TOKEN

SITE = "https://chd-charge.pages.dev"
# 🔴 反代域名 chd-charge.app.workbuddy.host 会丢掉 x-admin-token，写过一次就报 bad_token，
#    所以这里钉死 pages.dev，别再改成别的。
PROBE_IDS = ["XLA23805"]        # 真实设备号，用来验证 token 真的能查到东西
PROXY_HOST, PROXY_PORT = "127.0.0.1", 8888
GRAB_TIMEOUT = 420              # 等用户点小程序的最长时间（秒）

FIDDLER_CANDIDATES = [
    Path(r"D:\Users\Administrator\AppData\Local\Programs\Fiddler\Fiddler.exe"),
    Path(r"C:\Program Files (x86)\Fiddler2\Fiddler.exe"),
    Path(r"C:\Program Files\Fiddler\Fiddler.exe"),
    HOME / "AppData/Local/Programs/Fiddler/Fiddler.exe",
]

# 🔴 /api/cred 的 data 字段是「旧页面回退」用的密文，现在的页面（v2.97+）根本不读它，
#    凭证由 Worker 自己拿着（KV 键 cred_tok）。而且它当初的密钥是用户自定义的 cpk.sync，
#    脚本这边没有那把钥匙。所以这里写一条明确的占位，不要伪装成有效密文。
DATA_PLACEHOLDER = "v1:cred_grab:placeholder-no-encrypted-blob"


# ---------------------------------------------------------------- HTTP

def _opener():
    """🔴 必须绕开系统代理：--renew 时 Fiddler 正把全局代理指向 127.0.0.1:8888，
    不绕的话脚本自己的请求会打回 Fiddler，轻则变慢重则死循环。"""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method, path, *, headers=None, body=None, timeout=25):
    url = SITE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Origin", SITE)
    req.add_header("Referer", SITE + "/")
    req.add_header("User-Agent", "chd-cred-grab/1.0")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with _opener().open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, _json_or_text(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return e.code, _json_or_text(raw)
    except Exception as e:                     # 断网 / DNS / 超时
        return 0, {"ok": False, "error": "net_" + type(e).__name__, "detail": str(e)[:120]}


def _json_or_text(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"ok": False, "error": "bad_response", "detail": raw[:160]}


# ---------------------------------------------------------------- token 解析

def jwt_exp(tok):
    """解出 JWT 的 exp（秒）。解不出来返回 0 —— 那就只能按 +7 天估。"""
    parts = tok.split(".")
    if len(parts) < 2:
        return 0
    try:
        seg = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(seg))
        exp = int(payload.get("exp") or 0)
        return exp if exp > 1_000_000_000 else 0
    except Exception:
        return 0


def sha8(tok):
    return hashlib.sha256(tok.encode()).hexdigest()[:8]


def fmt_ts(ts):
    if not ts:
        return "—"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def human_left(ts):
    if not ts:
        return "未知"
    d = datetime.fromtimestamp(ts) - datetime.now()
    s = int(d.total_seconds())
    if s <= 0:
        return "已过期 %d 小时" % (-s // 3600)
    return "%d 天 %d 小时" % (s // 86400, (s % 86400) // 3600)


def read_token_file():
    if not TOKEN_FILE.exists():
        return ""
    try:
        return TOKEN_FILE.read_text(encoding="utf-8", errors="ignore").strip()
    except Exception:
        return ""


def read_admin():
    if not ADMIN_FILE.exists():
        sys.exit("找不到写口令 %s —— 上传会 401，先把它补回来。" % ADMIN_FILE)
    tok = ADMIN_FILE.read_text(encoding="utf-8", errors="ignore").strip()
    if len(tok) < 8:
        sys.exit("写口令文件内容太短，疑似坏了：%s" % ADMIN_FILE)
    return tok


# ---------------------------------------------------------------- 验证 / 上传

def verify(tok):
    """拿真设备号打一次 /api/pile。返回 (是否通过, 说明)。"""
    st, js = api("POST", "/api/pile", body={"ids": PROBE_IDS, "src": "zm", "token": tok})
    if st != 200 or not js.get("ok"):
        err = js.get("error") or ("http_%s" % st)
        hint = js.get("hint") or ""
        return False, "%s %s" % (err, hint)
    devs = js.get("devices") or js.get("list") or []
    if not devs:
        return False, "接口通了但没返回设备（token 可能没权限 / 设备号失效）"
    d = devs[0] if isinstance(devs[0], dict) else {}
    return True, "查到 %d 个插座（%s state=%s）" % (
        len(d.get("ports") or d.get("sockets") or []) or len(devs),
        d.get("id") or d.get("deviceId") or PROBE_IDS[0],
        d.get("state", "?"))


def upload(tok, exp, note="cred_grab"):
    admin = read_admin()
    st, js = api("POST", "/api/cred", headers={"x-admin-token": admin},
                 body={"data": DATA_PLACEHOLDER, "token": tok,
                       "exp": exp, "note": note})
    return st, js


def read_cred():
    admin = read_admin()
    return api("GET", "/api/cred", headers={"x-admin-token": admin})


# ---------------------------------------------------------------- 代理

def proxy_enable():
    """读系统代理开关。返回 (enable, server)。"""
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                           r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        en = winreg.QueryValueEx(k, "ProxyEnable")[0]
        try:
            srv = winreg.QueryValueEx(k, "ProxyServer")[0]
        except OSError:
            srv = ""
        winreg.CloseKey(k)
        return bool(en), srv
    except Exception:
        return False, ""


def proxy_clear():
    """关掉系统代理并让系统立刻生效 —— Fiddler 被强杀后残留代理会导致整机断网。"""
    try:
        import winreg
        path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(k, "ProxyEnable", 0, winreg.REG_DWORD, 0)
        winreg.CloseKey(k)
        _notify_proxy_changed()
        return True
    except Exception as e:
        print("  清理代理失败：%s（用 --fixproxy 或手动去设置里关）" % e)
        return False


def _notify_proxy_changed():
    """调用 WinINet：改了注册表不喊一声，浏览器和微信是不会重读的。"""
    try:
        wininet = ctypes.WinDLL("wininet", use_last_error=True)
        INTERNET_OPTION_SETTINGS_CHANGED = 39
        INTERNET_OPTION_REFRESH = 37
        wininet.InternetSetOptionW(0, INTERNET_OPTION_SETTINGS_CHANGED, 0, 0)
        wininet.InternetSetOptionW(0, INTERNET_OPTION_REFRESH, 0, 0)
    except Exception:
        pass


# ---------------------------------------------------------------- Fiddler

def find_fiddler():
    for p in FIDDLER_CANDIDATES:
        if p.exists():
            return p
    # 兜底：注册表里的安装位置
    try:
        import winreg
        for root, sub in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Fiddler"),
                          (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Fiddler")):
            try:
                k = winreg.OpenKey(root, sub)
                loc = winreg.QueryValueEx(k, "InstallLocation")[0].strip('"')
                exe = Path(loc) / "Fiddler.exe"
                if exe.exists():
                    return exe
            except OSError:
                continue
    except Exception:
        pass
    return None


def fiddler_running():
    """🔴 绝不能用 text=True：中文 Windows 上 tasklist 吐的是 GBK，
    Python 按 UTF-8 解会在后台线程里抛 UnicodeDecodeError（拿到的还是空串）。
    直接比 bytes，谁也解不坏。"""
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Fiddler.exe", "/NH"],
                             capture_output=True, timeout=15).stdout
        return b"Fiddler.exe" in out
    except Exception:
        return False


def start_fiddler():
    exe = find_fiddler()
    if not exe:
        sys.exit("找不到 Fiddler.exe。装一个 Classic 或者改 FIDDLER_CANDIDATES。")
    if fiddler_running():
        print("  Fiddler 已在运行，直接复用")
        return True
    print("  启动 Fiddler（静默）…")
    # -quiet：不弹主窗口；Fiddler 起来后会自动把系统代理指向 8888
    subprocess.Popen([str(exe), "-quiet"], close_fds=True,
                     creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    for i in range(20):                       # 最多等 20 秒
        time.sleep(1)
        en, srv = proxy_enable()
        if en and str(PROXY_PORT) in srv:
            print("  代理已指向 %s:%d（等了 %d 秒）" % (PROXY_HOST, PROXY_PORT, i + 1))
            return True
    print("  ⚠️ Fiddler 起来了但没接管系统代理")
    return False


def stop_fiddler():
    if fiddler_running():
        subprocess.run(["taskkill", "/IM", "Fiddler.exe", "/F"],
                       capture_output=True, timeout=20)
        time.sleep(1)
    # 无论 Fiddler 怎么退的，都自己把代理按掉 —— 残留代理等于整机断网
    proxy_clear()


# ---------------------------------------------------------------- 命令

def cmd_status():
    tok = read_token_file()
    print("本机 token：%s" % ("有" if tok else "无"))
    if tok:
        exp = jwt_exp(tok)
        print("  长度 %d  sha8 %s  exp %s（%s）"
              % (len(tok), sha8(tok), fmt_ts(exp), human_left(exp)))
    st, js = read_cred()
    print("线上凭证：")
    if st != 200:
        print("  查询失败 http=%s %s" % (st, js))
    else:
        exp = js.get("expiresAt") or js.get("exp") or 0
        if exp > 1e11:                        # 🔴 毫秒（老字段）
            exp = int(exp / 1000)
        print("  写入时间 %s" % fmt_ts(int((js.get("updatedAt") or 0) / 1000)))
        print("  到期时间 %s（剩 %s）" % (fmt_ts(int(exp)), human_left(int(exp))))
        if tok and exp:
            local_exp = jwt_exp(tok)
            print("  与本机那份%s" % ("一致" if local_exp == int(exp) else "不一致（本机 %s）" % fmt_ts(local_exp)))
    en, srv = proxy_enable()
    print("系统代理：%s %s" % ("开" if en else "关", srv))


def cmd_push():
    tok = read_token_file()
    if not tok:
        sys.exit("本机没有 %s，先 --renew 抓一次。" % TOKEN_FILE)
    if len(tok) < 20:
        sys.exit("token 太短（%d），不像真的。" % len(tok))
    exp = jwt_exp(tok) or int(time.time() + 7 * 86400)
    ok, msg = verify(tok)
    print("验证：%s %s" % ("通过" if ok else "失败", msg))
    if not ok:
        sys.exit("这张 token 用不了，没上传（旧凭证原样保留）。")
    st, js = upload(tok, exp)
    print("上传：http=%s %s" % (st, js))
    if st != 200 or not js.get("ok"):
        sys.exit("上传失败，线上还是旧凭证。")
    _confirm(exp)


def _confirm(expect_exp):
    st, js = read_cred()
    exp = js.get("expiresAt") or js.get("exp") or 0
    if exp > 1e11:
        exp = int(exp / 1000)
    if st == 200 and int(exp) == int(expect_exp):
        print("回读确认：线上到期时间已经是 %s ✅" % fmt_ts(int(exp)))
        return True
    print("回读不一致：线上 %s（期望 %s）——可能 KV 有缓存，等 30 秒再看。"
          % (fmt_ts(int(exp)), fmt_ts(int(expect_exp))))
    return False


def cmd_renew(wait=None):
    global GRAB_TIMEOUT
    if wait:
        GRAB_TIMEOUT = int(wait)
    print("=" * 58)
    print("抓新凭证")
    print("=" * 58)
    before = read_token_file()
    before_sha = sha8(before) if before else ""
    before_mtime = TOKEN_FILE.stat().st_mtime if TOKEN_FILE.exists() else 0

    started_proxy = False
    try:
        en, srv = proxy_enable()
        if en and str(PROXY_PORT) not in srv:
            print("⚠️ 系统代理已经开着别的（%s），先关掉再继续，免得两套打架" % srv)
            sys.exit(1)

        if not start_fiddler():
            print("  代理没接管成功，下面这一步大概率抓不到。仍然继续，但先看日志。")
        started_proxy = True

        print()
        print("  👉 现在请你动手：在微信里打开「街电充电桩」小程序，")
        print("     进到能看到充电桩列表/详情的页面，随便点一下让它发请求。")
        print("     （%d 秒内没抓到就自动放弃，不会一直挂着）" % GRAB_TIMEOUT)
        print()

        tok = _wait_new_token(before_sha, before_mtime)
    finally:
        if started_proxy:
            print("\n收尾：关 Fiddler、恢复系统代理…")
            stop_fiddler()

    if not tok:
        probe_summary()
        sys.exit("没抓到新 token。按上面「诊断」那段处理，别硬猜。")

    exp = jwt_exp(tok) or int(time.time() + 7 * 86400)
    print("\n抓到 token：%d 字符  sha8=%s  exp=%s（%s）"
          % (len(tok), sha8(tok), fmt_ts(exp), human_left(exp)))

    ok, msg = verify(tok)
    print("验证：%s %s" % ("通过" if ok else "失败", msg))
    if not ok:
        sys.exit("这张 token 用不了（可能是游客态/别的接口的 token）。旧凭证没动。")

    st, js = upload(tok, exp)
    print("上传：http=%s %s" % (st, js))
    if st != 200 or not js.get("ok"):
        sys.exit("上传失败，线上还是旧凭证。")
    _confirm(exp)


def _wait_new_token(before_sha, before_mtime):
    """轮询 ~/.jiedian_token，等到内容真的变了为止。"""
    deadline = time.time() + GRAB_TIMEOUT
    last_note = 0
    while time.time() < deadline:
        time.sleep(2)
        if not TOKEN_FILE.exists():
            continue
        mtime = TOKEN_FILE.stat().st_mtime
        if mtime <= before_mtime:
            continue
        tok = read_token_file()
        if not tok or sha8(tok) == before_sha:
            continue
        # 等文件写完整（FiddlerScript 是 WriteAllText，一般一次到位，保险起见再等一下）
        time.sleep(0.5)
        tok2 = read_token_file()
        if tok2 != tok:
            continue
        print("  已抓到（%s），比对中…" % datetime.now().strftime("%H:%M:%S"))
        if verify_now(tok):
            return tok
        # 抓到的不对（比如游客 token），继续等下一张
        print("  这张没通过验证，继续等下一张…")
        before_sha = sha8(tok)
        before_mtime = mtime
    return ""


def verify_now(tok):
    ok, msg = verify(tok)
    print("    %s %s" % ("✓" if ok else "✗", msg))
    return ok


def probe_summary():
    """抓不到时把探针日志的结论摆出来。

    🔴 这段是给「第 N 次抓不到」准备的：没有它，你只能看到一句「没抓到」，
       分不清是「小程序没发请求」还是「发了但没带 Authorization」还是
       「微信压根不走系统代理」。三种情况的解法完全不同，所以必须先分清。
    """
    if not PROBE_FILE.exists():
        print("\n诊断：没有探针日志（%s）→ Fiddler 可能压根没起来。" % PROBE_FILE)
        return
    try:
        lines = PROBE_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception as e:
        print("\n诊断：探针日志读不了（%s）" % e)
        return
    mm = [x for x in lines if "mm=1" in x]
    zm = [x for x in lines if "zm " in x.lower()]
    print("\n诊断（探针 %d 条）：微信 UA %d 条，街电域名 %d 条" % (len(lines), len(mm), len(zm)))
    if zm:
        print("  街电域名来了 → 问题在规则判定，看有没有 auth=yes：")
        for x in zm[:5]:
            print("   ", x)
    elif mm:
        print("  微信发过请求，但没打到街电域名 → 当时不在充电桩页面（或只开了首页）。")
        print("  再试：进到桩列表/门店详情页，下拉刷新一次。")
    else:
        print("  一条微信流量都没有。两种可能：")
        print("   a) 小程序停在旧页面上没发请求 → 把它完全关掉再重开；")
        print("   b) 微信 4.2 的小程序容器不走系统代理 → PC 这条路作废，只能手机抓。")
        print("  判断方法：重开小程序后再跑一次；仍然 0 条就是 b)。")


def cmd_fixproxy():
    en, srv = proxy_enable()
    print("当前系统代理：%s %s" % ("开" if en else "关", srv))
    if en:
        proxy_clear()
        print("已关闭系统代理并通知系统刷新。")
    if fiddler_running():
        print("Fiddler 还在跑，顺手关掉…")
        subprocess.run(["taskkill", "/IM", "Fiddler.exe", "/F"], capture_output=True, timeout=20)
    print("再测一下能不能上网：")
    st, _ = api("GET", "/api/cred", headers={"x-admin-token": read_admin()})
    print("  https://chd-charge.pages.dev → http=%s %s" % (st, "通" if st else "不通"))


def main():
    ap = argparse.ArgumentParser(description="长安大学充电桩 · 凭证抓取与上传")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--status", action="store_true", help="看线上/本机凭证还剩多久")
    g.add_argument("--renew", action="store_true", help="抓一张新凭证并上传（需人点小程序）")
    g.add_argument("--push", action="store_true", help="把本机已有的 token 直接上传")
    g.add_argument("--fixproxy", action="store_true", help="代理残留导致断网时救急")
    ap.add_argument("--timeout", type=int, default=0, help="--renew 等多久（秒），默认 420")
    a = ap.parse_args()
    if a.status:
        cmd_status()
    elif a.renew:
        cmd_renew(a.timeout or None)
    elif a.push:
        cmd_push()
    elif a.fixproxy:
        cmd_fixproxy()


if __name__ == "__main__":
    main()
