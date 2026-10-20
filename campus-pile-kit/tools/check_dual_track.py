# -*- coding: utf-8 -*-
"""双轨发布体检：发布前跑一遍，确认 preview.html 与 index.html 的「固定差异」没被同步时改坏。

    python tools/check_dual_track.py            # 用人看的格式输出
    python tools/check_dual_track.py --json     # 给自动化用

**只读**。它只读文件、打印结论，绝不写盘、绝不修改站点内容。
退出码：0 = 全部通过；1 = 有偏差（照着 [✗] 那几行手工改回去）。

为什么要有这个脚本：两版靠人工同步（preview 整体复制为 index，再逐点改回差异），
历史上出过「用脚本整块替换把 #go-preview 入口删掉」的事故（v1.68）。
这里把第 6.2 节的 7 处差异硬化成断言，只报告、不代劳。
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

SITE = Path(__file__).resolve().parent.parent / "chd-charge"


def read(name):
    try:
        return (SITE / name).read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


class Checker:
    def __init__(self):
        self.results = []

    def check(self, ok, label, detail=""):
        self.results.append({"ok": bool(ok), "label": label, "detail": detail})

    def report(self):
        for r in self.results:
            mark = "[✓]" if r["ok"] else "[✗]"
            line = f"{mark} {r['label']}"
            if r["detail"]:
                line += f"  —— {r['detail']}"
            print(line)
        bad = [r for r in self.results if not r["ok"]]
        print()
        if bad:
            print(f"共 {len(self.results)} 项，{len(bad)} 项不通过。修正后再发布。")
        else:
            print(f"共 {len(self.results)} 项，全部通过。")
        return len(bad) == 0


def between(text, start_pat, end_pat, flags=0):
    m = re.search(start_pat + r"([\s\S]*?)" + end_pat, text, flags)
    return m.group(1) if m else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    args = ap.parse_args()

    pv = read("preview.html")
    ix = read("index.html")
    sw = read("sw.js")
    am = read("map-amap.js")
    c = Checker()

    if not pv or not ix:
        print(f"找不到 preview.html / index.html，站点目录：{SITE}")
        return 1

    # ---------- 第 6.2 节：7 处固定差异 ----------
    pv_title = between(pv, r"<title>", r"</title>")
    ix_title = between(ix, r"<title>", r"</title>")
    c.check("测试预览版" in pv_title, "preview <title> 带「（测试预览版）」", pv_title.strip()[:60])
    c.check("测试预览版" not in ix_title, "index <title> 不带「测试预览版」", ix_title.strip()[:60])

    pv_h1 = between(pv, r"<h1[^>]*>", r"</h1>")
    ix_h1 = between(ix, r"<h1[^>]*>", r"</h1>")
    c.check("测试中" in pv_h1, "preview <h1> 带「（测试中）」", pv_h1.strip()[:60])
    c.check("测试中" not in ix_h1, "index <h1> 不带「（测试中）」", ix_h1.strip()[:60])

    def go_prev(t):
        m = re.search(r'id="go-preview"\s+href="([^"]*)"', t) or re.search(
            r'href="([^"]*)"[^>]*id="go-preview"', t)
        return m.group(1) if m else ""

    c.check(go_prev(pv) == "./", "preview #go-preview 指向正式版（./）", f'href="{go_prev(pv)}"')
    c.check(go_prev(ix) == "./preview.html", "index #go-preview 指向内测版（./preview.html）",
            f'href="{go_prev(ix)}"')

    c.check("preview-banner.js" in pv, "preview 引入 preview-banner.js")
    c.check("preview-banner.js" not in ix, "index 不引入 preview-banner.js")

    c.check('id="gate-dialog"' in pv, "preview 有密码门禁（gate-dialog）")
    c.check('id="gate-dialog"' not in ix, "index 无密码门禁")

    pv_ver = between(pv, r'id="app-ver"[^>]*>', r"</div>")
    ix_ver = between(ix, r'id="app-ver"[^>]*>', r"</div>")
    c.check("内测" in pv_ver, "preview 页脚标注「· 内测」", pv_ver.strip())
    c.check("内测" not in ix_ver, "index 页脚不标注「内测」", ix_ver.strip())

    # 注意别用 class="map-tab 前缀匹配 —— 容器是 class="map-tabs"，会多算一个
    pv_tabs = re.findall(r'class="map-tab(?:\s+on)?"\s+data-map="([a-z]+)"\s+role="tab">([^<]*)</button>', pv)
    ix_tabs = re.findall(r'class="map-tab(?:\s+on)?"\s+data-map="([a-z]+)"\s+role="tab">([^<]*)</button>', ix)
    # 2026-10-20 深夜改（产品方要求）：「高德地图」页签改名「渭水校区」，原静态总览图下线。
    # 两版页签集合从此相同（渭水校区 / 渭水-北门 / 渭水-朝晖体育场南），
    # 所以断言从「preview 4 个 / index 2 个」改成「都是 3 个，且页签完全一致」——
    # 页签属于产品结构，两版不一样才是要拦的问题（历史上内测多一张总览图）。
    c.check(len(pv_tabs) == 3, f"preview 有 3 个地图页签（实际 {len(pv_tabs)}）")
    c.check(len(ix_tabs) == 3, f"index 有 3 个地图页签（实际 {len(ix_tabs)}）")
    c.check(pv_tabs and pv_tabs == ix_tabs,
            "两版地图页签一致（id + 文案）",
            " / ".join(f"{i}:{t}" for i, t in pv_tabs) if pv_tabs else "没解析到页签")
    # 静态总览图必须彻底下线：页签按钮和 MAP_ORDER 里都不能再有 overview
    # （只查按钮 —— CSS 里还留着 `.map-dialog[data-map="overview"]` 的死规则，
    #   那是给「以后恢复总览」用的，不算违规；我第一次写宽了，被它误判过）
    c.check(not re.search(r'class="map-tab[^"]*"\s+data-map="overview"', pv),
            "preview 页签里没有已下线的总览图", "" if not re.search(r'data-map="overview"\s+role="tab"', pv) else "仍有 overview 页签")
    c.check(not re.search(r"MAP_ORDER\s*=\s*\[[^\]]*CAMPUS_MAP", pv),
            "preview MAP_ORDER 里没有 CAMPUS_MAP（总览图已下线）")

    # ---------- 第 6.4 节：版本号 ----------
    cache = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
    c.check(bool(cache), "sw.js 有 CACHE 名", cache.group(1) if cache else "没找到")

    # 只看真正会被加载的脚本，注释里提到文件名不算
    # （2026-10-20 踩过：index.html 里只在 TMAP 注释块提了一句 map-amap.js，就把这条判断骗了）
    def code_only(html):
        s = re.sub(r"/\*.*?\*/", "", html, flags=re.S)       # /* ... */ 块注释
        s = re.sub(r"^\s*//[^\n]*$", "", s, flags=re.M)      # 行首 // 单行注释
        return s

    def script_srcs(html):
        """两种加载形式都算：<script src="..."> 与 loadScriptOnce('...')"""
        s = code_only(html)
        return " ".join(
            re.findall(r'<script[^>]+src="([^"]*)"', s)
            + re.findall(r"loadScriptOnce\(\s*['\"]([^'\"]+)['\"]", s)
        )

    pv_srcs = script_srcs(pv)
    pv_v = re.search(r"map-amap\.js\?v=(\d+)", pv_srcs)
    c.check(bool(pv_v), "preview 引用 map-amap.js 带版本号",
            f'?v={pv_v.group(1)}' if pv_v else "没找到（高德页签没启用时属正常）")

    ix_srcs = script_srcs(ix)
    if "map-amap.js" in ix_srcs:
        ix_v = re.search(r"map-amap\.js\?v=(\d+)", ix_srcs)
        c.check(bool(ix_v), "index 引用 map-amap.js 带版本号",
                f'?v={ix_v.group(1)}' if ix_v else "引用了但没版本号")

    num = lambda s: re.search(r"v(\d+\.\d+)", s)
    a, b = num(pv_ver), num(ix_ver)
    c.check(bool(a and b), "两版页脚都能解析出版本号",
            f"preview={a.group(1) if a else '?'} / index={b.group(1) if b else '?'}")

    # 2026-10-20 放宽（产品方同意，见沟通记录待办 7）：
    # 原断言要求「两版版本号一致」，与交接文档 §6「改动一律先落 preview」直接冲突 ——
    # 只要发一次「仅内测版」，这条就会误报失败，逼得人要么不敢发内测、要么绕过校验。
    # 新口径：允许内测版号领先（内测 ≥ 正式），但**禁止反向** ——
    # 正式版反超内测版只可能意味着线上跑的构建没在内测版里验证过，那才是真事故。
    pv_num = tuple(int(x) for x in a.group(1).split(".")) if a else None
    ix_num = tuple(int(x) for x in b.group(1).split(".")) if b else None
    c.check(bool(pv_num and ix_num) and pv_num >= ix_num,
            "内测版版本号 ≥ 正式版（允许仅内测先发，禁止正式版反超）",
            f"preview={a.group(1) if a else '?'} / index={b.group(1) if b else '?'}")

    # ---------- 站点目录保洁 ----------
    c.check(not (SITE / "versions").exists(),
            "站点目录内没有 versions/（历史快照不应公开托管）")
    stray = [f.name for f in SITE.glob("*.md")]
    c.check(not stray, "站点目录内没有 Markdown 文档", ", ".join(stray) if stray else "")

    # 这两个是主动移出的留档件（见 campus-pile-kit/archive/README.md）。
    # 只要还躺在站点目录里，每次发布都会被重新上传一遍；而且平台发布是增量覆盖，
    # 一旦上传过就删不掉远端副本 —— 所以必须在这里卡住，别再放回去。
    for name, why in [
        ("map-tmap.js", "腾讯地图留档（TMAP_ENABLED=false，未启用）"),
        ("map-weishui.jpg", "旧版总览底图（0 处引用，340KB）"),
    ]:
        c.check(not (SITE / name).exists(),
                f"站点目录内没有 {name}",
                "" if not (SITE / name).exists() else f"应留档在 campus-pile-kit/archive/ —— {why}")

    # ---------- gzip：发布方式必须是 python + serve_gzip.py ----------
    # 平台对 language:static 默认跑 python -m http.server，不压缩，发布接口也没有压缩开关。
    # 2026-10-20 起改用自建服务器发 gzip（首屏 287KB -> 88KB）。
    # 这个文件是运行必需品，丢了会导致整站 404，所以单独立断言。
    srv = SITE / "serve_gzip.py"
    c.check(srv.exists(), "站点目录内有 serve_gzip.py（gzip 服务器）")
    if srv.exists():
        s = srv.read_text(encoding="utf-8", errors="replace")
        c.check("Content-Encoding" in s and "gzip" in s,
                "serve_gzip.py 会发 Content-Encoding: gzip")
        c.check("Vary" in s, "serve_gzip.py 带 Vary: Accept-Encoding",
                "缺了会被中间缓存把 gz 版本发给不支持的客户端")
        c.check('os.environ.get("PORT"' in s or "os.environ.get('PORT'" in s,
                "serve_gzip.py 从 PORT 环境变量取端口", "平台只暴露这一个端口")
        c.check("SELF_BLOCK" in s, "serve_gzip.py 屏蔽自身（不对外提供源码）")

    ok = c.report()
    if args.json:
        print(json.dumps({"ok": ok, "results": c.results}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
