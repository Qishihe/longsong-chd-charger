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
    pv_tabs = re.findall(r'class="map-tab(?:\s+on)?"\s+data-map', pv)
    ix_tabs = re.findall(r'class="map-tab(?:\s+on)?"\s+data-map', ix)
    c.check(len(pv_tabs) == 4, f"preview 有 4 个地图页签（实际 {len(pv_tabs)}）")
    c.check(len(ix_tabs) == 2, f"index 有 2 个地图页签（实际 {len(ix_tabs)}）")

    # ---------- 第 6.4 节：版本号 ----------
    cache = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
    c.check(bool(cache), "sw.js 有 CACHE 名", cache.group(1) if cache else "没找到")

    pv_v = re.search(r"map-amap\.js\?v=(\d+)", pv)
    c.check(bool(pv_v), "preview 引用 map-amap.js 带版本号",
            f'?v={pv_v.group(1)}' if pv_v else "没找到（高德页签没启用时属正常）")

    if "map-amap.js" in ix:
        ix_v = re.search(r"map-amap\.js\?v=(\d+)", ix)
        c.check(bool(ix_v), "index 引用 map-amap.js 带版本号",
                f'?v={ix_v.group(1)}' if ix_v else "引用了但没版本号")

    num = lambda s: re.search(r"v(\d+\.\d+)", s)
    a, b = num(pv_ver), num(ix_ver)
    c.check(a and b and a.group(1) == b.group(1), "两版页脚版本号一致",
            f"preview={a.group(1) if a else '?'} / index={b.group(1) if b else '?'}")

    # ---------- 站点目录保洁 ----------
    c.check(not (SITE / "versions").exists(),
            "站点目录内没有 versions/（历史快照不应公开托管）")
    stray = [f.name for f in SITE.glob("*.md")]
    c.check(not stray, "站点目录内没有 Markdown 文档", ", ".join(stray) if stray else "")

    ok = c.report()
    if args.json:
        print(json.dumps({"ok": ok, "results": c.results}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
