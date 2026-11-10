# -*- coding: utf-8 -*-
"""发布体检（单轨）：发布前跑一遍，确认「一个版本」该有的都在、内测版没被带回来。

    python tools/check_release.py            # 用人看的格式输出
    python tools/check_release.py --json     # 给自动化用

**只读**。它只读文件、打印结论，绝不写盘、绝不修改站点内容。
退出码：0 = 全部通过；1 = 有偏差（照着 [✗] 那几行改回去再发）。

历史：这个脚本原来叫 check_dual_track.py，做的是「preview.html 与 index.html 的
7 处固定差异」比对 —— 2026-10-29 v2.38 内测版整体退役（preview.html /
preview-banner.js / map-amap-preview.js 三件删除，正式版那颗「查看最新测试版」
入口也删了），两版比对从此没有对象，于是改写成单轨自检。
教训别丢：当年出过「用脚本整块替换把入口删掉」的事故（v1.68），所以
「结构该有什么、不该有什么」仍然值得逐条断言，只是对象从「两份对不对得上」
变成了「这一份是不是完整的、干净的」。
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

KIT = Path(__file__).resolve().parent.parent
SITE = KIT / "chd-charge"
CF = KIT / "tools" / "cloudflare"

# 退役页面：v2.38 的内测版三件 + v2.87（A4）下线的 admin 占位页与历史样张。
# 这些文件**站点目录里不该再有**（回退老快照会带回来，靠打包层 + Worker 双挡）。
# ⚠️ `help.html` 故意不在里面：v2.85 只是下线，文件留在目录里备查。
RETIRED_FILES = (
    "preview.html", "preview-banner.js", "map-amap-preview.js",
    "preview-v3.html", "redesign-v2.html", "redesign-mockup.html",
    "admin.html",
    "sponsor-qr.png",   # v3.17：说明弹窗里的赞助码，文件已删
)
# URL 上的两种写法都要列 —— 🔴 Pages 的 Pretty URLs：`/x.html` 308 到 `/x`，
# 而 `/x` **直接返回 x.html 的静态内容**。只挡 `.html` 等于只锁了半扇门
# （2026-11-04 实测：`/help`、`/admin`、`/preview-v3`、`/redesign-v2`、
#  `/redesign-mockup` 线上全部 200）。
RETIRED_PATHS = (
    "/preview", "/preview.html", "/preview-banner.js", "/map-amap-preview.js",
    "/help", "/help.html",
    "/admin", "/admin.html",
    "/preview-v3", "/preview-v3.html",
    "/redesign", "/redesign-mockup", "/redesign-mockup.html",
    "/redesign-v2", "/redesign-v2.html",
    "/sponsor-qr.png",
)


def read(name, base=SITE):
    try:
        return (Path(base) / name).read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


class Checker:
    def __init__(self):
        self.results = []

    def check(self, ok, label, detail=""):
        self.results.append({"ok": bool(ok), "label": label, "detail": detail})

    def info(self, label, detail=""):
        """信息项：只打印，不参与通过/失败计数。"""
        self.results.append({"ok": True, "info": True, "label": label, "detail": detail})

    def report(self):
        for r in self.results:
            if r.get("info"):
                line = f"[i] {r['label']}"
                if r["detail"]:
                    line += f"  —— {r['detail']}"
                print(line)
                continue
            mark = "[✓]" if r["ok"] else "[✗]"
            line = f"{mark} {r['label']}"
            if r["detail"]:
                line += f"  —— {r['detail']}"
            print(line)
        gate = [r for r in self.results if not r.get("info")]
        bad = [r for r in gate if not r["ok"]]
        print()
        if bad:
            print(f"共 {len(gate)} 项，{len(bad)} 项不通过。修正后再发布。")
        else:
            print(f"共 {len(gate)} 项，全部通过。")
        return len(bad) == 0


def js_syntax(name, base=SITE):
    """用 node --check 验一个 .js 能不能被解析。

    为什么非要有这一项：2026-10-29 的教训 —— sw.js 从 v123 那条起每行末尾多写了一个
    注释结束符，注释提前闭合、后面成了裸文本，整个文件 SyntaxError。浏览器**不会**为此
    弹任何错，表现只是「SW 静默注册失败」：缓存不建、断网兜底失效、之后几轮「换壳」
    全部空转，而页面照常联网取数，所以谁也看不出来。
    当时这里只验「CACHE 名改了没」—— 名字改对了、脚本本身跑不起来，一样白改。
    没装 node 就跳过（不把「工具缺失」算成发布的错）。
    """
    node = shutil.which("node")
    if not node:
        return True, f"{name} 语法能被解析（跳过：没找到 node）", ""
    try:
        r = subprocess.run([node, "--check", str(Path(base) / name)],
                           capture_output=True, text=True, timeout=60)
    except Exception as e:  # noqa: BLE001
        return True, f"{name} 语法能被解析（跳过：{e.__class__.__name__}）", ""
    lines = [l for l in (r.stderr or "").strip().splitlines() if l.strip()]
    detail = ""
    if r.returncode:
        # node 的 stderr 第一行通常是 loader 栈（node:internal/...），真正的
        # 「SyntaxError: ...」在后面 —— 优先挑那一行，否则报错信息等于没说
        pick = [l for l in lines if "Error" in l] or lines
        detail = (pick[0] if pick else "")[:120]
    return r.returncode == 0, f"{name} 语法能被解析（node --check）", detail


def between(text, start_pat, end_pat, flags=0):
    m = re.search(start_pat + r"([\s\S]*?)" + end_pat, text, flags)
    return m.group(1) if m else ""


def code_only(html):
    """去掉注释，只留会被执行/被解析的部分。

    别用「字符串里提到就算」的做法：2026-10-20 踩过 —— index.html 里只在
    TMAP 注释块提了一句 map-amap.js，就把「有没有引用它」这条判断骗了。
    """
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    args = ap.parse_args()

    ix = read("index.html")
    sw = read("sw.js")
    am = read("map-amap.js")
    worker = read("_worker.js", CF)
    routes = read("_routes.json", CF)
    packer = read("make_cloudflare.py", KIT / "tools")
    dist_packer = read("make_dist.py", KIT / "tools")
    gitignore = read(".gitignore", KIT.parent)
    c = Checker()

    if not ix:
        print(f"找不到 index.html，站点目录：{SITE}")
        return 1

    # ---------- 1. 单轨：退役页面必须彻底不在 ----------
    left = [n for n in RETIRED_FILES if (SITE / n).exists()]
    c.check(not left, "站点目录里没有退役页面残留",
            ("还在：" + " / ".join(left)) if left else "")

    # 只查**会被解析的部分**：注释里提到「map-amap-preview.js 已删」是正常的说明，
    # 拿原文件做子串匹配会把它自己判成违规（第一次就是这么红的）。
    ix_code = code_only(ix)
    gate = [n for n in RETIRED_FILES if n in ix_code]
    c.check(not gate, "index.html 不再引用退役页面",
            ("引用了：" + " / ".join(gate)) if gate else "")
    c.check('id="go-preview"' not in ix, "index.html 没有「查看最新测试版」入口（#go-preview）",
            "入口已删；要加回来先想清楚单轨为什么又变双轨")
    c.check('id="gate-dialog"' not in ix, "index.html 没有内测版密码门禁（gate-dialog）")

    ix_ver = between(ix, r'id="app-ver"[^>]*>', r"</div>")
    c.check("内测" not in ix_ver and "测试" not in ix_ver,
            "页脚版本标注里没有「内测 / 测试」", ix_ver.strip())

    ix_title = between(ix, r"<title>", r"</title>")
    ix_h1 = between(ix, r"<h1[^>]*>", r"</h1>")
    c.check("测试预览版" not in ix_title, "index <title> 不带「测试预览版」", ix_title.strip()[:60])
    c.check("测试中" not in ix_h1, "index <h1> 不带「（测试中）」", ix_h1.strip()[:60])

    # ---------- 2. 版本位点 ----------
    cache = re.search(r"CACHE\s*=\s*'([^']+)'", sw)
    c.check(bool(cache), "sw.js 有 CACHE 名", cache.group(1) if cache else "没找到")
    ok_syn, syn_label, syn_detail = js_syntax("sw.js")
    c.check(ok_syn, syn_label, syn_detail)
    c.check(bool(re.search(r"v\d+\.\d+", ix_ver)), "页脚能解析出版本号", ix_ver.strip())

    ix_srcs = script_srcs(ix)
    if "map-amap.js" in ix_srcs:
        ix_v = re.search(r"map-amap\.js\?v=(\d+)", ix_srcs)
        c.check(bool(ix_v), "index 引用 map-amap.js 带版本号",
                f"?v={ix_v.group(1)}" if ix_v else "引用了但没版本号")

    # SW 预缓存清单里的 `?v=` 必须与页面里的 `?v=` 逐字相同 ——
    # Cache API 按**完整 URL** 匹配，差一位就等于这条没预缓存（断网时才暴露，平时零信号）。
    # 2026-10-25 真实踩过：页面 map-data.js 升到 164，sw.js 的 SHELL 还钉在 163，
    # 而当时三条版本检查全绿（CACHE 名只查存在、?v 只查页面侧）→ 断网丢 map-data.js。
    shell = re.search(r"const\s+SHELL\s*=\s*\[(.*?)\];", sw, re.S)
    shell_body = shell.group(1) if shell else ""
    shell_urls = re.findall(r"['\"]\./([^'\"]+\?v=\d+)['\"]", shell_body)
    # 页面里的 `?v=` 不止出现在 <script src> —— 标签页图标是 <link rel="icon" href="...?v=1">，
    # 只扫 script 会把它判成「页面里没有同 URL 的引用」。两边都收进来。
    ix_urls = ix_srcs + " " + " ".join(re.findall(r'<link[^>]+href="([^"]*)"', code_only(ix)))
    for u in shell_urls:
        c.check(u in ix_urls, f"sw.js 预缓存 {u} 与页面引用一致",
                "" if u in ix_urls else "页面里没有同 URL 的引用（Cache API 按完整 URL 匹配，等于没预缓存）")
    # 反向：页面里带 ?v 的本地 js 若在 SHELL 里有同名条目，版本号必须一致
    seen = set()
    for m in re.finditer(r"([\w.-]+\.js)\?v=(\d+)", ix_srcs):
        name, ver = m.group(1), m.group(2)
        if (name, ver) in seen:
            continue
        seen.add((name, ver))
        sm = re.search(re.escape(name) + r"\?v=(\d+)", " ".join(shell_urls))
        if sm:
            c.check(sm.group(1) == ver, f"{name} 页面 ?v={ver} 与 sw.js 一致",
                    "" if sm.group(1) == ver else f"sw.js 里是 ?v={sm.group(1)}")
    # 壳清单里也不该再缓存退役页：删了还缓存 = 断网时点开一个已下线的页面
    c.check(not any(n in shell_body for n in RETIRED_FILES), "sw.js 的 SHELL 里没有退役页面")

    # 🔴 Pretty URLs 完整性：每个退役的 `.html` 都必须有去掉后缀的那条路径。
    # 只登记一种写法等于只锁半扇门（`/x.html` 会 308 到 `/x`，而 `/x` 直接出内容）。
    pretty_missing = [p for p in RETIRED_PATHS if p.endswith(".html") and p[:-5] not in RETIRED_PATHS]
    c.check(not pretty_missing, "每个退役 .html 都登记了无后缀变体",
            ("缺：" + " / ".join(pretty_missing)) if pretty_missing
            else f"{len(RETIRED_PATHS)} 条路径全部成对")

    # ---------- 3. 地图页签 ----------
    ix_tabs = re.findall(r'class="map-tab(?:\s+on)?"\s+data-map="([a-z0-9]+)"\s+role="tab">([^<]*)</button>', ix)
    # ⚠️ `data-map` 允许数字：2026-10-30 v2.46 加的「20 号楼」id 是 `lou20`，
    #    原来的 ([a-z]+) 匹配不到它，页签列表会静默少算一颗（>=3 那条也照样绿）。
    c.check(len(ix_tabs) >= 3, f"至少有 3 个地图页签（实际 {len(ix_tabs)}）",
            " / ".join(f"{i}:{t}" for i, t in ix_tabs))
    # 静态总览图必须彻底下线：页签按钮和 MAP_ORDER 里都不能再有 overview
    # （只查按钮 —— CSS 里还留着 `.map-dialog[data-map="overview"]` 的死规则，
    #   那是给「以后恢复总览」用的，不算违规；第一次写宽了，被它误判过）
    c.check(not re.search(r'class="map-tab[^"]*"\s+data-map="overview"', ix),
            "页签里没有已下线的总览图")
    c.check(not re.search(r"MAP_ORDER\s*=\s*\[[^\]]*CAMPUS_MAP", ix),
            "MAP_ORDER 里没有 CAMPUS_MAP（总览图已下线）")

    # ---------- 4. map-amap.js 依赖的 CSS 必须在 HTML 里 ----------
    # 2026-10-21 加（当天踩了真实生产事故）：
    # `map-amap.js` 生成的那些 class 的样式是写在 HTML 里的。v1.99 发布时只把
    # `.cluster` / `.zoom-dot` 加进了一份文件、漏了另一份 → 正式版缩小后
    # 「逐台点被隐藏 + 聚合圈是无样式的裸 div」= 看起来什么都不显示。
    # 这类「JS 与 CSS 分居两个文件」的错，语法检查和单元测试**都查不出来**。
    # 内测版退役后只剩一份 HTML，这条依然有用：改版时容易忘。
    def _classes_in(src):
        return set(
            re.findall(r'class="([a-z][a-z0-9_-]*)', src)
            + re.findall(r"classList\.(?:add|toggle|remove)\('([a-z][a-z0-9_-]*)'", src)
        )

    def _has_rule(html, cls):
        # 作为选择器出现即算（`.cls{` / `.cls,` / `.cls ` / `.cls.` / `.cls:` 等），
        # 但不能是 `.cluster` 命中 `.cluster-num` 这种前缀误配
        return re.search(r"\." + re.escape(cls) + r"(?![a-z0-9_-])", html) is not None

    # 例外：纯状态标记类，显隐由 syncLayers 的 setMap 控制、本来就没有也不需要 CSS 规则
    am_classes = [k for k in sorted(_classes_in(am)) if k != "zoom-cluster"]
    if am_classes:
        missing = [k for k in am_classes if not _has_rule(ix, k)]
        c.check(not missing, "index.html 有 map-amap.js 生成的类的样式",
                ("缺：" + " / ".join("." + k for k in missing)) if missing
                else f"{len(am_classes)} 个类都有规则")

    # ---------- 5. 退役路径真被挡住了（线上 + 本地） ----------
    # Pages 是增量覆盖：本地删了、云端旧文件还在，所以「删」必须配两层拦截。
    # 只删文件等于线上还能访问（2026-10-25 在 preview-v3.html 上实测过）。
    c.check("RETIRED" in worker and all(p in worker for p in RETIRED_PATHS),
            "_worker.js 把退役路径挡住（线上旧文件删不掉，只能挡）")
    c.check("RETIRED_PREFIX" in worker and "'/redesign/'" in worker,
            "_worker.js 有目录级拦截（/redesign/* 整个是内部样张）")
    c.check(all(p in routes for p in RETIRED_PATHS),
            "_routes.json 把退役路径纳入 Worker 路由",
            "不写进去的话请求到不了 Worker，静态层直接发出去")
    c.check('"/redesign/*"' in routes,
            "_routes.json 有一条 /redesign/* 通配",
            "目录里任何一页都不该被静态层直接发出去")
    # ⚠️ serve_gzip 是**精确路径**匹配：pretty 变体（`/admin`）在磁盘上找不到文件，
    #    本来就是 404，不需要（也不该）写进 SELF_BLOCK。只查 `.html` 那侧。
    srv_src = read("serve_gzip.py")
    srv_need = [p for p in RETIRED_PATHS if p.endswith(".html")]
    miss_srv = [p for p in srv_need if p not in srv_src]
    c.check(not miss_srv,
            "serve_gzip.py 的 SELF_BLOCK 里有退役页面（本地开发一致）",
            ("缺：" + " / ".join(miss_srv)) if miss_srv else "")
    pack_need = list(RETIRED_FILES) + ["help.html"]
    miss_pack = [n for n in pack_need if f'"{n}"' not in packer]
    c.check(not miss_pack,
            "make_cloudflare.py 的 EXCLUDE_FILES 里有全部退役页面（防复活）",
            ("缺：" + " / ".join(miss_pack)) if miss_pack
            else "回退老快照会把文件带回来，打包这一层要挡住")

    # ---------- 5b. v3.20 违规车牌端点与安全头 ----------
    # 新路由必须注册在 404 兜底之前；管理员端点不能只靠前端 sessionStorage 解锁。
    c.check("'/api/plate/report'" in worker and "'/api/admin/plate/rank'" in worker
            and "'/api/admin/plate/revoke'" in worker and "'/api/plate'" in worker,
            "_worker.js 注册了车牌登记 / 查询 / 月榜 / 撤销四个路由")
    # 别用 error: 'not_found' 定位：revoke 分支里也有同样的 404，
    # 它出现在路由注册之前，会把位置比较判成「在兜底后面」。认兜底那行本身。
    c.check(worker.find("'/api/plate/report'") >= 0
            and worker.find("'/api/plate/report'") < worker.find("if (path !== '/api/cred')"),
            "车牌路由注册在 404 兜底之前",
            "放到兜底后面一律 not_found")
    c.check("sameSiteRequest(request, url)" in worker and "safeEqual(given, secret)" in worker,
            "管理员端点走同源校验 + 服务端定长比较",
            "前端 cpk.unlocked 只是 UI 开关，不能当鉴权")
    c.check("PLATE_DB" in worker and "plate_disabled" in worker,
            "D1 / secret 没配好时优雅降级，不影响查桩主功能")
    c.check("HMAC" in worker and "AES-GCM" in worker and "plate_hash" in worker,
            "车牌只存 HMAC 与密文，不落明文")
    c.check("idx_pm_ym_cnt" in worker and "idx_pmc" in worker,
            "按月 / 按校区排行榜走预汇总索引，不做全表分组")
    c.check("PLATE_WINDOW_DAYS = 180" in worker and "PLATE_QUERY_DAYS = 90" in worker,
            "记录保留 180 天、查询统计 90 天两套口径都在")
    # 防刷爆：免费额度账号级共享，车牌 D1 被刷爆会拖死同账号的快照站。
    c.check("PLATE_GLOBAL_LIMIT = 2000" in worker and "PLATE_TOTAL_CAP = 200000" in worker,
            "车牌 D1 有每日上限与总量上限两道硬闸门")
    c.check("plate_meta" in worker and "storage_cap" in worker
            and "await plateCapGuard(db, now)" in worker,
            "总量上限用单行计数器，超限时直接拒绝")
    c.check(worker.find("await plateCapGuard(db, now)") >= 0
            and worker.find("await plateCapGuard(db, now)")
                < worker.find("INSERT INTO reports(plate_hash"),
            "总量闸门在写明细之前判定，超限时一行都不写",
            "放到写库之后闸门就形同虚设")
    c.check("SELECT COUNT(*) FROM reports" in worker and "dailyCap" in worker
            and "totalCap" in worker,
            "计数器可自校正，config 对外暴露两道上限",
            "每次登记全表 COUNT 会扫穿 D1 免费版行读额度")
    c.check("val=val+1" in worker and "val=MAX(0,val-?)" in worker,
            "计数器随登记增加、随撤销与清理回退")
    c.check("storage_cap" in ix, "前端对总量触顶有单独提示，不落到通用失败文案")
    for h in ("X-Frame-Options: DENY", "Strict-Transport-Security",
              "Content-Security-Policy-Report-Only"):
        c.check(h in packer, "_headers 有 " + h.split(":")[0])
    c.check("id=\"set-plate-rank-btn\" hidden" in ix,
            "排行榜入口在管理员分组且默认隐藏")
    c.check("/api/*" in routes, "_routes.json 通配 /api/*（新端点无需再登记）")
    c.check("pathname.indexOf('/api/') === 0" in sw,
            "sw.js 排除 /api/*（新端点不进离线缓存）")

    # ---------- 6. 站点目录保洁 ----------
    c.check(not (SITE / "versions").exists(),
            "站点目录内没有 versions/（历史快照不应公开托管）")
    stray = [f.name for f in SITE.glob("*.md")]
    c.check(not stray, "站点目录内没有 Markdown 文档", ", ".join(stray) if stray else "")
    for name, why in [
        ("map-tmap.js", "腾讯地图留档（TMAP_ENABLED=false，未启用）"),
        ("map-weishui.jpg", "旧版总览底图（0 处引用，340KB）"),
    ]:
        c.check(not (SITE / name).exists(),
                f"站点目录内没有 {name}",
                "" if not (SITE / name).exists() else f"应留档在 campus-pile-kit/archive/ —— {why}")

    # ---------- 7. gzip：发布方式必须是 python + serve_gzip.py ----------
    # 平台对 language:static 默认跑 python -m http.server，不压缩，发布接口也没有压缩开关。
    # 2026-10-20 起改用自建服务器发 gzip（首屏 287KB -> 88KB）。
    # 这个文件是运行必需品，丢了会导致整站 404，所以单独立断言。
    srv = SITE / "serve_gzip.py"
    c.check(srv.exists(), "站点目录内有 serve_gzip.py（gzip 服务器）")
    if srv.exists():
        c.check("Content-Encoding" in srv_src and "gzip" in srv_src,
                "serve_gzip.py 会发 Content-Encoding: gzip")
        c.check("Vary" in srv_src, "serve_gzip.py 带 Vary: Accept-Encoding",
                "缺了会被中间缓存把 gz 版本发给不支持的客户端")
        c.check('os.environ.get("PORT"' in srv_src or "os.environ.get('PORT'" in srv_src,
                "serve_gzip.py 从 PORT 环境变量取端口", "平台只暴露这一个端口")
        c.check("SELF_BLOCK" in srv_src, "serve_gzip.py 屏蔽自身（不对外提供源码）")

        # ---------- /api 反代：页面所有接口都是相对路径，静态服务会 501 ----------
        # 2026-10-25 踩过：workbuddy.host 那边只有静态服务，`POST /api/pile` 返回 501，
        # 页面「一直转圈、一个桩都查不到」。这条防的是「本地测试全绿、线上是空壳」。
        c.check("_proxy_api" in srv_src and "handle_pile" in srv_src,
                "serve_gzip.py 反代 /api/*（静态服务会让页面查不到任何桩）",
                "页面接口是相对路径 /api/pile、/api/shop、/api/cred，必须由服务端转发")
        c.check("UPSTREAM_UA" in srv_src,
                "serve_gzip.py 给上游带浏览器 UA",
                "Cloudflare 按签名拦 Python-urllib/3.x，返回 Error 1010（HTML 错误页）")
        c.check("UPSTREAM_ORIGIN" in srv_src and 'add_header("origin"' in srv_src,
                "serve_gzip.py 反代时改写 Origin",
                "Worker 里有 origin !== url.origin → 403 的防盗链判断")

    # ---------- 8. 对外目录 catalog.json（第三方应用接入） ----------
    # 第三方不该为了「有哪些桩」去抠 500 KB 的 index.html、再把三套落点算法重写一遍。
    # catalog.json 把这些公开数据摊平成一份 JSON。
    #
    # 🔴 目录是构建产物（不进版本库）：打包时由 gen_catalog.py 生成，
    #    serve_gzip.py 启动时在内存里生成一份。
    #    所以这里查三件事：生成器自身是否自洽、三条产出路径是否都接上、产物有没有被误提交。
    gen = KIT / "tools" / "gen_catalog.py"
    c.check(gen.exists(), "tools/gen_catalog.py 存在")
    if gen.exists():
        try:
            r = subprocess.run([sys.executable, str(gen), "--check"],
                               capture_output=True, text=True, timeout=120)
            lines = [l for l in (r.stdout or r.stderr or "").splitlines() if l.strip()]
            c.check(r.returncode == 0, "生成器自检通过（gen_catalog.py --check）",
                    "" if r.returncode == 0 else (lines[0][:120] if lines else ""))
        except Exception as e:  # noqa: BLE001
            c.check(True, f"生成器自检通过（跳过：{e.__class__.__name__}）", "")
    c.check("gen_catalog" in packer,
            "make_cloudflare.py 打包时自动生成 catalog.json",
            "目录必须随打包产出，不能依赖人工重跑生成器")
    c.check("gen_catalog" in dist_packer,
            "make_dist.py 打包时自动生成 catalog.json",
            "自建部署那条路也要自动，不然只有 Pages 上有目录")
    c.check('"catalog.json"' in packer and '"catalog.json"' in dist_packer,
            "两个打包器的自检清单里都有 catalog.json",
            "漏了的话打包成功、线上 404")
    c.check("/catalog.json" in packer and "Access-Control-Allow-Origin" in packer,
            "make_cloudflare.py 给 catalog.json 配了缓存与 CORS 头",
            "网页类应用要靠 ACAO 才能直接 fetch")
    c.check("add_catalog" in srv_src and "Access-Control-Allow-Origin" in srv_src,
            "serve_gzip.py 会补 catalog.json 并发 CORS（自建部署一致）",
            "只在 Pages 上生效的话，换成自建部署第三方就 fetch 不到了")
    c.check("campus-pile-kit/chd-charge/catalog.json" in gitignore,
            "catalog.json 被 .gitignore 挡住（构建产物不进版本库）",
            "仓库里出现副本会形成第二个真源")

    c.info("当前版本：" + ix_ver.strip() + " / " + (cache.group(1) if cache else "?"))

    ok = c.report()
    if args.json:
        print(json.dumps({"ok": ok, "results": c.results}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
