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
"""
import shutil
import sys
import zipfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
SITE = KIT / "chd-charge"
DIST = KIT / "dist-cloudflare"
ZIP = KIT / "dist-cloudflare.zip"
CF_EXTRA = KIT / "tools" / "cloudflare"   # _worker.js / _routes.json（可选）

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

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer-when-downgrade
"""


def _write_catalog(dest):
    """对外设备目录是构建产物：打包时由 gen_catalog.py 生成。

    目录只存在于产物里，改完 DEFAULT_DEVICES 直接打包即可。
    """
    sys.path.insert(0, str(KIT / "tools"))
    import gen_catalog
    data, text = gen_catalog.generate(dest)
    print("目录：catalog.json %d 个分区 / %d 台 / %d B"
          % (len(data["areas"]), data["total"], len(text.encode("utf-8"))))


def main():
    if not (SITE / "index.html").exists():
        print(f"x 找不到站点源目录：{SITE}", file=sys.stderr)
        return 2

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    kept, skipped = [], []
    for f in sorted(SITE.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(SITE)
        if rel.name in EXCLUDE_FILES or set(rel.parts) & EXCLUDE_DIRS:
            skipped.append(rel.as_posix())
            continue
        dst = DIST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
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
