#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从工作区 chd-charge/ 生成「可独立部署」的包。

    python tools/make_dist.py            # 重建 dist-chd-charge/ 和 dist-chd-charge.zip
    python tools/make_dist.py --no-zip   # 只重建目录

产物（都不进 git，见 .gitignore）：
    campus-pile-kit/dist-chd-charge/       32 个文件，可直接跑
    campus-pile-kit/dist-chd-charge.zip    ~1.5 MB，拷给别人用

和 chd-charge/ 的区别只有一样：多一个 `_README-部署说明.md`。
其余文件是**逐字节复制**，所以 dist 里的东西能跑 = 线上那份能跑。

部署说明的真源在 `docs/DEPLOY-GUIDE.md`，这里复制过去改名。
"""
import argparse
import shutil
import sys
import zipfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
SITE = KIT / "chd-charge"
DIST = KIT / "dist-chd-charge"
ZIP = KIT / "dist-chd-charge.zip"
GUIDE = KIT / "docs" / "DEPLOY-GUIDE.md"
GUIDE_NAME = "_README-部署说明.md"

# 不该进部署包的东西（样张、原型可以留，占不了多少；这些是纯垃圾）
SKIP = {"_host-v3b.html", "catalog.json"}   # catalog.json 是构建产物，打包时现生成


def write_catalog(dest):
    """对外设备目录：打包时由 gen_catalog.py 生成，不进版本库。"""
    sys.path.insert(0, str(KIT / "tools"))
    import gen_catalog
    data, text = gen_catalog.generate(dest)
    print("目录：catalog.json %d 个分区 / %d 台 / %d B"
          % (len(data["areas"]), data["total"], len(text.encode("utf-8"))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-zip", action="store_true")
    args = ap.parse_args()

    if not GUIDE.exists():
        print(f"✗ 找不到部署说明：{GUIDE}", file=sys.stderr)
        return 2

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    n = 0
    for f in sorted(SITE.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(SITE)
        if rel.as_posix() in SKIP:
            print(f"  跳过 {rel}")
            continue
        dst = DIST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dst)
        n += 1

    write_catalog(DIST / "catalog.json")
    shutil.copy2(GUIDE, DIST / GUIDE_NAME)

    raw = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"目录：{n} 个文件 + 说明 1 个 → {DIST}（{raw:,} B）")

    # 自检：几个「少了就跑不起来」的文件
    must = ["index.html", "map-amap.js", "map-data.js", "map-key.local.js",
            "sw.js", "serve_gzip.py", "catalog.json", GUIDE_NAME]
    missing = [m for m in must if not (DIST / m).exists()]
    if missing:
        print(f"✗ 缺关键文件：{missing}", file=sys.stderr)
        return 3
    print("自检：关键文件齐 ✓")

    if args.no_zip:
        return 0

    if ZIP.exists():
        ZIP.unlink()
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(DIST.rglob("*")):
            if f.is_file():
                z.write(f, Path("chd-charge") / f.relative_to(DIST))
    zsize = ZIP.stat().st_size
    print(f"压缩：{zsize:,} B（{zsize / raw:.0%}）→ {ZIP}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
