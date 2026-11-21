#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 Cloudflare Pages 专用部署包。

    python tools/make_cloudflare.py

产物（都不进 git）：
    campus-pile-kit/dist-cloudflare/      站点根目录，可直接拖拽上传
    campus-pile-kit/dist-cloudflare.zip   zip 顶层即站点根（CF 拖拽上传要求）

和 dist-chd-charge/ 的区别：
  1. 剔除内部产物（redesign 样张、v3 原型、serve_gzip.py）—— 公网不需要
  2. zip **不套 chd-charge/ 这一层**。Cloudflare 拖拽 zip 时顶层结构就是站点根，
     多一层目录会导致 /chd-charge/index.html，根路径 404。
  3. 多一个 `_headers`：Cloudflare Pages 的响应头规则文件（本身不会被发布）。
  4. 多两个 `tools/cloudflare/` 里的文件：
       `_worker.js`    —— 高级模式 Worker，只处理 /api/cred（凭证信箱，读写走 KV）
       `_routes.json`  —— 限定只有 /api/* 进 Worker，静态文件完全不耗 Functions 额度
     这两个依赖控制台的 KV 绑定（CHD_CRED）与加密变量（ADMIN_TOKEN），没配时
     静态站照常工作，只是 /api/* 返回 501。`tools/cloudflare/` 为空则跳过。

⚠️ `dist-chd-charge/` 那份是给「拷给别人自己架服务器」用的，保留全量，两者不要混。

产物瘦身（`--full` 可关掉）：
    index.html / guide.html 和三个站点 JS 在**复制进 dist 时**剥掉注释、压掉空白，
    `chd-charge/` 源码一个字不动。注释是写给维护者的，不该让每个访客下载一遍
    （实测 index.html 里 36%、sw.js 里 88% 是注释）。
    JS 交给 esbuild（真解析器，URL 里的 `//`、正则里的 `/*` 都不会误伤），
    CSS 用自写扫描器（跳过引号内内容），HTML 只删 `<!-- -->`、不动空白。
    esbuild 找不到或压缩失败时**原样拷贝**——宁可产物胖，不可线上坏。
"""
import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
SITE = KIT / "chd-charge"
DIST = KIT / "dist-cloudflare"
ZIP = KIT / "dist-cloudflare.zip"
CF_EXTRA = KIT / "tools" / "cloudflare"   # _worker.js / _routes.json（可选）

# ---- 产物瘦身名单 ----
# 只处理「注释占比高、又是首屏必下」的文件。判断依据是实测：
#   index.html   850 KB，36% 是注释（约 300 KB），全站首屏都靠它
#   sw.js         44 KB，88% 是注释，而且每次访问都要校验一次
#   map-amap.js  104 KB，38% 是注释，地图一打开就加载
#   map-data.js   39 KB，0% 注释，但空白很多，顺手一起压
# 🔴 故意不碰：
#   _worker.js —— 后端逻辑，注释不影响运行，改它只有风险没有收益
#   ocr/ sdk/  —— wasm 与第三方 SDK，注释占比 0，压了也省不出东西
MINIFY_JS = {"map-amap.js", "map-data.js", "sw.js"}

# 公网站点不需要的内部产物
EXCLUDE_FILES = {
    "serve_gzip.py",        # CF 自己 gzip/brotli，这个只用标准库，平台跑不起来
    "redesign-mockup.html", # 改版样张
    "redesign-v2.html",     # 改版样张
    "preview-v3.html",      # v3 原型（266KB，未定稿，不该公网暴露）
    # 2026-10-29 v2.38：内测版退役，文件已删。留在这里是**防复活**——
    # 万一从 git 里 checkout 回来（回退老快照会带回来），打包这一层就挡住，不再往公网发。
    "preview.html",
    "preview-banner.js",
    "map-amap-preview.js",
    # 2026-11-03 v2.85：抓凭证教程页下线（弹窗里那句「第一次弄？看教程」也删了）。
    # 文件留在 chd-charge/ 里备查，打包这层挡住，别再发出去。
    "help.html",
    # 2026-11-04 v2.87（A4）：凭证上传占位页下线，文件已从站点目录删除。
    # 留在这里是**防复活** —— 回退老快照会把它带回来，打包这层先挡住。
    "admin.html",
    # 对外设备目录是构建产物（不进版本库），打包时现生成，见 _write_catalog
    "catalog.json",
    # 2026-11-08 v3.17：赞助二维码从使用说明里撤掉，文件也从站点目录删除。
    # 留在这里是防复活 —— 回退老快照会把它带回来，打包这层先挡住。
    "sponsor-qr.png",
}
EXCLUDE_DIRS = {"redesign"}

HEADERS = """\
# Cloudflare Pages 响应头规则（本文件本身不会被发布）
# 语法：路径行 + 缩进的 Header 行

# Service Worker 必须每次回源校验，否则发新版用户拿不到
/sw.js
  Cache-Control: no-cache

# 入口 HTML 走协商缓存，避免用户看到旧版本
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache

# 独立说明页（2026-11-10 v3.20.1）：内容随功能变化，和首页一样走协商缓存，
# 免得改了说明用户还看到旧版。`/guide` 是 Pages 的 pretty URL，两条都要写。
/guide
  Cache-Control: no-cache
/guide.html
  Cache-Control: no-cache

# 高德 Key 文件短缓存（换 Key 后最多 5 分钟生效）
/map-key.local.js
  Cache-Control: max-age=300

# 对外设备目录（第三方应用接入用，见 docs/API.md）
# 内容只在站点改版时变，5 分钟缓存足够；ACAO 放开是为了让网页类应用也能直接 fetch
/catalog.json
  Cache-Control: public, max-age=300
  Access-Control-Allow-Origin: *

# README 配图（仓库根 README.md 用绝对地址引用本站，见 img/ 目录）
# 为什么不走 GitHub 自己的图片代理：camo.githubusercontent.com 国内基本打不开，
# README 里的图在网页上全是破图。挂在自己的域名下，能打开本站就能看到图。
# 图很少变，一天缓存；换图时改文件名（带版本号）比刷 CDN 靠谱。
/img/*
  Cache-Control: public, max-age=86400

# 识图引擎（v3.15）：核心 wasm 4MB + 中文语言包 1.7MB，只有点「导入」选图片时才下载。
# 这几个文件随 tesseract 版本固定，缓存一周；升级引擎时换文件名，别指望刷缓存。
/ocr/*
  Cache-Control: public, max-age=604800

# 安全响应头（2026-11-10 v3.20 补齐）。原来只有 nosniff + 宽松 Referrer-Policy。
# 🔴 CSP 特意用 Report-Only：页面里有大量内联脚本与高德 / 识图 / 扫码等外链，
#    直接上强制 CSP 会白屏（这个项目被注释吞规则坑过好几次）。先只收集、不阻断，
#    等把外链清单逐条核完再换成 Content-Security-Policy。
# ⚠️ Pages 高级模式下 _headers 只作用于静态资源；/api/* 由 _worker.js 自己加头。
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Permissions-Policy: camera=(self), microphone=(), geolocation=(self)
  Content-Security-Policy-Report-Only: default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https:; connect-src 'self' https:; font-src 'self' data:
"""


def _find_esbuild():
    """找可用的 esbuild，返回命令前缀；找不到返回 None。

    为什么不用 `node_modules/.bin/esbuild`：Windows 上那是个 sh 脚本，
    subprocess 直接 CreateProcess 会失败（只有 Git Bash 认得 shebang）。
    优先用 npm 装出来的原生二进制，退而用 node 跑包里的 JS 入口。
    """
    nm = KIT / "scratch" / "_cli" / "node_modules"
    for p in sorted(nm.glob("@esbuild/*/esbuild*")):
        if p.is_file() and p.name in ("esbuild", "esbuild.exe") and p.stat().st_size > 100_000:
            return [str(p)]
    js = nm / "esbuild" / "bin" / "esbuild"
    node = shutil.which("node")
    if js.exists() and node:
        return [node, str(js)]
    exe = shutil.which("esbuild")
    return [exe] if exe else None


def _minify_js(code, cmd):
    """去掉 JS 注释与多余空白。失败时原样返回 —— 宁可胖，不可坏。"""
    if not cmd:
        return code, False
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.js"
        out = Path(td) / "out.js"
        src.write_text(code, encoding="utf-8", newline="\n")
        try:
            r = subprocess.run(cmd + [str(src), "--minify-whitespace",
                                      "--target=esnext", "--charset=utf8",
                                      "--outfile=" + str(out)],
                               capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            return code, False
        if r.returncode != 0 or not out.exists():
            return code, False
        return out.read_text(encoding="utf-8"), True


def _strip_css(css):
    """去 CSS 注释并压空白。

    自己扫一遍而不是直接上正则：`content:"/*"` 这类字符串里的符号
    必须原样保留，`/*` 先被当成注释吃掉的话整段 CSS 就崩了 ——
    这个项目被注释吞规则坑过好几次，宁可多写十行。
    """
    out, i, n = [], 0, len(css)
    while i < n:
        c = css[i]
        if c == "/" and i + 1 < n and css[i + 1] == "*":
            j = css.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "\"'":
            j = i + 1
            while j < n:
                if css[j] == "\\":
                    j += 2
                    continue
                if css[j] == c:
                    j += 1
                    break
                j += 1
            out.append(css[i:j])
            i = j
            continue
        out.append(c)
        i += 1
    s = re.sub(r"\s+", " ", "".join(out))
    s = re.sub(r"\s*([{};])\s*", r"\1", s)
    return s.strip()


def _strip_html_comments(html):
    """只删 `<!-- -->`，不动任何空白 —— HTML 里的空白会影响行内排版。"""
    return re.sub(r"<!--(?!\[if)[\s\S]*?-->", "", html)


inline_block = re.compile(r"<(script|style)\b([^>]*)>([\s\S]*?)</\1>", re.I)


def _minify_html(text, cmd):
    """逐块处理：script 走 esbuild、style 走自写扫描器、其余只删 HTML 注释。"""
    parts, pos, js_ok = [], 0, 0
    for m in inline_block.finditer(text):
        parts.append(_strip_html_comments(text[pos:m.start()]))
        tag, attrs, body = m.group(1), m.group(2), m.group(3)
        if tag.lower() == "script":
            # 外链脚本和 ld+json 数据块原样保留
            if re.search(r"\bsrc\s*=", attrs, re.I) or "ld+json" in attrs:
                new = body
            else:
                new, done = _minify_js(body, cmd)
                js_ok += 1 if done else 0
        else:
            new = _strip_css(body)
        parts.append("<%s%s>%s</%s>" % (tag, attrs, new, tag))
        pos = m.end()
    parts.append(_strip_html_comments(text[pos:]))
    return "".join(parts), js_ok


def _inject(text):
    """公开源码里的设备占位符 → 真实编号、演示坐标偏移归零。

    真值在 `private/devices.private.json`（不入库）。**必须在压缩之前**做：
    esbuild 会把 IIFE 里的 `var GEO_SHIFT` 改名，压完就找不到锚点了。
    """
    sys.path.insert(0, str(KIT / "tools"))
    import inject_private
    return inject_private.inject_text(text)


def _write_catalog(dest):
    """对外设备目录是构建产物：打包时由 gen_catalog.py 生成。

    目录只存在于产物里，改完 DEFAULT_DEVICES 直接打包即可。
    """
    sys.path.insert(0, str(KIT / "tools"))
    import gen_catalog
    data, text = gen_catalog.generate(dest)
    # gen_catalog 解析的是公开源码，id 是 PILE 占位符 —— 落盘后补一次注入
    if dest.exists():
        injected = _inject(dest.read_text(encoding="utf-8", newline=""))
        if injected != dest.read_text(encoding="utf-8", newline=""):
            dest.write_text(injected, encoding="utf-8", newline="")
            text = injected
    print("目录：catalog.json %d 个分区 / %d 台 / %d B"
          % (len(data["areas"]), data["total"], len(text.encode("utf-8"))))


def main(argv=None):
    ap = argparse.ArgumentParser(description="生成 Cloudflare Pages 部署包")
    ap.add_argument("--full", action="store_true",
                    help="不压缩，原样拷贝（排查线上问题时用，产物与源码逐字节一致）")
    args = ap.parse_args(argv)

    if not (SITE / "index.html").exists():
        print(f"x 找不到站点源目录：{SITE}", file=sys.stderr)
        return 2

    cmd = None if args.full else _find_esbuild()
    if not args.full and not cmd:
        print("! 没找到 esbuild，JS 注释保留（HTML 注释与 CSS 注释照常剥离）",
              file=sys.stderr)

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    kept, skipped, shrunk = [], [], []
    for f in sorted(SITE.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(SITE)
        if rel.name in EXCLUDE_FILES or set(rel.parts) & EXCLUDE_DIRS:
            skipped.append(rel.as_posix())
            continue
        dst = DIST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        # 文本文件先注入（占位符 → 真值），二进制原样拷贝
        try:
            raw = f.read_text(encoding="utf-8", newline="")
        except (UnicodeDecodeError, OSError):
            raw = None
        if raw is not None:
            raw = _inject(raw)
        if args.full:
            if raw is not None:
                dst.write_text(raw, encoding="utf-8", newline="")
            else:
                shutil.copy2(f, dst)
        elif rel.suffix.lower() == ".html":
            out, _ = _minify_html(raw, cmd)
            dst.write_text(out, encoding="utf-8", newline="")
            shrunk.append((rel.as_posix(), len(raw.encode("utf-8")),
                           len(out.encode("utf-8"))))
        elif rel.name in MINIFY_JS:
            out, done = _minify_js(raw, cmd)
            if not done:
                # esbuild 没跑成：退回注入后的原文，别拿半成品上线
                dst.write_text(raw, encoding="utf-8", newline="")
            else:
                dst.write_text(out, encoding="utf-8", newline="")
                shrunk.append((rel.as_posix(), len(raw.encode("utf-8")),
                               len(out.encode("utf-8"))))
        else:
            if raw is not None:
                dst.write_text(raw, encoding="utf-8", newline="")
            else:
                shutil.copy2(f, dst)
        kept.append(rel.as_posix())

    # 对外设备目录（构建产物，打包时现生成，不从站点目录复制）
    _write_catalog(DIST / "catalog.json")

    # _headers 用 LF 写入（Windows 默认 CRLF 会让 CF 解析异常）
    (DIST / "_headers").write_text(HEADERS, encoding="utf-8", newline="\n")

    # Worker 与路由规则（可选）：只在 tools/cloudflare/ 存在时带
    worker_files = []
    if CF_EXTRA.exists():
        for name in ("_worker.js", "_routes.json"):
            src = CF_EXTRA / name
            if not src.exists():
                print(f"x 缺 {src}", file=sys.stderr)
                return 5
            dst = DIST / name
            # JS 用 LF；JSON 也统一 LF
            dst.write_bytes(src.read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8"))
            worker_files.append(name)
        print(f"Worker：{' + '.join(worker_files)} +（路由：/api/* + 已退役的内测版路径）")

    raw = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"目录：{len(kept)} 个站点文件 + _headers → {DIST}（{raw:,} B）")
    for s in skipped:
        print(f"  剔除 {s}")

    if shrunk:
        import gzip
        before = sum(b for _, b, _ in shrunk)
        after = sum(a for _, _, a in shrunk)
        print(f"瘦身：{len(shrunk)} 个文件 {before:,} → {after:,} B"
              f"（省 {before - after:,} B / {100 * (before - after) / before:.0f}%）")
        for name, b, a in shrunk:
            try:
                gb = len(gzip.compress((SITE / name).read_bytes(), 9))
                ga = len(gzip.compress((DIST / name).read_bytes(), 9))
                gz = f"，gzip {gb:,} → {ga:,} B（{100 * (ga - gb) / gb:+.0f}%）"
            except OSError:
                gz = ""
            print(f"  {name:<14} {b:>8,} → {a:>8,} B{gz}")

    # 自检：少一个就跑不起来的东西
    must = ["index.html", "map-amap.js", "map-data.js",
            "map-key.local.js", "sw.js", "catalog.json", "_headers"] + worker_files
    missing = [m for m in must if not (DIST / m).exists()]
    if missing:
        print(f"x 缺关键文件：{missing}", file=sys.stderr)
        return 3
    print("自检：关键文件齐 +")

    if ZIP.exists():
        ZIP.unlink()
    # 关键：arcname 直接用相对路径，不套目录前缀
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(DIST.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(DIST))
    zsize = ZIP.stat().st_size
    print(f"压缩：{zsize:,} B → {ZIP}")

    # 自检：zip 顶层必须是文件，不能是单一目录
    with zipfile.ZipFile(ZIP) as z:
        tops = {n.split("/")[0] for n in z.namelist()}
        if len(tops) == 1 and all("/" in n for n in z.namelist() if not n.endswith("/")):
            print(f"x zip 顶层套了一层目录（{tops}）→ Cloudflare 上传后根路径会 404",
                  file=sys.stderr)
            return 4
        print(f"自检：zip 顶层 {len(tops)} 个条目，无多余目录 +")
    return 0


if __name__ == "__main__":
    sys.exit(main())
