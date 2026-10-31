# -*- coding: utf-8 -*-
"""从字体提取花体字标的轮廓路径，存成 tools/lockup-changge.txt（给 make_icons.py 用）。

    python tools/dump_lockup.py                # 生成/更新缓存
    python tools/dump_lockup.py --print        # 只打印长度

为什么单独存一个 txt：
  Segoe Script Bold 的 "Changge" 轮廓有 8.8KB 的路径数据，塞进 make_icons.py 会把
  整个脚本淹掉；而每次出图标都去读系统字体又不可复现（字体版本一换字迹就变）。
  拿 txt 当「已转曲的素材」：make_icons.py 只读它，不依赖字体、不依赖 fontTools。
"""
from __future__ import annotations

import sys
from pathlib import Path

FONT = Path(r"C:\Windows\Fonts\segoescb.ttf")   # Segoe Script Bold
TEXT = "Changge"
TARGET_W = 452.0     # 字带宽度（512 画布，左右各留 30）
CY = 250.0           # 字带中心高度（比 256 略上，抵消 g 的下伸尾巴）
OUT = Path(__file__).resolve().parent / "lockup-changge.txt"


def build() -> str:
    from fontTools.misc.transform import Transform
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont

    if not FONT.exists():
        sys.exit(f"找不到字体：{FONT}（只有改字迹时才需要，平时读 txt 即可）")
    f = TTFont(str(FONT), lazy=True)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    hm = f["hmtx"]

    def advances() -> list[tuple[int, float]]:
        out = []
        x = 0.0
        for ch in TEXT:
            gn = cmap[ord(ch)]
            out.append((gn, x))
            x += hm[gn][0]
        return out

    # 先量整串的包围盒，才能算缩放和居中偏移
    bp = BoundsPen(gs)
    for gn, x in advances():
        gs[gn].draw(TransformPen(bp, Transform().translate(x, 0).scale(1, -1)))
    x0, y0, x1, y1 = bp.bounds
    s = TARGET_W / (x1 - x0)
    tx = 256.0 - (x0 + x1) / 2 * s
    ty = CY - (y0 + y1) / 2 * s

    # 坐标直接烘进 512 画布并取整：1 单位 = 0.2%，肉眼无差，路径长度少 40%
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.0f}")
    for gn, x in advances():
        gs[gn].draw(TransformPen(pen, Transform().translate(x * s + tx, ty).scale(s, -s)))
    d = pen.getCommands()
    print(f"字形盒 {x1 - x0:.0f}×{y1 - y0:.0f}（font units） 缩放 {s:.5f}")
    print(f"落位后 {TARGET_W:.0f}×{(y1 - y0) * s:.0f}px，路径 {len(d):,} 字符")
    return d


def main() -> None:
    d = build()
    if "--print" in sys.argv:
        return
    OUT.write_text(d + "\n", encoding="utf-8")
    print(f"写出 {OUT}（{OUT.stat().st_size:,} B）")


if __name__ == "__main__":
    main()
